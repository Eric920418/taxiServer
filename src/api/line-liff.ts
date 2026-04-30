/**
 * line-liff.ts - LIFF 後端 API 路由
 *
 * 提供 LIFF 前端頁面所需的 API：建單、追蹤、取消、配置
 */

import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, queryMany } from '../db/connection';
import { getSmartDispatcherV2, OrderData } from '../services/SmartDispatcherV2';
import { getScheduledOrderService } from '../services/ScheduledOrderService';
import { getLineNotifier } from '../services/LineNotifier';
import { hualienAddressDB } from '../services/HualienAddressDB';
import { getSocketIO, driverSockets, driverLocations } from '../socket';
import pool from '../db/connection';

const router = Router();

// ========== LIFF Token 驗證 Middleware ==========

interface LiffRequest extends Request {
  lineUserId?: string;
  lineDisplayName?: string;
}

async function verifyLiffToken(req: LiffRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: '缺少認證 Token' });
    return;
  }

  const accessToken = authHeader.replace('Bearer ', '');

  try {
    // 驗證 LIFF access token
    const verifyRes = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${accessToken}`);
    const verifyData = await verifyRes.json() as any;

    if (verifyData.error) {
      res.status(401).json({ error: 'Token 無效或已過期' });
      return;
    }

    // 取得使用者 profile
    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profile = await profileRes.json() as any;

    if (!profile.userId) {
      res.status(401).json({ error: '無法取得使用者資訊' });
      return;
    }

    req.lineUserId = profile.userId;
    req.lineDisplayName = profile.displayName || 'LINE 用戶';
    next();
  } catch (error: any) {
    console.error('[LIFF Auth] Token 驗證失敗:', error.message);
    res.status(401).json({ error: '認證失敗' });
  }
}

// ========== 取得前端配置 ==========

/**
 * GET /api/line/liff/config
 * 回傳前端需要的配置（不需認證）
 */
router.get('/config', (req, res) => {
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    liffIdBooking: process.env.LIFF_ID_BOOKING || '',
    liffIdTracking: process.env.LIFF_ID_TRACKING || '',
    defaultCenter: { lat: 23.9871, lng: 121.6015 },
    defaultZoom: 15,
  });
});

// ========== 禁止上車區檢查 ==========

/**
 * GET /api/line/liff/check-pickup
 *
 * 給 LIFF booking.html 在地圖更新後檢查上車點是否落在禁止上車區。
 * 接受 lat+lng（地圖拖曳）或 address（搜尋字串）任一。
 * 公開無需 auth — 只回傳替代上車地標，無敏感資料。
 *
 * 回傳：
 *   { forbidden: false } 安全可上車
 *   { forbidden: true, matchedLandmark, alternatives:[{id,name,address,lat,lng}] }
 */
router.get('/check-pickup', (req, res) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const address = (req.query.address as string || '').trim();

  let matchedName: string | null = null;

  // 1. 用座標反查（範圍 100 公尺）
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const nearby = hualienAddressDB.findNearbyForbidden(lat, lng, 100);
    if (nearby) matchedName = nearby.name;
  }

  // 2. 沒命中再用地址字串查
  if (!matchedName && address) {
    const dbResult = hualienAddressDB.lookup(address);
    if (dbResult?.entry.isForbiddenPickup) {
      matchedName = dbResult.entry.name;
    }
  }

  if (!matchedName) {
    res.json({ forbidden: false });
    return;
  }

  const alts = hualienAddressDB.getForbiddenAlternatives(matchedName);
  if (alts.length === 0) {
    res.json({ forbidden: false });
    return;
  }

  res.json({
    forbidden: true,
    matchedLandmark: matchedName,
    alternatives: alts.map(a => ({
      id: a.id!,
      name: a.name,
      address: a.address,
      lat: a.lat as number,
      lng: a.lng as number,
    })),
  });
});

// ========== 建立訂單 ==========

/**
 * POST /api/line/liff/create-order
 * 從 LIFF 地圖頁面建立訂單
 */
// LIFF 允許的付款 / 補貼組合
const ALLOWED_PAYMENT_TYPES = ['CASH', 'LOVE_CARD_PHYSICAL', 'OTHER'];
const ALLOWED_SUBSIDY_TYPES = ['NONE', 'SENIOR_CARD', 'LOVE_CARD'];
const MAX_NOTES_LENGTH = 200;

router.post('/create-order', verifyLiffToken, async (req: LiffRequest, res: Response) => {
  const userId = req.lineUserId!;
  const displayName = req.lineDisplayName!;
  const {
    pickupLat, pickupLng, pickupAddress,
    destLat, destLng, destAddress,
    mode, scheduledAt,
    paymentType: rawPaymentType,
    subsidyType: rawSubsidyType,
    notes: rawNotes,
  } = req.body;

  if (!pickupLat || !pickupLng) {
    res.status(400).json({ error: '缺少上車地點座標' });
    return;
  }

  // 驗證付款/補貼類型（白名單，防呆）
  const paymentType = ALLOWED_PAYMENT_TYPES.includes(rawPaymentType) ? rawPaymentType : 'CASH';
  const subsidyType = ALLOWED_SUBSIDY_TYPES.includes(rawSubsidyType) ? rawSubsidyType : 'NONE';
  const notes = typeof rawNotes === 'string' && rawNotes.trim()
    ? rawNotes.trim().substring(0, MAX_NOTES_LENGTH)
    : null;

  // 段數正規化：1段→一段
  const normalizedPickupAddress = pickupAddress ? hualienAddressDB.cleanupDisplay(pickupAddress) : pickupAddress;
  const normalizedDestAddress = destAddress ? hualienAddressDB.cleanupDisplay(destAddress) : destAddress;

  try {
    // 確保 LINE 使用者和乘客記錄存在
    const passengerId = `LINE_${userId.substring(0, 10)}`;
    const phone = `LINE_${userId.substring(0, 15)}`;

    await pool.query(`
      INSERT INTO passengers (passenger_id, name, phone)
      VALUES ($1, $2, $3)
      ON CONFLICT (phone) DO UPDATE SET
        name = EXCLUDED.name,
        updated_at = CURRENT_TIMESTAMP
      RETURNING passenger_id
    `, [passengerId, displayName, phone]);

    await pool.query(`
      INSERT INTO line_users (line_user_id, passenger_id, display_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (line_user_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        updated_at = CURRENT_TIMESTAMP
    `, [userId, passengerId, displayName]);

    // 建立訂單
    const orderId = `ORD${Date.now()}`;
    const now = new Date();
    const isScheduled = mode === 'reserve' && scheduledAt;
    const status = isScheduled ? 'WAITING' : 'OFFERED';

    // 統一 INSERT（不再依 isScheduled 拼字串，改為欄位都一致，scheduled_at 可 null）
    await pool.query(`
      INSERT INTO orders (
        order_id, passenger_id, status,
        pickup_lat, pickup_lng, pickup_address,
        dest_lat, dest_lng, dest_address,
        payment_type, subsidy_type, notes,
        created_at, offered_at,
        hour_of_day, day_of_week,
        source, line_user_id, scheduled_at
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12,
        CURRENT_TIMESTAMP, $13,
        $14, $15,
        'LINE', $16, $17
      )
    `, [
      orderId, passengerId, status,
      pickupLat, pickupLng, normalizedPickupAddress || `${pickupLat}, ${pickupLng}`,
      destLat || null, destLng || null, normalizedDestAddress || null,
      paymentType, subsidyType, notes,
      isScheduled ? null : new Date(), // offered_at：預約單先 null，到時間才派單
      now.getHours(), now.getDay(),
      userId, isScheduled ? scheduledAt : null,
    ]);

    // 更新 LINE 使用者統計
    await pool.query(
      'UPDATE line_users SET total_orders = total_orders + 1, updated_at = CURRENT_TIMESTAMP WHERE line_user_id = $1',
      [userId]
    );

    if (isScheduled) {
      // 預約模式：加入 Bull Queue
      const scheduler = getScheduledOrderService();
      if (scheduler) {
        await scheduler.scheduleOrder(orderId, new Date(scheduledAt));
      }
      console.log(`[LIFF] 預約訂單 ${orderId} 已建立，排程: ${scheduledAt}`);
    } else {
      // 即時模式：觸發派單
      const dispatcher = getSmartDispatcherV2();
      const orderData: OrderData = {
        orderId,
        passengerId,
        passengerName: displayName,
        passengerPhone: '',
        pickup: { lat: pickupLat, lng: pickupLng, address: normalizedPickupAddress || '' },
        destination: destLat ? { lat: destLat, lng: destLng, address: normalizedDestAddress || '' } : null,
        paymentType: 'CASH',
        createdAt: Date.now(),
        source: 'LINE',
      };
      await dispatcher.startDispatch(orderData);
      console.log(`[LIFF] 訂單 ${orderId} 已派單`);
    }

    // 推播「訂單已建立，正在媒合司機」到聊天室
    // 目的：讓使用者關掉 LIFF 回到聊天室時看到系統在運作
    const lineNotifier = getLineNotifier();
    if (lineNotifier) {
      lineNotifier.notifyOrderCreated(orderId)
        .catch(err => console.error('[LIFF] 訂單建立推播失敗:', err));
    }

    res.json({
      success: true,
      orderId,
      mode: isScheduled ? 'reserve' : 'call',
      message: isScheduled ? '預約成功' : '叫車成功，正在尋找司機',
    });

  } catch (error: any) {
    console.error('[LIFF] 建單失敗:', error);
    res.status(500).json({ error: `建單失敗：${error.message}` });
  }
});

// ========== 取得進行中的訂單 ==========

/**
 * GET /api/line/liff/active-order
 * 取得使用者最近的進行中訂單
 */
router.get('/active-order', verifyLiffToken, async (req: LiffRequest, res: Response) => {
  const userId = req.lineUserId!;

  try {
    const order = await queryOne(`
      SELECT o.*,
             d.name as driver_name, d.phone as driver_phone, d.plate as driver_plate,
             d.current_lat as driver_lat, d.current_lng as driver_lng
      FROM orders o
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      WHERE o.line_user_id = $1
        AND o.status IN ('WAITING', 'OFFERED', 'ACCEPTED', 'ARRIVED', 'ON_TRIP', 'SCHEDULED')
        AND o.created_at > NOW() - INTERVAL '4 hours'
      ORDER BY o.created_at DESC
      LIMIT 1
    `, [userId]);

    if (!order) {
      res.json({ hasOrder: false });
      return;
    }

    // 取得即時司機位置
    let driverLocation = null;
    if (order.driver_id) {
      const loc = driverLocations.get(order.driver_id);
      if (loc) {
        driverLocation = { lat: loc.lat, lng: loc.lng, speed: loc.speed, bearing: loc.bearing };
      } else if (order.driver_lat && order.driver_lng) {
        driverLocation = { lat: parseFloat(order.driver_lat), lng: parseFloat(order.driver_lng) };
      }
    }

    res.json({
      hasOrder: true,
      order: {
        orderId: order.order_id,
        status: order.status,
        pickup: {
          lat: parseFloat(order.pickup_lat),
          lng: parseFloat(order.pickup_lng),
          address: order.pickup_address,
        },
        destination: order.dest_lat ? {
          lat: parseFloat(order.dest_lat),
          lng: parseFloat(order.dest_lng),
          address: order.dest_address,
        } : null,
        driver: order.driver_id ? {
          name: order.driver_name,
          phone: order.driver_phone,
          plate: order.driver_plate,
          location: driverLocation,
        } : null,
        scheduledAt: order.scheduled_at,
        createdAt: order.created_at,
        acceptedAt: order.accepted_at,
      },
    });
  } catch (error: any) {
    console.error('[LIFF] 查詢訂單失敗:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ========== 訂單狀態（追蹤用） ==========

/**
 * GET /api/line/liff/order-status/:orderId
 * 取得訂單狀態和司機即時位置（追蹤頁面輪詢用）
 */
router.get('/order-status/:orderId', verifyLiffToken, async (req: LiffRequest, res: Response) => {
  const { orderId } = req.params;
  const userId = req.lineUserId!;

  try {
    const order = await queryOne(`
      SELECT o.order_id, o.status, o.driver_id,
             o.pickup_lat, o.pickup_lng, o.pickup_address,
             o.dest_lat, o.dest_lng, o.dest_address,
             o.meter_amount, o.scheduled_at,
             o.created_at, o.accepted_at, o.completed_at,
             d.name as driver_name, d.phone as driver_phone, d.plate as driver_plate
      FROM orders o
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      WHERE o.order_id = $1 AND o.line_user_id = $2
    `, [orderId, userId]);

    if (!order) {
      res.status(404).json({ error: '訂單不存在' });
      return;
    }

    // 即時司機位置
    let driverLocation = null;
    if (order.driver_id) {
      const loc = driverLocations.get(order.driver_id);
      if (loc) {
        driverLocation = { lat: loc.lat, lng: loc.lng, speed: loc.speed, bearing: loc.bearing };
      }
    }

    res.json({
      orderId: order.order_id,
      status: order.status,
      pickup: {
        lat: parseFloat(order.pickup_lat),
        lng: parseFloat(order.pickup_lng),
        address: order.pickup_address,
      },
      destination: order.dest_lat ? {
        lat: parseFloat(order.dest_lat),
        lng: parseFloat(order.dest_lng),
        address: order.dest_address,
      } : null,
      driver: order.driver_id ? {
        name: order.driver_name,
        plate: order.driver_plate,
        location: driverLocation,
      } : null,
      fare: order.meter_amount || null,
      createdAt: order.created_at,
      acceptedAt: order.accepted_at,
      completedAt: order.completed_at,
    });
  } catch (error: any) {
    console.error('[LIFF] 查詢訂單狀態失敗:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ========== 取消訂單 ==========

/**
 * POST /api/line/liff/cancel-order/:orderId
 */
router.post('/cancel-order/:orderId', verifyLiffToken, async (req: LiffRequest, res: Response) => {
  const { orderId } = req.params;
  const userId = req.lineUserId!;

  try {
    const result = await pool.query(`
      UPDATE orders
      SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP
      WHERE order_id = $1
        AND line_user_id = $2
        AND status IN ('WAITING', 'OFFERED', 'ACCEPTED', 'SCHEDULED')
      RETURNING driver_id, scheduled_at
    `, [orderId, userId]);

    if (result.rowCount === 0) {
      res.status(400).json({ error: '訂單無法取消（可能已在行程中或已完成）' });
      return;
    }

    const { driver_id, scheduled_at } = result.rows[0];

    // 取消 Bull Queue 預約
    if (scheduled_at) {
      const scheduler = getScheduledOrderService();
      if (scheduler) {
        scheduler.cancelScheduled(orderId).catch(err => console.error('[LIFF] 取消排程失敗:', err));
      }
    }

    // 通知司機
    if (driver_id) {
      const io = getSocketIO();
      const socketId = driverSockets.get(driver_id);
      if (socketId) {
        io.to(socketId).emit('order:status', {
          orderId,
          status: 'CANCELLED',
          message: 'LINE 乘客取消訂單',
        });
      }
    }

    console.log(`[LIFF] 訂單 ${orderId} 已取消`);
    res.json({ success: true, message: '訂單已取消' });

  } catch (error: any) {
    console.error('[LIFF] 取消訂單失敗:', error);
    res.status(500).json({ error: `取消失敗：${error.message}` });
  }
});

export default router;

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

// ========== 建立訂單 ==========

/**
 * POST /api/line/liff/create-order
 * 從 LIFF 地圖頁面建立訂單
 */
router.post('/create-order', verifyLiffToken, async (req: LiffRequest, res: Response) => {
  const userId = req.lineUserId!;
  const displayName = req.lineDisplayName!;
  const {
    pickupLat, pickupLng, pickupAddress,
    destLat, destLng, destAddress,
    mode, scheduledAt,
  } = req.body;

  if (!pickupLat || !pickupLng) {
    res.status(400).json({ error: '缺少上車地點座標' });
    return;
  }

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

    await pool.query(`
      INSERT INTO orders (
        order_id, passenger_id, status,
        pickup_lat, pickup_lng, pickup_address,
        dest_lat, dest_lng, dest_address,
        payment_type,
        created_at, ${isScheduled ? '' : 'offered_at,'}
        hour_of_day, day_of_week,
        source, line_user_id
        ${isScheduled ? ', scheduled_at' : ''}
      ) VALUES (
        $1, $2, ${isScheduled ? "'WAITING'" : "'OFFERED'"},
        $3, $4, $5,
        $6, $7, $8,
        'CASH',
        CURRENT_TIMESTAMP, ${isScheduled ? '' : 'CURRENT_TIMESTAMP,'}
        $9, $10,
        'LINE', $11
        ${isScheduled ? ', $12' : ''}
      )
    `, [
      orderId, passengerId,
      pickupLat, pickupLng, normalizedPickupAddress || `${pickupLat}, ${pickupLng}`,
      destLat || null, destLng || null, normalizedDestAddress || null,
      now.getHours(), now.getDay(),
      userId,
      ...(isScheduled ? [scheduledAt] : []),
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

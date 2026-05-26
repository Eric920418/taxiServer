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
import { hualienAddressDB, isWithinHualienBounds } from '../services/HualienAddressDB';
import { getSocketIO, driverSockets, driverLocations } from '../socket';
import { getETAService } from '../services/ETAService';
import { getFcmService } from '../services/FcmService';
import { fareConfigService } from '../services/FareConfigService';
import pool from '../db/connection';

const router = Router();

// ========== LIFF Token 驗證 Middleware ==========

interface LiffRequest extends Request {
  lineUserId?: string;
  lineDisplayName?: string;
  lineChannelId?: string;
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

    // 取得 access token 所屬的 LINE channel_id (用於 partner mapping)
    // GET /v2/oauth/verify 回傳 { client_id: "channel_id", expires_in, scope }
    try {
      const verifyRes = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`);
      if (verifyRes.ok) {
        const verifyData = await verifyRes.json() as { client_id?: string };
        if (verifyData.client_id) req.lineChannelId = verifyData.client_id;
      }
    } catch (e) {
      // verify 失敗不擋登入，僅 preferred_fleet mapping 不會生效
    }
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
    discountAmount: rawDiscountAmount,
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

  // 派單優先度（discountAmount）— LIFF 客人選的折扣 NT$ 元，0/10/20/30/40 5 段制
  // 範圍 0-40 元，未傳或非法則用 DB DEFAULT (0)
  let discountAmountValue: number | null = null;
  if (rawDiscountAmount !== undefined && rawDiscountAmount !== null) {
    const n = parseInt(String(rawDiscountAmount), 10);
    if (!isNaN(n) && n >= 0 && n <= 40) discountAmountValue = n;
  }

  // 從 LIFF channelId → preferred_fleet_partner_id mapping（LINE 官方綁特定車隊）
  // 例如：GoGoCha 花蓮-大豐 channel → partner_dafeng
  let preferredFleetPartnerId: string | null = null;
  try {
    const mapJson = process.env.LINE_CHANNEL_TO_PARTNER_MAP || '{}';
    const map: Record<string, string> = JSON.parse(mapJson);
    if (req.lineChannelId && map[req.lineChannelId]) {
      preferredFleetPartnerId = map[req.lineChannelId];
      // 若有 preferred fleet + 客人沒主動指定折扣 → 用 partner 預設值
      if (discountAmountValue === null) {
        const partnerRes = await pool.query<{ default_order_discount_amount: number | null }>(
          'SELECT default_order_discount_amount FROM partners WHERE partner_id = $1 AND is_active = true',
          [preferredFleetPartnerId]
        );
        if (partnerRes.rows[0]?.default_order_discount_amount != null) {
          discountAmountValue = Number(partnerRes.rows[0].default_order_discount_amount);
        }
      }
    }
  } catch (e: any) {
    console.error('[LIFF] LINE_CHANNEL_TO_PARTNER_MAP 解析失敗:', e.message);
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
    const status = isScheduled ? 'WAITING' : 'OFFERED';

    // 預估車資（即時模式且有下車點才算；用 Google Directions 道路距離 + 花蓮費率）
    let estimatedFare: number | null = null;
    if (!isScheduled && destLat && destLng) {
      try {
        const etaSvc = getETAService();
        const result = await etaSvc.getETA(
          { lat: pickupLat, lng: pickupLng },
          { lat: destLat, lng: destLng }
        );
        const fareResult = fareConfigService.calculateFare(result.distanceMeters);
        estimatedFare = fareResult.totalFare;
        console.log(`[LIFF] 預估車資 ${estimatedFare} 元 (距離 ${result.distanceMeters}m, 來源 ${result.source})`);
      } catch (err) {
        console.error('[LIFF] 預估車資計算失敗:', err);
      }
    }

    // 統一 INSERT（不再依 isScheduled 拼字串，改為欄位都一致，scheduled_at 可 null）
    await pool.query(`
      INSERT INTO orders (
        order_id, passenger_id, status,
        pickup_lat, pickup_lng, pickup_address,
        dest_lat, dest_lng, dest_address,
        payment_type, subsidy_type, notes,
        created_at, offered_at,
        hour_of_day, day_of_week,
        source, line_user_id, scheduled_at,
        estimated_fare
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12,
        CURRENT_TIMESTAMP, $13,
        $14, $15,
        'LINE', $16, $17,
        $18
      )
    `, [
      orderId, passengerId, status,
      pickupLat, pickupLng, normalizedPickupAddress || `${pickupLat}, ${pickupLng}`,
      destLat || null, destLng || null, normalizedDestAddress || null,
      paymentType, subsidyType, notes,
      isScheduled ? null : new Date(), // offered_at：預約單先 null，到時間才派單
      now.getHours(), now.getDay(),
      userId, isScheduled ? scheduledAt : null,
      estimatedFare,
    ]);

    // 客人指定 discountAmount 或 partner 預設 → 寫入 orders.discount_amount + preferred_fleet
    if (discountAmountValue !== null || preferredFleetPartnerId !== null) {
      const sets: string[] = [];
      const params: any[] = [];
      if (discountAmountValue !== null) {
        params.push(discountAmountValue);
        sets.push(`discount_amount = $${params.length}`);
      }
      if (preferredFleetPartnerId !== null) {
        params.push(preferredFleetPartnerId);
        sets.push(`preferred_fleet_partner_id = $${params.length}`);
      }
      params.push(orderId);
      await pool.query(
        `UPDATE orders SET ${sets.join(', ')} WHERE order_id = $${params.length}`,
        params
      );
      console.log(`[LIFF] 訂單 ${orderId} discount_amount=${discountAmountValue ?? '(default)'}, preferred_fleet=${preferredFleetPartnerId ?? 'none'}`);
    }

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
        discountAmount: discountAmountValue ?? 0,
        preferredFleetPartnerId: preferredFleetPartnerId,
        estimatedFare: estimatedFare ?? undefined,
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
      // FCM 並行通知（背景時也能收到）
      const fcm = getFcmService();
      fcm?.sendOrderCancelledToDriver(driver_id, orderId, 'LINE 乘客取消訂單')
        .catch((e: Error) => console.error('[FCM] cancel 推播失敗:', e.message));
    }

    console.log(`[LIFF] 訂單 ${orderId} 已取消`);
    res.json({ success: true, message: '訂單已取消' });

  } catch (error: any) {
    console.error('[LIFF] 取消訂單失敗:', error);
    res.status(500).json({ error: `取消失敗：${error.message}` });
  }
});

/**
 * PATCH /api/line/liff/relocate-order/:orderId
 * 客人在 LIFF relocate.html 重新選位置後寫回 DB + 通知司機
 *
 * Body:
 *   - lat, lng, address: 新上車點（必填）
 *   - phone?: 選填台灣手機號（10 位數字 09xx-xxx-xxx），用來補既有 LINE_xxx placeholder
 *
 * 條件：
 *   - 訂單必須屬於該 LIFF user (line_user_id 比對)
 *   - 訂單狀態必須在 WAITING / OFFERED / ACCEPTED / ARRIVED
 *   - 座標必須在花蓮縣範圍
 *
 * 副作用：
 *   - UPDATE orders.pickup_lat/lng/address
 *   - 若 phone 合法且 passengers.phone 仍是 LINE_ placeholder：覆蓋寫入 + 同步 orders.customer_phone
 *   - Socket emit `order:pickup_updated` 給接單司機
 */
router.patch('/relocate-order/:orderId', verifyLiffToken, async (req: LiffRequest, res: Response) => {
  const { orderId } = req.params;
  const userId = req.lineUserId!;
  const { lat, lng, address, phone } = req.body || {};

  if (typeof lat !== 'number' || typeof lng !== 'number' || !address || typeof address !== 'string') {
    res.status(400).json({ error: '缺少 lat/lng/address 或型別錯誤' });
    return;
  }
  if (!isWithinHualienBounds(lat, lng)) {
    res.status(400).json({ error: '座標不在花蓮縣範圍內' });
    return;
  }

  try {
    const order = await queryOne(
      'SELECT order_id, status, driver_id, passenger_id FROM orders WHERE order_id = $1 AND line_user_id = $2',
      [orderId, userId]
    );
    if (!order) {
      res.status(404).json({ error: '訂單不存在或不屬於您' });
      return;
    }
    if (!['WAITING', 'OFFERED', 'ACCEPTED', 'ARRIVED'].includes(order.status)) {
      res.status(400).json({ error: `訂單狀態 (${order.status}) 不允許更新位置` });
      return;
    }

    const trimmedAddress = address.trim().substring(0, 100);

    await pool.query(
      `UPDATE orders SET pickup_lat = $1, pickup_lng = $2, pickup_address = $3, updated_at = CURRENT_TIMESTAMP WHERE order_id = $4`,
      [lat, lng, trimmedAddress, orderId]
    );

    // 補手機（選填）— 只在 passengers.phone 還是 LINE_ placeholder 時覆蓋
    let phoneSaved = false;
    if (typeof phone === 'string') {
      const cleaned = phone.replace(/\D/g, '');
      const isValidTwMobile = /^09\d{8}$/.test(cleaned);
      if (isValidTwMobile && order.passenger_id) {
        const phoneUpd = await pool.query(
          `UPDATE passengers SET phone = $1, updated_at = CURRENT_TIMESTAMP
           WHERE passenger_id = $2 AND phone LIKE 'LINE\\_%' ESCAPE '\\'
           RETURNING phone`,
          [cleaned, order.passenger_id]
        );
        if (phoneUpd.rowCount && phoneUpd.rowCount > 0) {
          await pool.query(
            `UPDATE orders SET customer_phone = $1 WHERE order_id = $2`,
            [cleaned, orderId]
          );
          phoneSaved = true;
        }
      }
    }

    // 通知司機（若已有指派）
    if (order.driver_id) {
      const io = getSocketIO();
      const socketId = driverSockets.get(order.driver_id);
      if (socketId) {
        io.to(socketId).emit('order:pickup_updated', {
          orderId,
          pickupLat: lat,
          pickupLng: lng,
          pickupAddress: trimmedAddress,
        });
        console.log(`[LIFF] order:pickup_updated → driver ${order.driver_id} (${orderId})`);
      }
    }

    res.json({
      success: true,
      message: '位置已更新',
      phoneSaved,
      pickup: { lat, lng, address: trimmedAddress },
    });
  } catch (error: any) {
    console.error('[LIFF] 更新位置失敗:', error);
    res.status(500).json({ error: `更新失敗：${error.message}` });
  }
});

// ===========================================================================
// 長輩 LINE 一鍵叫車 — 模組 1 of「長輩 LINE 叫車 roadmap」
// ===========================================================================

const PICKUP_MATCH_RADIUS_M = 200; // GPS 距常用地點 < 200m → 自動 snap

/** Haversine 大圓距離（公尺） */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 確保 passenger + line_users 紀錄存在，回 passenger_id（同 create-order 的 convention） */
async function ensurePassengerForLineUser(userId: string, displayName: string): Promise<string> {
  const passengerId = `LINE_${userId.substring(0, 10)}`;
  const phone = `LINE_${userId.substring(0, 15)}`;
  await pool.query(
    `INSERT INTO passengers (passenger_id, name, phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, updated_at = CURRENT_TIMESTAMP`,
    [passengerId, displayName, phone]
  );
  await pool.query(
    `INSERT INTO line_users (line_user_id, passenger_id, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (line_user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = CURRENT_TIMESTAMP`,
    [userId, passengerId, displayName]
  );
  return passengerId;
}

/**
 * GET /api/line/liff/my-addresses
 * 取得長輩自己的常用地點列表（按 use_count DESC）
 */
router.get('/my-addresses', verifyLiffToken, async (req: LiffRequest, res: Response) => {
  const userId = req.lineUserId!;
  const displayName = req.lineDisplayName || 'LINE 用戶';
  try {
    const passengerId = await ensurePassengerForLineUser(userId, displayName);
    const rows = await queryMany(
      `SELECT id, label, display_name, address, lat, lng, use_count, is_home, created_at
       FROM passenger_saved_addresses
       WHERE passenger_id = $1
       ORDER BY is_home DESC, use_count DESC, created_at ASC`,
      [passengerId]
    );
    const addresses = rows.map((r: any) => ({
      id: r.id,
      label: r.label,
      displayName: r.display_name,
      address: r.address,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lng),
      useCount: r.use_count,
      isHome: r.is_home,
      createdAt: r.created_at,
    }));
    res.json({ addresses });
  } catch (error: any) {
    console.error('[LIFF] 取常用地點失敗:', error);
    res.status(500).json({ error: `取常用地點失敗：${error.message}` });
  }
});

/**
 * POST /api/line/liff/my-addresses
 * 新增 / 更新常用地點（有帶 id → UPDATE、沒帶 → INSERT）
 * is_home=true 時自動把其他地點的 is_home 設 false（partial unique index 強制 per passenger 只 1 個）
 *
 * Body: { id?, label, displayName, address, lat, lng, isHome? }
 */
router.post('/my-addresses', verifyLiffToken, async (req: LiffRequest, res: Response) => {
  const userId = req.lineUserId!;
  const displayName = req.lineDisplayName || 'LINE 用戶';
  const { id, label, displayName: addrName, address, lat, lng, isHome } = req.body || {};

  if (!label || !addrName || !address || lat == null || lng == null) {
    res.status(400).json({ error: '缺少必要欄位（label / displayName / address / lat / lng）' });
    return;
  }
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    res.status(400).json({ error: 'lat/lng 必須是數字' });
    return;
  }

  const client = await pool.connect();
  try {
    const passengerId = await ensurePassengerForLineUser(userId, displayName);
    await client.query('BEGIN');

    // is_home=true → 先解除其他地點的 is_home（partial unique index 保護）
    if (isHome) {
      await client.query(
        `UPDATE passenger_saved_addresses SET is_home = FALSE
         WHERE passenger_id = $1 AND ($2::INTEGER IS NULL OR id != $2)`,
        [passengerId, id ?? null]
      );
    }

    let result;
    if (id) {
      // UPDATE — 驗 ownership
      result = await client.query(
        `UPDATE passenger_saved_addresses
         SET label = $1, display_name = $2, address = $3, lat = $4, lng = $5, is_home = $6
         WHERE id = $7 AND passenger_id = $8
         RETURNING id, label, display_name, address, lat, lng, use_count, is_home`,
        [label, addrName, address, lat, lng, !!isHome, id, passengerId]
      );
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: '找不到此地點或無權限' });
        return;
      }
    } else {
      result = await client.query(
        `INSERT INTO passenger_saved_addresses
         (passenger_id, label, display_name, address, lat, lng, is_home)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, label, display_name, address, lat, lng, use_count, is_home`,
        [passengerId, label, addrName, address, lat, lng, !!isHome]
      );
    }
    await client.query('COMMIT');

    const r = result.rows[0];
    res.json({
      success: true,
      address: {
        id: r.id,
        label: r.label,
        displayName: r.display_name,
        address: r.address,
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lng),
        useCount: r.use_count,
        isHome: r.is_home,
      },
    });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[LIFF] 儲存常用地點失敗:', error);
    res.status(500).json({ error: `儲存失敗：${error.message}` });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/line/liff/my-addresses/:id
 */
router.delete('/my-addresses/:id', verifyLiffToken, async (req: LiffRequest, res: Response) => {
  const userId = req.lineUserId!;
  const displayName = req.lineDisplayName || 'LINE 用戶';
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'id 必須是數字' });
    return;
  }
  try {
    const passengerId = await ensurePassengerForLineUser(userId, displayName);
    const result = await pool.query(
      `DELETE FROM passenger_saved_addresses WHERE id = $1 AND passenger_id = $2`,
      [id, passengerId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: '找不到此地點或無權限' });
      return;
    }
    res.json({ success: true });
  } catch (error: any) {
    console.error('[LIFF] 刪除常用地點失敗:', error);
    res.status(500).json({ error: `刪除失敗：${error.message}` });
  }
});

/**
 * POST /api/line/liff/one-click-suggest
 * 「長輩 LINE 一鍵叫車」核心：GPS 上車點 → 推 pickup + destination 建議
 *
 * 邏輯（依 user 2026-05-26 決策「GPS 最近的『其他』常用點」）：
 *   1. 0 個 saved address → 'NO_ADDRESSES'，UI 引導去新增
 *   2. 1 個 saved address：
 *      - GPS 在它附近（<200m） → 'AT_FAVORITE'，UI 引導去設第二個常用點
 *      - 不在它附近 → pickup=GPS, destination=該地點
 *   3. ≥2 個 saved address：
 *      - 找 GPS 最近的 X：
 *          X 距離 < 200m → pickup = X（snap 到 favorite 更精確）
 *          否則 → pickup = GPS
 *      - destination = 剩下地點裡 use_count 最高者
 *      - 邊界：若所有地點都靠近 GPS（罕見） → 取「次近」當 destination
 *
 * Body: { pickupLat, pickupLng, pickupAddress }
 */
router.post('/one-click-suggest', verifyLiffToken, async (req: LiffRequest, res: Response) => {
  const userId = req.lineUserId!;
  const displayName = req.lineDisplayName || 'LINE 用戶';
  const { pickupLat, pickupLng, pickupAddress } = req.body || {};

  if (typeof pickupLat !== 'number' || typeof pickupLng !== 'number') {
    res.status(400).json({ error: 'pickupLat/pickupLng 必須是數字（GPS 經緯度）' });
    return;
  }

  try {
    const passengerId = await ensurePassengerForLineUser(userId, displayName);
    const addresses: any[] = await queryMany(
      `SELECT id, label, display_name, address, lat, lng, use_count, is_home
       FROM passenger_saved_addresses
       WHERE passenger_id = $1
       ORDER BY use_count DESC, created_at ASC`,
      [passengerId]
    );

    if (addresses.length === 0) {
      res.json({
        status: 'NO_ADDRESSES',
        message: '請先到「我的常用地點」新增 1-3 個常去的地方（家、醫院、市場）',
      });
      return;
    }

    // 計算每個地點距 GPS 的距離
    const withDist = addresses.map((a: any) => ({
      ...a,
      lat: parseFloat(a.lat),
      lng: parseFloat(a.lng),
      distM: haversineMeters(pickupLat, pickupLng, parseFloat(a.lat), parseFloat(a.lng)),
    }));
    withDist.sort((a, b) => a.distM - b.distM);
    const nearest = withDist[0];
    const isNearAFavorite = nearest.distM < PICKUP_MATCH_RADIUS_M;

    // pickup：靠近 favorite → snap，否則用 GPS
    const pickup = isNearAFavorite
      ? {
          lat: nearest.lat,
          lng: nearest.lng,
          address: nearest.address,
          fromFavorite: true,
          favoriteName: nearest.display_name,
        }
      : {
          lat: pickupLat,
          lng: pickupLng,
          address: pickupAddress || '目前位置',
          fromFavorite: false,
        };

    // 只有 1 個 favorite
    if (addresses.length === 1) {
      if (isNearAFavorite) {
        res.json({
          status: 'AT_FAVORITE',
          favoriteName: nearest.display_name,
          message: `您現在在「${nearest.display_name}」附近，請新增第二個常用地點（例如：醫院、市場），一鍵叫車才能自動帶入目的地`,
        });
        return;
      }
      // 不在唯一 favorite 附近 → 它當目的地
      res.json({
        status: 'OK',
        pickup,
        destination: {
          id: nearest.id,
          label: nearest.label,
          displayName: nearest.display_name,
          address: nearest.address,
          lat: nearest.lat,
          lng: nearest.lng,
        },
      });
      return;
    }

    // ≥2 個 favorite：destination = 排除 pickup 的最常去者
    // 如果 pickup 是從 favorite snap 的、就排掉它；否則排第 0（最近）避免目的地跟 pickup 相同
    const excludeId = isNearAFavorite ? nearest.id : null;
    const candidates = withDist
      .filter(a => excludeId == null || a.id !== excludeId)
      .sort((a, b) => b.use_count - a.use_count);

    if (candidates.length === 0) {
      // 罕見：全部地點都在 200m 內、唯一候選還被排除
      res.json({
        status: 'AT_FAVORITE',
        favoriteName: nearest.display_name,
        message: '附近的常用地點都太近，請選擇目的地或新增新地點',
      });
      return;
    }
    const dest = candidates[0];
    res.json({
      status: 'OK',
      pickup,
      destination: {
        id: dest.id,
        label: dest.label,
        displayName: dest.display_name,
        address: dest.address,
        lat: dest.lat,
        lng: dest.lng,
      },
    });
  } catch (error: any) {
    console.error('[LIFF] one-click-suggest 失敗:', error);
    res.status(500).json({ error: `一鍵叫車建議失敗：${error.message}` });
  }
});

/**
 * POST /api/line/liff/saved-address/:id/increment-use
 * destination 被選用後 client 呼叫此 endpoint +1 use_count（給排序用）
 * 設計成獨立 endpoint 而非塞進 create-order 內，因為 create-order 收的是 address string、不知道是哪筆 saved address
 */
router.post('/saved-address/:id/increment-use', verifyLiffToken, async (req: LiffRequest, res: Response) => {
  const userId = req.lineUserId!;
  const displayName = req.lineDisplayName || 'LINE 用戶';
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'id 必須是數字' });
    return;
  }
  try {
    const passengerId = await ensurePassengerForLineUser(userId, displayName);
    const result = await pool.query(
      `UPDATE passenger_saved_addresses
       SET use_count = use_count + 1
       WHERE id = $1 AND passenger_id = $2
       RETURNING use_count`,
      [id, passengerId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: '找不到此地點' });
      return;
    }
    res.json({ success: true, useCount: result.rows[0].use_count });
  } catch (error: any) {
    console.error('[LIFF] increment use_count 失敗:', error);
    res.status(500).json({ error: `使用次數更新失敗：${error.message}` });
  }
});

export default router;

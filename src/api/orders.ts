import { Router } from 'express';
import { query, queryOne, queryMany } from '../db/connection';
import { broadcastOrderToDrivers, notifyPassengerOrderUpdate } from '../socket';
import {
  registerOrder,
  handleDriverReject,
  handleDriverAccept,
  cancelOrderTracking,
  getOrderDispatchStatus,
  getAllActiveOrders
} from '../services/OrderDispatcher';
import { getSmartDispatcherV2 } from '../services/SmartDispatcherV2';
import { getNotificationService } from '../services/NotificationService';
import { getLineNotifier } from '../services/LineNotifier';
import { getCustomerNotificationService } from '../services/CustomerNotificationService';
import { fareConfigService } from '../services/FareConfigService';

// 有效的拒單原因（強制選擇）
const VALID_REJECTION_REASONS = [
  'TOO_FAR',           // 距離太遠
  'LOW_FARE',          // 車資太低
  'UNWANTED_AREA',     // 不想去該區域
  'OFF_DUTY',          // 準備下班
  'BUSY',              // 忙碌中
  'OTHER'              // 其他
] as const;

const router = Router();

/**
 * 取得目的地顯示地址：電話訂單優先用乘客原始說法（dropoff_original）
 */
function getDestAddress(order: any): string {
  return (order.source === 'PHONE' && order.dropoff_original) || order.dest_address;
}

/**
 * 測試用：建立新訂單（模擬乘客叫車）
 * POST /api/orders
 */
router.post('/', async (req, res) => {
  const {
    passengerName = '測試乘客',
    passengerPhone = '0900123456',
    pickupLat,
    pickupLng,
    pickupAddress,
    destLat,
    destLng,
    destAddress,
    paymentType = 'CASH'
  } = req.body;

  try {
    // 驗證必要欄位
    if (!pickupLat || !pickupLng || !pickupAddress) {
      return res.status(400).json({
        error: '缺少必要欄位：pickupLat, pickupLng, pickupAddress'
      });
    }

    // 建立或獲取測試乘客
    let passenger = await queryOne(
      'SELECT * FROM passengers WHERE phone = $1',
      [passengerPhone]
    );

    if (!passenger) {
      const passengerId = `P${Date.now().toString().slice(-6)}`;
      const result = await query(
        'INSERT INTO passengers (passenger_id, phone, name) VALUES ($1, $2, $3) RETURNING *',
        [passengerId, passengerPhone, passengerName]
      );
      passenger = result.rows[0];
    }

    // 建立訂單
    const orderId = `ORD${Date.now()}`;
    const now = new Date();

    const result = await query(`
      INSERT INTO orders (
        order_id, passenger_id, status,
        pickup_lat, pickup_lng, pickup_address,
        dest_lat, dest_lng, dest_address,
        payment_type,
        created_at, offered_at,
        hour_of_day, day_of_week
      ) VALUES (
        $1, $2, 'OFFERED',
        $3, $4, $5,
        $6, $7, $8,
        $9,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        $10, $11
      ) RETURNING *
    `, [
      orderId, passenger.passenger_id,
      pickupLat, pickupLng, pickupAddress,
      destLat || null, destLng || null, destAddress || null,
      paymentType,
      now.getHours(), now.getDay()
    ]);

    const order = result.rows[0];

    console.log(`[Order] 新訂單建立: ${orderId}`);

    // 使用 OrderDispatcher 管理訂單派發（包含自動超時、重新派單）
    const orderData = {
      orderId: order.order_id,
      passengerId: order.passenger_id,
      passengerName: passengerName,
      passengerPhone: passengerPhone,
      pickup: {
        lat: parseFloat(order.pickup_lat),
        lng: parseFloat(order.pickup_lng),
        address: order.pickup_address
      },
      destination: order.dest_lat ? {
        lat: parseFloat(order.dest_lat),
        lng: parseFloat(order.dest_lng),
        address: getDestAddress(order)
      } : null,
      status: 'OFFERED',
      paymentType: order.payment_type,
      createdAt: order.created_at.getTime()
    };

    // 註冊到派發管理器（會自動推送給所有司機、設置超時）
    const offeredTo = registerOrder(orderData);

    res.json({
      success: true,
      order: {
        orderId: order.order_id,
        passengerId: order.passenger_id,
        status: order.status,
        pickup: {
          lat: parseFloat(order.pickup_lat),
          lng: parseFloat(order.pickup_lng),
          address: order.pickup_address
        },
        destination: order.dest_lat ? {
          lat: parseFloat(order.dest_lat),
          lng: parseFloat(order.dest_lng),
          address: getDestAddress(order)
        } : null,
        paymentType: order.payment_type
      },
      offeredTo
    });
  } catch (error) {
    console.error('[Create Order] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 取得所有訂單（測試用）
 * GET /api/orders
 */
router.get('/', async (req, res) => {
  const { status, driverId, limit = 100, offset = 0 } = req.query;

  try {
    let sql = 'SELECT * FROM orders WHERE 1=1';
    const params: any[] = [];

    if (status) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }

    if (driverId) {
      params.push(driverId);
      sql += ` AND driver_id = $${params.length}`;
    }

    params.push(limit, offset);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const orders = await queryMany(sql, params);

    res.json({
      orders: orders.map(o => ({
        orderId: o.order_id,
        passengerId: o.passenger_id,
        driverId: o.driver_id,
        status: o.status,
        pickup: {
          lat: parseFloat(o.pickup_lat),
          lng: parseFloat(o.pickup_lng),
          address: o.pickup_address
        },
        destination: o.dest_lat ? {
          lat: parseFloat(o.dest_lat),
          lng: parseFloat(o.dest_lng),
          address: getDestAddress(o)
        } : null,
        paymentType: o.payment_type,
        meterAmount: o.meter_amount,
        createdAt: o.created_at,
        acceptedAt: o.accepted_at,
        completedAt: o.completed_at,
        // 電話叫車欄位
        source: o.source || 'APP',
        subsidyType: o.subsidy_type || 'NONE',
        subsidyConfirmed: o.subsidy_confirmed || false,
        subsidyAmount: o.subsidy_amount || 0,
        petPresent: o.pet_present || 'UNKNOWN',
        petCarrier: o.pet_carrier || 'UNKNOWN',
        customerPhone: o.customer_phone,
        destinationConfirmed: o.destination_confirmed || false
      })),
      total: orders.length
    });
  } catch (error) {
    console.error('[Get Orders] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * no-show 訂單清單（Admin Panel 用）
 * GET /api/orders/no-show?days=30&limit=100&offset=0
 *
 * ⚠ 必須定義在 GET /:orderId 之前，否則 Express 會把 'no-show' 當成 orderId
 *   參數匹配到下面的查單 endpoint（回 "訂單不存在" 而非真實資料）
 *
 * 回傳近 N 天內因客人未到而取消的訂單
 */
router.get('/no-show', async (req, res) => {
  const days = parseInt(req.query.days as string) || 30;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = parseInt(req.query.offset as string) || 0;

  try {
    const rows = await queryMany(`
      SELECT o.order_id, o.passenger_id, o.driver_id, o.pickup_address,
             o.cancelled_at, o.cancel_reason, o.penalty_fare, o.source,
             p.name AS passenger_name, p.phone AS passenger_phone,
             p.no_show_count AS passenger_no_show_total,
             d.name AS driver_name, d.plate AS driver_plate
      FROM orders o
      LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      WHERE o.cancel_reason LIKE '客人未到%'
        AND o.cancelled_at > NOW() - ($1::text || ' days')::interval
      ORDER BY o.cancelled_at DESC
      LIMIT $2 OFFSET $3
    `, [String(days), limit, offset]);

    const countRow = await queryOne(`
      SELECT COUNT(*)::text AS total FROM orders
      WHERE cancel_reason LIKE '客人未到%'
        AND cancelled_at > NOW() - ($1::text || ' days')::interval
    `, [String(days)]);

    res.json({
      total: parseInt(countRow?.total || '0'),
      orders: rows.map(r => ({
        orderId: r.order_id,
        passengerId: r.passenger_id,
        passengerName: r.passenger_name,
        passengerPhone: r.passenger_phone,
        passengerNoShowTotal: r.passenger_no_show_total ?? 0,
        driverId: r.driver_id,
        driverName: r.driver_name,
        driverPlate: r.driver_plate,
        pickupAddress: r.pickup_address,
        source: r.source || 'APP',
        cancelledAt: r.cancelled_at,
        cancelReason: r.cancel_reason,
        penaltyFare: r.penalty_fare || 0,
      })),
    });
  } catch (error) {
    console.error('[No-Show List] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 取得單一訂單
 * GET /api/orders/:orderId
 */
router.get('/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
    const order = await queryOne(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );

    if (!order) {
      return res.status(404).json({ error: '訂單不存在' });
    }

    res.json({
      orderId: order.order_id,
      passengerId: order.passenger_id,
      driverId: order.driver_id,
      status: order.status,
      pickup: {
        lat: parseFloat(order.pickup_lat),
        lng: parseFloat(order.pickup_lng),
        address: order.pickup_address
      },
      destination: order.dest_lat ? {
        lat: parseFloat(order.dest_lat),
        lng: parseFloat(order.dest_lng),
        address: getDestAddress(order)
      } : null,
      paymentType: order.payment_type,
      meterAmount: order.meter_amount,
      photoUrl: order.photo_url,
      createdAt: order.created_at,
      acceptedAt: order.accepted_at,
      arrivedAt: order.arrived_at,
      startedAt: order.started_at,
      completedAt: order.completed_at,
      // 電話叫車欄位
      source: order.source || 'APP',
      subsidyType: order.subsidy_type || 'NONE',
      subsidyConfirmed: order.subsidy_confirmed || false,
      subsidyAmount: order.subsidy_amount || 0,
      petPresent: order.pet_present || 'UNKNOWN',
      petCarrier: order.pet_carrier || 'UNKNOWN',
      petNote: order.pet_note,
      customerPhone: order.customer_phone,
      destinationConfirmed: order.destination_confirmed || false,
      callId: order.call_id
    });
  } catch (error) {
    console.error('[Get Order] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 司機接單
 * PATCH /api/orders/:orderId/accept
 */
router.patch('/:orderId/accept', async (req, res) => {
  const { orderId } = req.params;
  const { driverId, driverName } = req.body;

  try {
    // 檢查訂單是否存在且可接單
    const order = await queryOne(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );

    if (!order) {
      return res.status(404).json({ error: '訂單不存在' });
    }

    if (order.status !== 'WAITING' && order.status !== 'OFFERED') {
      return res.status(400).json({ error: `訂單狀態不允許接單：${order.status}` });
    }

    // 優先使用 SmartDispatcherV2 處理接單
    let accepted = false;
    try {
      const smartDispatcher = getSmartDispatcherV2();
      accepted = await smartDispatcher.handleDriverAccept(orderId, driverId);
    } catch (dispatcherError) {
      // 回退到舊的 OrderDispatcher
      console.log(`[Accept Order] SmartDispatcherV2 異常，回退傳統處理:`, dispatcherError);
      accepted = handleDriverAccept(orderId, driverId);
    }

    // SmartDispatcher 記憶體中沒有此訂單（伺服器重啟或電話訂單），
    // 但 DB 已確認訂單為 OFFERED/WAITING → 直接接單
    if (!accepted) {
      console.log(`[Accept Order] SmartDispatcher 無記憶體狀態（可能重啟），直接接單 (${order.status})`);
      accepted = true;
    }

    // 更新訂單狀態，AND status 限制防止雙重接單 race condition
    const result = await query(`
      UPDATE orders
      SET status = 'ACCEPTED',
          driver_id = $1,
          accepted_at = CURRENT_TIMESTAMP
      WHERE order_id = $2
        AND status IN ('OFFERED', 'WAITING')
      RETURNING *
    `, [driverId, orderId]);

    // 若無 row 代表剛被其他司機搶走
    if (!result.rows[0]) {
      return res.status(409).json({
        error: 'ORDER_ALREADY_TAKEN',
        message: '此訂單已被其他司機接走'
      });
    }

    const updatedOrder = result.rows[0];

    // 更新司機統計
    await query(
      'UPDATE drivers SET total_trips = total_trips + 1 WHERE driver_id = $1',
      [driverId]
    );

    console.log(`[Order] 訂單 ${orderId} 已被司機 ${driverName}(${driverId}) 接受`);

    // 查詢完整訂單資訊（包含乘客和司機資訊）
    const fullOrder = await queryOne(`
      SELECT o.*,
             p.name as passenger_name, p.phone as passenger_phone,
             d.name as driver_name, d.phone as driver_phone
      FROM orders o
      LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      WHERE o.order_id = $1
    `, [orderId]);

    // 透過 WebSocket 通知乘客訂單狀態更新
    const orderUpdate = {
      orderId: fullOrder.order_id,
      passengerId: fullOrder.passenger_id,
      passengerName: fullOrder.passenger_name,
      passengerPhone: fullOrder.passenger_phone,
      driverId: fullOrder.driver_id,
      driverName: fullOrder.driver_name || driverName,
      driverPhone: fullOrder.driver_phone,
      status: fullOrder.status,
      pickup: {
        lat: parseFloat(fullOrder.pickup_lat),
        lng: parseFloat(fullOrder.pickup_lng),
        address: fullOrder.pickup_address
      },
      destination: fullOrder.dest_lat ? {
        lat: parseFloat(fullOrder.dest_lat),
        lng: parseFloat(fullOrder.dest_lng),
        address: getDestAddress(fullOrder)
      } : null,
      paymentType: fullOrder.payment_type,
      createdAt: new Date(fullOrder.created_at).getTime(),
      acceptedAt: new Date(fullOrder.accepted_at).getTime()
    };

    const notified = notifyPassengerOrderUpdate(fullOrder.passenger_id, orderUpdate);
    if (notified) {
      console.log(`[Order] ✅ 已通知乘客 ${fullOrder.passenger_id} 訂單被接受`);
    } else {
      console.log(`[Order] ⚠️ 乘客 ${fullOrder.passenger_id} 不在線，無法即時通知`);
    }

    // 客人反向通知（LINE 優先、SMS 備援）
    // 若分派層未初始化或 flag=false 會自動 noop；否則寫 customer_notifications + 推播
    const cns = getCustomerNotificationService();
    if (cns) {
      cns.notifyDriverAccepted(orderId, {
        driverName: fullOrder.driver_name || driverName,
        plate: fullOrder.plate || '',
        etaMinutes: fullOrder.eta_to_pickup,
      }).catch((err: Error) => console.error('[Order] CustomerNotification 失敗:', err));
    } else {
      // 分派層未啟用時保留舊行為（LINE-only shortcut）
      const lineNotifier = getLineNotifier();
      if (lineNotifier) {
        lineNotifier.notifyOrderStatusChange(orderId, 'ACCEPTED', {
          driverName: fullOrder.driver_name || driverName,
          plate: fullOrder.plate || '',
        }).catch(err => console.error('[Order] LINE 推播失敗:', err));
      }
    }

    res.json({
      success: true,
      message: '接單成功',
      order: {
        orderId: fullOrder.order_id,
        passengerId: fullOrder.passenger_id,
        passengerName: fullOrder.passenger_name,
        passengerPhone: fullOrder.passenger_phone,
        driverId: fullOrder.driver_id,
        driverName: driverName,
        status: fullOrder.status,
        pickup: {
          lat: parseFloat(fullOrder.pickup_lat),
          lng: parseFloat(fullOrder.pickup_lng),
          address: fullOrder.pickup_address
        },
        destination: fullOrder.dest_lat ? {
          lat: parseFloat(fullOrder.dest_lat),
          lng: parseFloat(fullOrder.dest_lng),
          address: getDestAddress(fullOrder)
        } : null,
        paymentType: fullOrder.payment_type,
        // 電話/LINE 訂單欄位 — 司機端 Tag 顯示 + relocate 按鈕判定 source
        source: fullOrder.source || 'APP',
        subsidyType: fullOrder.subsidy_type || 'NONE',
        subsidyConfirmed: fullOrder.subsidy_confirmed || false,
        subsidyAmount: fullOrder.subsidy_amount || 0,
        petPresent: fullOrder.pet_present || 'UNKNOWN',
        petCarrier: fullOrder.pet_carrier || 'UNKNOWN',
        petNote: fullOrder.pet_note,
        customerPhone: fullOrder.customer_phone,
        notes: fullOrder.notes,
        createdAt: new Date(fullOrder.created_at).getTime(),
        acceptedAt: new Date(fullOrder.accepted_at).getTime()
      }
    });
  } catch (error) {
    console.error('[Accept Order] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 司機拒單
 * PATCH /api/orders/:orderId/reject
 *
 * 必填參數：
 * - driverId: 司機 ID
 * - rejectionReason: 拒單原因 (TOO_FAR/LOW_FARE/UNWANTED_AREA/OFF_DUTY/BUSY/OTHER)
 */
router.patch('/:orderId/reject', async (req, res) => {
  const { orderId } = req.params;
  const { driverId, rejectionReason, reason } = req.body;

  // 使用新的 rejectionReason 或舊的 reason（向後兼容）
  const finalReason = rejectionReason || reason || 'OTHER';

  try {
    // 驗證必填參數
    if (!driverId) {
      return res.status(400).json({
        error: 'MISSING_DRIVER_ID',
        message: '缺少司機 ID'
      });
    }

    // 驗證拒單原因（警告但不阻擋，為了向後兼容）
    if (!VALID_REJECTION_REASONS.includes(finalReason as any)) {
      console.log(`[Reject Order] 警告：無效的拒單原因 "${finalReason}"，將使用 "OTHER"`);
    }

    const order = await queryOne(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );

    if (!order) {
      return res.status(404).json({ error: '訂單不存在' });
    }

    console.log(`[Order] 訂單 ${orderId} 被司機 ${driverId} 拒絕，原因：${finalReason}`);

    // 優先使用 SmartDispatcherV2 處理拒單
    let result;
    try {
      const smartDispatcher = getSmartDispatcherV2();
      result = await smartDispatcher.handleDriverReject(orderId, driverId, finalReason);

      res.json({
        success: result.success,
        message: result.message,
        reDispatched: result.reDispatched,
        nextBatch: result.nextBatch,
        // 向後兼容
        reDispatchedTo: result.reDispatched ? [`batch_${result.nextBatch}`] : [],
        reDispatchedCount: result.reDispatched ? 1 : 0
      });
    } catch (dispatcherError) {
      // 回退到舊的 OrderDispatcher
      console.log(`[Reject Order] SmartDispatcherV2 失敗，回退到傳統處理:`, dispatcherError);
      result = await handleDriverReject(orderId, driverId, finalReason);

      res.json({
        success: result.success,
        message: result.message,
        reDispatchedTo: result.reDispatchedTo,
        reDispatchedCount: result.reDispatchedTo.length,
        // 新格式
        reDispatched: result.reDispatchedTo.length > 0,
        nextBatch: 0
      });
    }
  } catch (error) {
    console.error('[Reject Order] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 取得訂單派發狀態
 * GET /api/orders/:orderId/dispatch-status
 */
router.get('/:orderId/dispatch-status', (req, res) => {
  const { orderId } = req.params;

  const status = getOrderDispatchStatus(orderId);

  if (!status || !status.exists) {
    return res.json({
      exists: false,
      message: '訂單不在派發佇列中（可能已被接受或取消）'
    });
  }

  res.json(status);
});

/**
 * 取得所有活動訂單狀態（除錯用）
 * GET /api/orders/dispatch/active
 */
router.get('/dispatch/active', (req, res) => {
  const activeOrders = getAllActiveOrders();

  res.json({
    count: activeOrders.length,
    orders: activeOrders
  });
});

/**
 * 更新訂單狀態
 * PATCH /api/orders/:orderId/status
 */
router.patch('/:orderId/status', async (req, res) => {
  const { orderId } = req.params;
  const { status, driverId } = req.body;

  try {
    const order = await queryOne(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );

    if (!order) {
      return res.status(404).json({ error: '訂單不存在' });
    }

    const validStatuses = ['WAITING', 'OFFERED', 'ACCEPTED', 'ARRIVED', 'ON_TRIP', 'SETTLING', 'DONE', 'CANCELLED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: '無效的訂單狀態' });
    }

    // 根據不同狀態更新不同的時間欄位
    let updateFields = 'status = $1';
    const params: any[] = [status, orderId];

    if (status === 'ARRIVED') {
      updateFields += ', arrived_at = CURRENT_TIMESTAMP';
    } else if (status === 'ON_TRIP') {
      updateFields += ', started_at = CURRENT_TIMESTAMP';
    } else if (status === 'DONE') {
      updateFields += ', completed_at = CURRENT_TIMESTAMP';
    } else if (status === 'CANCELLED') {
      updateFields += ', cancelled_at = CURRENT_TIMESTAMP';
    }

    const result = await query(
      `UPDATE orders SET ${updateFields} WHERE order_id = $2 RETURNING *`,
      params
    );

    const updatedOrder = result.rows[0];

    console.log(`[Order] 訂單 ${orderId} 狀態更新為：${status}`);

    // 查詢完整訂單資訊（包含乘客和司機資訊）
    const fullOrder = await queryOne(`
      SELECT o.*, p.name as passenger_name, p.phone as passenger_phone,
             d.name as driver_name, d.phone as driver_phone
      FROM orders o
      LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      WHERE o.order_id = $1
    `, [orderId]);

    // 透過 WebSocket 通知乘客訂單狀態更新
    const orderUpdate = {
      orderId: fullOrder.order_id,
      passengerId: fullOrder.passenger_id,
      passengerName: fullOrder.passenger_name || '乘客',
      passengerPhone: fullOrder.passenger_phone,
      driverId: fullOrder.driver_id,
      driverName: fullOrder.driver_name,
      driverPhone: fullOrder.driver_phone,
      status: fullOrder.status,
      pickup: {
        lat: parseFloat(fullOrder.pickup_lat),
        lng: parseFloat(fullOrder.pickup_lng),
        address: fullOrder.pickup_address
      },
      destination: fullOrder.dest_lat ? {
        lat: parseFloat(fullOrder.dest_lat),
        lng: parseFloat(fullOrder.dest_lng),
        address: getDestAddress(fullOrder)
      } : null,
      paymentType: fullOrder.payment_type,
      fare: fullOrder.meter_amount ? {
        meterAmount: fullOrder.meter_amount,
        appDistanceMeters: fullOrder.actual_distance_km ? Math.round(fullOrder.actual_distance_km * 1000) : 0
      } : null,
      createdAt: new Date(fullOrder.created_at).getTime(),
      acceptedAt: fullOrder.accepted_at ? new Date(fullOrder.accepted_at).getTime() : null,
      arrivedAt: fullOrder.arrived_at ? new Date(fullOrder.arrived_at).getTime() : null,
      startedAt: fullOrder.started_at ? new Date(fullOrder.started_at).getTime() : null,
      completedAt: fullOrder.completed_at ? new Date(fullOrder.completed_at).getTime() : null
    };

    const notified = notifyPassengerOrderUpdate(fullOrder.passenger_id, orderUpdate);
    if (notified) {
      console.log(`[Order] ✅ 已通知乘客 ${fullOrder.passenger_id} 訂單狀態更新為 ${status}`);
    } else {
      console.log(`[Order] ⚠️ 乘客 ${fullOrder.passenger_id} 不在線，無法即時通知`);
    }

    // 產生管理後台通知
    const notificationService = getNotificationService();
    if (status === 'CANCELLED') {
      await notificationService.notifyOrderCancelled(orderId);
    }

    // 客人反向通知分派：
    //   - ARRIVED → 走 CustomerNotificationService（含 SMS 備援）
    //   - DONE / CANCELLED → 保留 LineNotifier shortcut（PR2 範圍外，LINE-only）
    //     (CANCELLED 涵蓋 NO_SHOW cancel，由 /cancel-no-show endpoint 間接觸發；
    //      DONE 是 trip completion，行程已結束 SMS 價值低)
    if (status === 'ARRIVED') {
      const cns = getCustomerNotificationService();
      if (cns) {
        cns.notifyDriverArrived(orderId, {
          driverName: fullOrder.driver_name,
          plate: fullOrder.plate,
          pickupAddress: fullOrder.pickup_address,
        }).catch((err: Error) => console.error('[Order] CustomerNotification 失敗:', err));
      } else {
        // 分派層未啟用時保留舊行為
        const lineNotifier = getLineNotifier();
        if (lineNotifier) {
          lineNotifier.notifyOrderStatusChange(orderId, status, {
            driverName: fullOrder.driver_name,
            plate: fullOrder.plate,
          }).catch(err => console.error('[Order] LINE 推播失敗:', err));
        }
      }
    } else if (status === 'DONE' || status === 'CANCELLED') {
      // 保留 shortcut 不動（84219a6 既有行為）
      const lineNotifier = getLineNotifier();
      if (lineNotifier) {
        lineNotifier.notifyOrderStatusChange(orderId, status, {
          driverName: fullOrder.driver_name,
          plate: fullOrder.plate,
        }).catch(err => console.error('[Order] LINE 推播失敗:', err));
      }
    }

    res.json({
      orderId: fullOrder.order_id,
      passengerId: fullOrder.passenger_id,
      passengerName: fullOrder.passenger_name || '乘客',
      passengerPhone: fullOrder.passenger_phone,
      driverId: fullOrder.driver_id,
      driverName: fullOrder.driver_name,
      driverPhone: fullOrder.driver_phone,
      status: fullOrder.status,
      pickup: {
        lat: parseFloat(fullOrder.pickup_lat),
        lng: parseFloat(fullOrder.pickup_lng),
        address: fullOrder.pickup_address
      },
      destination: fullOrder.dest_lat ? {
        lat: parseFloat(fullOrder.dest_lat),
        lng: parseFloat(fullOrder.dest_lng),
        address: getDestAddress(fullOrder)
      } : null,
      paymentType: fullOrder.payment_type,
      // 電話/LINE 訂單欄位 — 司機端 Tag 顯示 + relocate 按鈕判定 source
      source: fullOrder.source || 'APP',
      subsidyType: fullOrder.subsidy_type || 'NONE',
      subsidyConfirmed: fullOrder.subsidy_confirmed || false,
      subsidyAmount: fullOrder.subsidy_amount || 0,
      petPresent: fullOrder.pet_present || 'UNKNOWN',
      petCarrier: fullOrder.pet_carrier || 'UNKNOWN',
      petNote: fullOrder.pet_note,
      customerPhone: fullOrder.customer_phone,
      notes: fullOrder.notes,
      fare: fullOrder.meter_amount ? {
        meterAmount: fullOrder.meter_amount,
        appDistanceMeters: fullOrder.actual_distance_km ? Math.round(fullOrder.actual_distance_km * 1000) : 0
      } : null,
      createdAt: new Date(fullOrder.created_at).getTime(),
      acceptedAt: fullOrder.accepted_at ? new Date(fullOrder.accepted_at).getTime() : null,
      arrivedAt: fullOrder.arrived_at ? new Date(fullOrder.arrived_at).getTime() : null,
      startedAt: fullOrder.started_at ? new Date(fullOrder.started_at).getTime() : null,
      completedAt: fullOrder.completed_at ? new Date(fullOrder.completed_at).getTime() : null
    });
  } catch (error) {
    console.error('[Update Status] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 司機等候中：推播 LINE 提醒客人
 * POST /api/orders/:orderId/notify-waiting
 *
 * 使用時機：司機按「客人未到」後，App 倒數計時中每 N 分鐘呼叫一次
 * 後端不改 DB，只推一則 LINE 訊息給客人（非 LINE 訂單會自動跳過）
 *
 * Body: { remainingMinutes: number } — 還剩幾分鐘會自動取消
 */
router.post('/:orderId/notify-waiting', async (req, res) => {
  const { orderId } = req.params;
  const { remainingMinutes } = req.body;

  if (typeof remainingMinutes !== 'number' || remainingMinutes < 0) {
    return res.status(400).json({ error: '缺少 remainingMinutes 或數值不合法' });
  }

  try {
    // 狀態檢查：只有 ARRIVED 狀態才有意義推等候訊息
    const order = await queryOne(
      'SELECT status FROM orders WHERE order_id = $1',
      [orderId]
    );
    if (!order) return res.status(404).json({ error: '訂單不存在' });
    if (order.status !== 'ARRIVED') {
      return res.status(400).json({
        error: `訂單狀態為 ${order.status}，無法推送等候通知`,
      });
    }

    const lineNotifier = getLineNotifier();
    if (lineNotifier) {
      await lineNotifier.notifyDriverWaitingForPassenger(orderId, remainingMinutes);
    }

    res.json({ success: true, remainingMinutes });
  } catch (error) {
    console.error('[Notify Waiting] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 司機請客人重發上車位置（LINE 訂單專用）
 * POST /api/orders/:orderId/request-relocation
 *
 * 使用時機：司機到達後找不到客人，懷疑客人傳的位置不準
 *
 * Body:
 *   - driverId: string  （必填）司機 ID（驗 driver_id 匹配防別人代發）
 *
 * 條件：
 *   - 訂單必須 source='LINE' 且有 line_user_id
 *   - 訂單狀態必須 ACCEPTED 或 ARRIVED（接了或到達才需要請客人重發）
 *
 * 副作用：
 *   - LineNotifier.notifyRequestRelocation 推播 Flex card + LIFF deep link
 */
router.post('/:orderId/request-relocation', async (req, res) => {
  const { orderId } = req.params;
  const { driverId } = req.body;

  if (!driverId) {
    return res.status(400).json({ error: '缺少 driverId' });
  }

  try {
    const order = await queryOne(
      'SELECT order_id, driver_id, source, status, line_user_id FROM orders WHERE order_id = $1',
      [orderId]
    );
    if (!order) return res.status(404).json({ error: '訂單不存在' });

    if (order.driver_id !== driverId) {
      return res.status(403).json({ error: '只有接單司機可請客人重發位置' });
    }
    if (order.source !== 'LINE') {
      return res.status(400).json({ error: '只有 LINE 訂單可使用此功能' });
    }
    if (!order.line_user_id) {
      return res.status(400).json({ error: '訂單無 LINE 通道，無法推播' });
    }
    if (!['ACCEPTED', 'ARRIVED'].includes(order.status)) {
      return res.status(400).json({ error: `目前訂單狀態 (${order.status}) 無法請客人重發位置` });
    }

    const lineNotifier = getLineNotifier();
    if (!lineNotifier) {
      return res.status(503).json({ error: 'LINE 通知服務未啟用' });
    }
    await lineNotifier.notifyRequestRelocation(orderId);

    return res.json({ success: true, message: '已通知客人重發上車位置' });
  } catch (error: any) {
    console.error('[Request Relocation] 錯誤:', error);
    res.status(500).json({ error: error.message || 'INTERNAL_ERROR' });
  }
});

/**
 * 客人未到 — 取消訂單並標記為 PASSENGER_NO_SHOW
 * POST /api/orders/:orderId/cancel-no-show
 *
 * 使用時機：等候倒數結束，或司機手動放棄等候
 *
 * Body:
 *   - driverId: string          （必填）司機 ID
 *   - waitedMinutes?: number    司機實際等候幾分鐘（供統計）
 *   - penaltyFare?: number      no-show 罰金（元），預設 100
 *
 * 副作用：
 *   - orders.status = CANCELLED, cancel_reason = '客人未到...', penalty_fare = N
 *   - passengers.no_show_count += 1, last_no_show_at = NOW() （僅當 waitedMinutes >= 1）
 *   - LINE 推播取消訊息（帶罰金額）
 *   - WebSocket 通知乘客
 */
const DEFAULT_NO_SHOW_PENALTY = 100;         // 預設罰金（元）
const MIN_WAIT_MINUTES_TO_COUNT = 1;         // 等候少於此分鐘數不累計 no-show（避免誤觸）

router.post('/:orderId/cancel-no-show', async (req, res) => {
  const { orderId } = req.params;
  const { driverId, waitedMinutes, penaltyFare } = req.body;

  if (!driverId) {
    return res.status(400).json({ error: '缺少 driverId' });
  }

  const waited = typeof waitedMinutes === 'number' ? waitedMinutes : 0;
  const penalty = typeof penaltyFare === 'number' && penaltyFare >= 0
    ? penaltyFare
    : DEFAULT_NO_SHOW_PENALTY;

  try {
    // 只接受從 ARRIVED 狀態取消
    const existing = await queryOne(
      'SELECT status, driver_id, passenger_id FROM orders WHERE order_id = $1',
      [orderId]
    );
    if (!existing) return res.status(404).json({ error: '訂單不存在' });
    if (existing.driver_id !== driverId) {
      return res.status(403).json({ error: '非此訂單司機' });
    }
    if (existing.status !== 'ARRIVED') {
      return res.status(400).json({
        error: `訂單狀態為 ${existing.status}，只能從 ARRIVED 標記 no-show`,
      });
    }

    const reason = waited > 0
      ? `客人未到（司機等候 ${waited} 分鐘）`
      : '客人未到';

    const result = await query(
      `UPDATE orders
       SET status = 'CANCELLED',
           cancelled_at = CURRENT_TIMESTAMP,
           cancel_reason = $1,
           penalty_fare = $2
       WHERE order_id = $3 AND status = 'ARRIVED'
       RETURNING *`,
      [reason, penalty, orderId]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: '訂單狀態已變更，無法取消' });
    }

    // 累積 no-show 統計（司機等候 >= 1 分鐘才算，避免司機手殘秒取消也計入）
    if (waited >= MIN_WAIT_MINUTES_TO_COUNT) {
      await query(
        `UPDATE passengers
         SET no_show_count = COALESCE(no_show_count, 0) + 1,
             last_no_show_at = CURRENT_TIMESTAMP
         WHERE passenger_id = $1`,
        [existing.passenger_id]
      );
    }

    console.log(`[Order NoShow] 訂單 ${orderId} 被司機 ${driverId} 標記為客人未到 (等候 ${waited} 分鐘，罰金 ${penalty} 元)`);

    // 通知乘客（WebSocket + LINE）
    const fullOrder = await queryOne(`
      SELECT o.*, p.name AS passenger_name, d.name AS driver_name, d.plate
      FROM orders o
      LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      WHERE o.order_id = $1
    `, [orderId]);

    // WebSocket
    notifyPassengerOrderUpdate(fullOrder.passenger_id, {
      orderId,
      status: 'CANCELLED',
      cancelReason: reason,
      penaltyFare: penalty,
    });

    // LINE 推播（orderCancelledCard，附帶友善的取消原因 + 罰金）
    const lineNotifier = getLineNotifier();
    if (lineNotifier) {
      const reasonForLine = penalty > 0
        ? `因您未準時到達上車點，訂單已取消。根據規定需收取 NT$${penalty} 違約金。`
        : '因您未準時到達上車點，訂單已取消';
      lineNotifier.notifyOrderStatusChange(orderId, 'CANCELLED', {
        reason: reasonForLine,
      }).catch(err => console.error('[NoShow] LINE 推播失敗:', err));
    }

    // 清理派單追蹤
    cancelOrderTracking(orderId);

    // 管理後台通知
    const notificationService = getNotificationService();
    await notificationService.notifyOrderCancelled(orderId);

    res.json({
      success: true,
      orderId,
      status: 'CANCELLED',
      cancelReason: reason,
      penaltyFare: penalty,
      waitedMinutes: waited,
    });
  } catch (error) {
    console.error('[Cancel NoShow] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 愛心卡/敬老卡確認或取消
 * PATCH /api/orders/:orderId/subsidy
 */
router.patch('/:orderId/subsidy', async (req, res) => {
  const { orderId } = req.params;
  const { driverId, action } = req.body;

  try {
    if (!driverId || !action) {
      return res.status(400).json({ error: '缺少 driverId 或 action' });
    }

    if (!['CONFIRM', 'CANCEL'].includes(action)) {
      return res.status(400).json({ error: 'action 必須為 CONFIRM 或 CANCEL' });
    }

    const order = await queryOne(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );

    if (!order) {
      return res.status(404).json({ error: '訂單不存在' });
    }

    if (order.driver_id !== driverId) {
      return res.status(403).json({ error: '只有指派的司機可以操作' });
    }

    if (!['ARRIVED', 'ON_TRIP'].includes(order.status)) {
      return res.status(400).json({ error: '只能在已到達或行程中確認愛心卡' });
    }

    let updatedOrder;
    if (action === 'CONFIRM') {
      const result = await query(
        'UPDATE orders SET subsidy_confirmed = true WHERE order_id = $1 RETURNING *',
        [orderId]
      );
      updatedOrder = result.rows[0];
      console.log(`[Order] 訂單 ${orderId} 愛心卡已確認`);
    } else {
      // CANCEL: 改回一般計費
      const result = await query(
        `UPDATE orders SET subsidy_type = 'NONE', subsidy_confirmed = false WHERE order_id = $1 RETURNING *`,
        [orderId]
      );
      updatedOrder = result.rows[0];
      console.log(`[Order] 訂單 ${orderId} 愛心卡已取消，改為一般計費`);
    }

    // 查詢完整訂單資訊
    const fullOrder = await queryOne(`
      SELECT o.*, p.name as passenger_name, p.phone as passenger_phone,
             d.name as driver_name, d.phone as driver_phone
      FROM orders o
      LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      WHERE o.order_id = $1
    `, [orderId]);

    const orderUpdate = {
      orderId: fullOrder.order_id,
      passengerId: fullOrder.passenger_id,
      passengerName: fullOrder.passenger_name || '乘客',
      passengerPhone: fullOrder.passenger_phone,
      driverId: fullOrder.driver_id,
      driverName: fullOrder.driver_name,
      driverPhone: fullOrder.driver_phone,
      status: fullOrder.status,
      pickup: {
        lat: parseFloat(fullOrder.pickup_lat),
        lng: parseFloat(fullOrder.pickup_lng),
        address: fullOrder.pickup_address
      },
      destination: fullOrder.dest_lat ? {
        lat: parseFloat(fullOrder.dest_lat),
        lng: parseFloat(fullOrder.dest_lng),
        address: getDestAddress(fullOrder)
      } : null,
      paymentType: fullOrder.payment_type,
      subsidyType: fullOrder.subsidy_type || 'NONE',
      subsidyConfirmed: fullOrder.subsidy_confirmed || false,
      subsidyAmount: fullOrder.subsidy_amount || 0,
      createdAt: new Date(fullOrder.created_at).getTime(),
      acceptedAt: fullOrder.accepted_at ? new Date(fullOrder.accepted_at).getTime() : null,
      arrivedAt: fullOrder.arrived_at ? new Date(fullOrder.arrived_at).getTime() : null,
      startedAt: fullOrder.started_at ? new Date(fullOrder.started_at).getTime() : null,
      completedAt: fullOrder.completed_at ? new Date(fullOrder.completed_at).getTime() : null
    };

    // WebSocket 通知乘客
    notifyPassengerOrderUpdate(fullOrder.passenger_id, orderUpdate);

    res.json(orderUpdate);
  } catch (error) {
    console.error('[Order] 愛心卡確認/取消錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 提交車資處理邏輯（共用函數）
 */
async function handleSubmitFare(req: any, res: any) {
  const { orderId } = req.params;
  const { meterAmount, distance, duration, photoUrl } = req.body;

  try {
    const order = await queryOne(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );

    if (!order) {
      return res.status(404).json({ error: '訂單不存在' });
    }

    if (order.status !== 'ON_TRIP' && order.status !== 'SETTLING') {
      return res.status(400).json({ error: '只能在行程中或結算中提交車資' });
    }

    // 計算愛心卡補貼金額
    let subsidyAmount = 0;
    if (order.subsidy_type === 'LOVE_CARD' && order.subsidy_confirmed) {
      const config = fareConfigService.getConfig();
      subsidyAmount = Math.min(config.loveCardSubsidyAmount, meterAmount);
      console.log(`[Order] 訂單 ${orderId} 愛心卡補貼: NT$ ${subsidyAmount}`);
    }

    // 更新訂單（提交車資後訂單直接完成）
    const result = await query(`
      UPDATE orders
      SET
        meter_amount = $1,
        actual_distance_km = $2,
        actual_duration_min = $3,
        photo_url = $4,
        subsidy_amount = $6,
        status = 'DONE',
        completed_at = CURRENT_TIMESTAMP
      WHERE order_id = $5
      RETURNING *
    `, [meterAmount, distance, duration, photoUrl || null, orderId, subsidyAmount]);

    const updatedOrder = result.rows[0];

    // 更新司機總收入
    if (updatedOrder.driver_id) {
      await query(
        'UPDATE drivers SET total_earnings = total_earnings + $1 WHERE driver_id = $2',
        [meterAmount, updatedOrder.driver_id]
      );
    }

    console.log(`[Order] 訂單 ${orderId} 提交車資：NT$ ${meterAmount}`);

    // 查詢完整訂單資訊（包含乘客和司機資訊）
    const fullOrder = await queryOne(`
      SELECT o.*, p.name as passenger_name, p.phone as passenger_phone,
             d.name as driver_name, d.phone as driver_phone
      FROM orders o
      LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      WHERE o.order_id = $1
    `, [orderId]);

    // 透過 WebSocket 通知乘客訂單進入結算階段
    const passengerPays = fullOrder.meter_amount - (fullOrder.subsidy_amount || 0);
    const orderUpdate = {
      orderId: fullOrder.order_id,
      passengerId: fullOrder.passenger_id,
      passengerName: fullOrder.passenger_name || '乘客',
      passengerPhone: fullOrder.passenger_phone,
      driverId: fullOrder.driver_id,
      driverName: fullOrder.driver_name,
      driverPhone: fullOrder.driver_phone,
      status: fullOrder.status,
      pickup: {
        lat: parseFloat(fullOrder.pickup_lat),
        lng: parseFloat(fullOrder.pickup_lng),
        address: fullOrder.pickup_address
      },
      destination: fullOrder.dest_lat ? {
        lat: parseFloat(fullOrder.dest_lat),
        lng: parseFloat(fullOrder.dest_lng),
        address: getDestAddress(fullOrder)
      } : null,
      paymentType: fullOrder.payment_type,
      subsidyType: fullOrder.subsidy_type || 'NONE',
      subsidyConfirmed: fullOrder.subsidy_confirmed || false,
      subsidyAmount: fullOrder.subsidy_amount || 0,
      passengerPays,
      fare: {
        meterAmount: fullOrder.meter_amount,
        appDistanceMeters: fullOrder.actual_distance_km ? Math.round(fullOrder.actual_distance_km * 1000) : 0
      },
      createdAt: new Date(fullOrder.created_at).getTime(),
      acceptedAt: fullOrder.accepted_at ? new Date(fullOrder.accepted_at).getTime() : null,
      arrivedAt: fullOrder.arrived_at ? new Date(fullOrder.arrived_at).getTime() : null,
      startedAt: fullOrder.started_at ? new Date(fullOrder.started_at).getTime() : null,
      completedAt: fullOrder.completed_at ? new Date(fullOrder.completed_at).getTime() : null
    };

    const notified = notifyPassengerOrderUpdate(fullOrder.passenger_id, orderUpdate);
    if (notified) {
      console.log(`[Order] ✅ 已通知乘客 ${fullOrder.passenger_id} 訂單已完成，車資 NT$ ${meterAmount}`);
    } else {
      console.log(`[Order] ⚠️ 乘客 ${fullOrder.passenger_id} 不在線，無法即時通知`);
    }

    // LINE 推播通知
    const lineNotifier = getLineNotifier();
    if (lineNotifier) {
      lineNotifier.notifyOrderStatusChange(orderId, 'DONE', { fare: meterAmount })
        .catch(err => console.error('[Order] LINE 推播失敗:', err));
    }

    // 產生管理後台通知
    const notificationService = getNotificationService();
    await notificationService.notifyOrderCompleted(orderId, meterAmount);

    res.json({
      orderId: fullOrder.order_id,
      passengerId: fullOrder.passenger_id,
      passengerName: fullOrder.passenger_name || '乘客',
      passengerPhone: fullOrder.passenger_phone,
      driverId: fullOrder.driver_id,
      driverName: fullOrder.driver_name,
      driverPhone: fullOrder.driver_phone,
      status: fullOrder.status,
      pickup: {
        lat: parseFloat(fullOrder.pickup_lat),
        lng: parseFloat(fullOrder.pickup_lng),
        address: fullOrder.pickup_address
      },
      destination: fullOrder.dest_lat ? {
        lat: parseFloat(fullOrder.dest_lat),
        lng: parseFloat(fullOrder.dest_lng),
        address: getDestAddress(fullOrder)
      } : null,
      paymentType: fullOrder.payment_type,
      subsidyType: fullOrder.subsidy_type || 'NONE',
      subsidyConfirmed: fullOrder.subsidy_confirmed || false,
      subsidyAmount: fullOrder.subsidy_amount || 0,
      passengerPays,
      fare: {
        meterAmount: fullOrder.meter_amount,
        appDistanceMeters: fullOrder.actual_distance_km ? Math.round(fullOrder.actual_distance_km * 1000) : 0
      },
      createdAt: new Date(fullOrder.created_at).getTime(),
      acceptedAt: fullOrder.accepted_at ? new Date(fullOrder.accepted_at).getTime() : null,
      arrivedAt: fullOrder.arrived_at ? new Date(fullOrder.arrived_at).getTime() : null,
      startedAt: fullOrder.started_at ? new Date(fullOrder.started_at).getTime() : null,
      completedAt: fullOrder.completed_at ? new Date(fullOrder.completed_at).getTime() : null
    });
  } catch (error) {
    console.error('[Submit Fare] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
}

/**
 * 提交車資
 * POST /api/orders/:orderId/fare (Android 客戶端使用)
 */
router.post('/:orderId/fare', handleSubmitFare);

/**
 * 提交車資
 * PATCH /api/orders/:orderId/fare (備用)
 */
router.patch('/:orderId/fare', handleSubmitFare);

export default router;

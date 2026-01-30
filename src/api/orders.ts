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
        address: order.dest_address
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
          address: order.dest_address
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
          address: o.dest_address
        } : null,
        paymentType: o.payment_type,
        meterAmount: o.meter_amount,
        createdAt: o.created_at,
        acceptedAt: o.accepted_at,
        completedAt: o.completed_at
      })),
      total: orders.length
    });
  } catch (error) {
    console.error('[Get Orders] 錯誤:', error);
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
        address: order.dest_address
      } : null,
      paymentType: order.payment_type,
      meterAmount: order.meter_amount,
      photoUrl: order.photo_url,
      createdAt: order.created_at,
      acceptedAt: order.accepted_at,
      arrivedAt: order.arrived_at,
      startedAt: order.started_at,
      completedAt: order.completed_at
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
      console.log(`[Accept Order] SmartDispatcherV2 失敗，回退到傳統處理:`, dispatcherError);
      accepted = handleDriverAccept(orderId, driverId);
    }

    if (!accepted) {
      // 可能已被其他司機接走
      return res.status(409).json({
        error: 'ORDER_ALREADY_TAKEN',
        message: '此訂單已被其他司機接走'
      });
    }

    // 更新訂單狀態
    const result = await query(`
      UPDATE orders
      SET status = 'ACCEPTED',
          driver_id = $1,
          accepted_at = CURRENT_TIMESTAMP
      WHERE order_id = $2
      RETURNING *
    `, [driverId, orderId]);

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
        address: fullOrder.dest_address
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
          address: fullOrder.dest_address
        } : null,
        paymentType: fullOrder.payment_type,
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
        address: fullOrder.dest_address
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
        address: fullOrder.dest_address
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
    });
  } catch (error) {
    console.error('[Update Status] 錯誤:', error);
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

    // 更新訂單（提交車資後訂單直接完成）
    const result = await query(`
      UPDATE orders
      SET
        meter_amount = $1,
        actual_distance_km = $2,
        actual_duration_min = $3,
        photo_url = $4,
        status = 'DONE',
        completed_at = CURRENT_TIMESTAMP
      WHERE order_id = $5
      RETURNING *
    `, [meterAmount, distance, duration, photoUrl || null, orderId]);

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
        address: fullOrder.dest_address
      } : null,
      paymentType: fullOrder.payment_type,
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
        address: fullOrder.dest_address
      } : null,
      paymentType: fullOrder.payment_type,
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

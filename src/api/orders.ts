import { Router } from 'express';
import { query, queryOne, queryMany } from '../db/connection';
import { broadcastOrderToDrivers } from '../socket';

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

    // 透過 WebSocket 推送給所有上線的司機
    const offeredTo = broadcastOrderToDrivers({
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
    });

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

    // TODO: 透過 WebSocket 通知乘客

    res.json({
      success: true,
      message: '接單成功',
      order: {
        orderId: updatedOrder.order_id,
        passengerId: updatedOrder.passenger_id,
        driverId: updatedOrder.driver_id,
        status: updatedOrder.status,
        acceptedAt: updatedOrder.accepted_at
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
 */
router.patch('/:orderId/reject', async (req, res) => {
  const { orderId } = req.params;
  const { driverId, reason = '司機忙碌' } = req.body;

  try {
    const order = await queryOne(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );

    if (!order) {
      return res.status(404).json({ error: '訂單不存在' });
    }

    // 記錄拒單次數
    await query(
      'UPDATE orders SET reject_count = reject_count + 1 WHERE order_id = $1',
      [orderId]
    );

    console.log(`[Order] 訂單 ${orderId} 被司機 ${driverId} 拒絕，原因：${reason}`);

    // TODO: 重新派給其他司機

    res.json({
      success: true,
      message: '已拒絕訂單'
    });
  } catch (error) {
    console.error('[Reject Order] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
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

    // TODO: 透過 WebSocket 通知相關用戶

    res.json({
      success: true,
      order: {
        orderId: updatedOrder.order_id,
        status: updatedOrder.status
      }
    });
  } catch (error) {
    console.error('[Update Status] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 提交車資
 * PATCH /api/orders/:orderId/fare
 */
router.patch('/:orderId/fare', async (req, res) => {
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

    // 更新訂單
    const result = await query(`
      UPDATE orders
      SET
        meter_amount = $1,
        actual_distance_km = $2,
        actual_duration_min = $3,
        photo_url = $4,
        status = 'SETTLING'
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

    res.json({
      success: true,
      order: {
        orderId: updatedOrder.order_id,
        status: updatedOrder.status,
        meterAmount: updatedOrder.meter_amount
      }
    });
  } catch (error) {
    console.error('[Submit Fare] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;

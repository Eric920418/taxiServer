import { Router } from 'express';
import { query, queryOne, queryMany } from '../db/connection';

const router = Router();

/**
 * 【已棄用】舊的手機號碼登入 API
 * 請改用 POST /api/auth/phone-verify-passenger
 */
router.post('/login', async (req, res) => {
  return res.status(410).json({
    error: 'DEPRECATED',
    message: '此 API 已停用，請改用 Firebase Phone Authentication',
    migrateTo: '/api/auth/phone-verify-passenger'
  });
});

/**
 * 查詢附近司機
 * GET /api/passengers/nearby-drivers
 */
router.get('/nearby-drivers', async (req, res) => {
  const { lat, lng, radius = 5000 } = req.query;

  try {
    if (!lat || !lng) {
      return res.status(400).json({ error: '缺少位置參數' });
    }

    // 查詢可接單的司機
    const drivers = await queryMany(`
      SELECT
        driver_id,
        name,
        plate,
        current_lat,
        current_lng,
        rating,
        total_trips,
        acceptance_rate
      FROM drivers
      WHERE availability = 'AVAILABLE'
        AND current_lat IS NOT NULL
        AND current_lng IS NOT NULL
        AND last_heartbeat > NOW() - INTERVAL '5 minutes'
    `);

    // 計算距離並篩選（簡易版本，實際應用 PostGIS）
    const nearbyDrivers = drivers.map(driver => {
      const distance = calculateDistance(
        parseFloat(lat as string),
        parseFloat(lng as string),
        parseFloat(driver.current_lat),
        parseFloat(driver.current_lng)
      );

      return {
        driverId: driver.driver_id,
        name: driver.name,
        plate: driver.plate,
        location: {
          lat: parseFloat(driver.current_lat),
          lng: parseFloat(driver.current_lng)
        },
        rating: parseFloat(driver.rating),
        distance: Math.round(distance), // 公尺
        eta: Math.round(distance / 500 * 60) // 簡易估算：假設平均時速 30km/h
      };
    }).filter(driver => driver.distance <= parseInt(radius as string))
       .sort((a, b) => a.distance - b.distance);

    res.json({
      success: true,
      drivers: nearbyDrivers,
      count: nearbyDrivers.length
    });
  } catch (error) {
    console.error('[Nearby Drivers] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 創建叫車訂單（移到 orders API）
 * POST /api/passengers/request-ride
 */
router.post('/request-ride', async (req, res) => {
  const {
    passengerId,
    passengerName,
    passengerPhone,
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
    if (!passengerId || !passengerName || !passengerPhone ||
        !pickupLat || !pickupLng || !pickupAddress) {
      return res.status(400).json({ error: '缺少必要欄位' });
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
      orderId, passengerId,
      pickupLat, pickupLng, pickupAddress,
      destLat || null, destLng || null, destAddress || null,
      paymentType,
      now.getHours(), now.getDay()
    ]);

    const order = result.rows[0];

    console.log(`[Passenger] 乘客 ${passengerName} 發起叫車請求: ${orderId}`);

    // TODO: 推播給所有在線司機（透過 WebSocket）
    // broadcastOrderToDrivers(order);

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
        paymentType: order.payment_type,
        createdAt: order.created_at
      },
      message: '叫車請求已發送，等待司機接單'
    });
  } catch (error) {
    console.error('[Request Ride] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 取消訂單
 * POST /api/passengers/cancel-order
 */
router.post('/cancel-order', async (req, res) => {
  const { orderId, passengerId, reason = '乘客取消' } = req.body;

  try {
    if (!orderId || !passengerId) {
      return res.status(400).json({ error: '缺少必要欄位' });
    }

    // 更新訂單狀態
    const result = await query(`
      UPDATE orders
      SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP
      WHERE order_id = $1 AND passenger_id = $2
        AND status IN ('WAITING', 'OFFERED', 'ACCEPTED')
      RETURNING *
    `, [orderId, passengerId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: '訂單不存在或無法取消' });
    }

    console.log(`[Passenger] 乘客 ${passengerId} 取消訂單 ${orderId}，原因：${reason}`);

    // TODO: 通知司機（透過 WebSocket）

    res.json({
      success: true,
      message: '訂單已取消'
    });
  } catch (error) {
    console.error('[Cancel Order] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 查詢乘客的訂單歷史
 * GET /api/passengers/:passengerId/orders
 */
router.get('/:passengerId/orders', async (req, res) => {
  const { passengerId } = req.params;
  const { status, limit = 50, offset = 0 } = req.query;

  try {
    let sql = `
      SELECT
        o.*,
        d.name as driver_name,
        d.phone as driver_phone,
        d.plate as driver_plate
      FROM orders o
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      WHERE o.passenger_id = $1
    `;

    const params: any[] = [passengerId];

    if (status) {
      sql += ` AND o.status = $${params.length + 1}`;
      params.push(status);
    }

    sql += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const orders = await queryMany(sql, params);

    const formattedOrders = orders.map(o => ({
      orderId: o.order_id,
      passengerId: o.passenger_id,
      driverId: o.driver_id,
      driverName: o.driver_name,
      driverPhone: o.driver_phone,
      driverPlate: o.driver_plate,
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
      status: o.status,
      paymentType: o.payment_type,
      meterAmount: o.meter_amount,
      createdAt: o.created_at,
      acceptedAt: o.accepted_at,
      completedAt: o.completed_at
    }));

    console.log(`[Passenger] 查詢乘客 ${passengerId} 的訂單歷史，找到 ${formattedOrders.length} 筆`);

    res.json({
      success: true,
      orders: formattedOrders,
      total: formattedOrders.length
    });
  } catch (error) {
    console.error('[Get Orders] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 計算兩點距離（Haversine 公式）
 */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // 地球半徑（公尺）
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // 返回公尺
}

export default router;

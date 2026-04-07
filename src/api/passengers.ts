import { Router } from 'express';
import { query, queryOne, queryMany } from '../db/connection';
import { broadcastOrderToDrivers, broadcastOrderStatusToDrivers, notifyDriverOrderStatus } from '../socket';
import { registerOrder, cancelOrderTracking } from '../services/OrderDispatcher';
import { getSmartDispatcherV2, OrderData } from '../services/SmartDispatcherV2';
import { hualienAddressDB } from '../services/HualienAddressDB';

import { fareConfigService } from '../services/FareConfigService';
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
  console.log('🚖🚖🚖 [Request Ride] 收到叫車請求！');
  console.log('[Request Ride] 請求內容:', JSON.stringify(req.body, null, 2));

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
    paymentType = 'CASH',
    // 乘客端傳入的道路距離和車資（Google Directions API 計算）
    tripDistanceMeters,
    estimatedFare: clientEstimatedFare
  } = req.body;

  try {
    // 驗證必要欄位
    if (!passengerId || !passengerName || !passengerPhone ||
        !pickupLat || !pickupLng || !pickupAddress) {
      return res.status(400).json({ error: '缺少必要欄位' });
    }

    // 段數正規化：1段→一段，確保 DB 儲存的地址格式統一
    const normalizedPickupAddress = hualienAddressDB.normalizeSegment(pickupAddress);
    const normalizedDestAddress = destAddress ? hualienAddressDB.normalizeSegment(destAddress) : destAddress;

    // 【重要】檢查乘客是否已有進行中的訂單（防止重複叫車）
    const existingOrder = await queryOne(`
      SELECT order_id, status, pickup_address, created_at
      FROM orders
      WHERE passenger_id = $1
        AND status IN ('OFFERED', 'ACCEPTED', 'ARRIVED', 'ON_TRIP', 'SETTLING')
      ORDER BY created_at DESC
      LIMIT 1
    `, [passengerId]);

    if (existingOrder) {
      console.log(`[Request Ride] ⚠️ 乘客 ${passengerId} 已有進行中訂單: ${existingOrder.order_id} (狀態: ${existingOrder.status})`);
      return res.status(409).json({
        error: 'EXISTING_ORDER',
        message: `您已有進行中的訂單（狀態：${existingOrder.status}），請先完成或取消該訂單`,
        existingOrderId: existingOrder.order_id,
        existingOrderStatus: existingOrder.status
      });
    }

    // 檢查電話號碼是否已存在（因為有唯一約束）
    let actualPassengerId = passengerId;
    const existingPassengerByPhone = await queryOne(`
      SELECT passenger_id, name FROM passengers WHERE phone = $1
    `, [passengerPhone]);

    if (existingPassengerByPhone) {
      // 電話號碼已存在，使用現有的 passenger_id 但更新名稱
      actualPassengerId = existingPassengerByPhone.passenger_id;
      console.log(`[Passenger] 電話 ${passengerPhone} 已存在，使用現有 ID: ${actualPassengerId}`);

      await query(`
        UPDATE passengers
        SET name = $2
        WHERE passenger_id = $1
      `, [actualPassengerId, passengerName]);
    } else {
      // 新電話號碼，創建新乘客
      console.log(`[Passenger] 創建新乘客: ${passengerId}, 電話: ${passengerPhone}`);
      await query(`
        INSERT INTO passengers (passenger_id, name, phone, created_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      `, [passengerId, passengerName, passengerPhone]);
      actualPassengerId = passengerId;
    }

    // 計算預估車資
    // 優先使用乘客端傳入的車資（基於 Google Directions API 的道路距離）
    // 若無，則 fallback 到直線距離計算
    let estimatedFare: number | null = null;
    if (clientEstimatedFare) {
      // 使用乘客端計算的車資（基於實際道路距離）
      estimatedFare = clientEstimatedFare;
      console.log(`[Request Ride] 使用乘客端車資: ${estimatedFare} 元 (道路距離: ${tripDistanceMeters ? tripDistanceMeters/1000 : '?'} km)`);
    } else if (destLat && destLng) {
      // Fallback: 使用直線距離計算（較不準確）
      const tripDistance = calculateDistance(
        parseFloat(pickupLat), parseFloat(pickupLng),
        parseFloat(destLat), parseFloat(destLng)
      ) / 1000; // 轉換為公里
      // 使用 FareConfigService 計算車資（跳錶制，尾數只有 0 或 5）
      const fareResult = fareConfigService.calculateFare(tripDistance * 1000);
      estimatedFare = fareResult.totalFare;
      console.log(`[Request Ride] 使用直線距離計算車資: ${estimatedFare} 元 (直線距離: ${tripDistance.toFixed(2)} km)`);
    }

    // 建立訂單（使用 actualPassengerId）
    const orderId = `ORD${Date.now()}`;
    const now = new Date();

    const result = await query(`
      INSERT INTO orders (
        order_id, passenger_id, status,
        pickup_lat, pickup_lng, pickup_address,
        dest_lat, dest_lng, dest_address,
        payment_type,
        created_at, offered_at,
        hour_of_day, day_of_week,
        dispatch_method, estimated_fare
      ) VALUES (
        $1, $2, 'OFFERED',
        $3, $4, $5,
        $6, $7, $8,
        $9,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        $10, $11,
        'LAYERED', $12
      ) RETURNING *
    `, [
      orderId, actualPassengerId,
      pickupLat, pickupLng, normalizedPickupAddress,
      destLat || null, destLng || null, normalizedDestAddress || null,
      paymentType,
      now.getHours(), now.getDay(),
      estimatedFare
    ]);

    const order = result.rows[0];

    console.log(`[Passenger] 乘客 ${passengerName} 發起叫車請求: ${orderId}`);

    // 如果 App 的 passengerId 與實際 passenger_id 不同，建立映射
    if (passengerId !== actualPassengerId) {
      const { passengerSockets } = require('../socket');
      const appSocketId = passengerSockets.get(passengerId);
      if (appSocketId) {
        // 將 App 的 socket 同時映射到實際的 passenger_id
        passengerSockets.set(actualPassengerId, appSocketId);
        console.log(`[Passenger] 建立 ID 映射: ${passengerId} -> ${actualPassengerId}, Socket: ${appSocketId}`);
      }
    }

    // 格式化訂單資料用於 SmartDispatcherV2
    const orderData: OrderData = {
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
      paymentType: order.payment_type,
      estimatedFare: estimatedFare || undefined,
      createdAt: new Date(order.created_at).getTime()
    };

    // 使用 SmartDispatcherV2 智能派單（分層派單 + ML 預測）
    console.log(`[Passenger] 開始智能派發訂單 ${orderId}...`);
    let dispatchResult;
    try {
      const smartDispatcher = getSmartDispatcherV2();
      dispatchResult = await smartDispatcher.startDispatch(orderData);
      console.log(`[Passenger] ✅ SmartDispatcherV2: ${dispatchResult.message}`);
    } catch (error) {
      // 如果 SmartDispatcherV2 失敗，回退到舊的派單系統
      console.log(`[Passenger] SmartDispatcherV2 失敗，回退到傳統派單:`, error);
      const offeredDriverIds = registerOrder({
        orderId: orderData.orderId,
        passengerId: orderData.passengerId,
        passengerName: orderData.passengerName,
        passengerPhone: orderData.passengerPhone,
        status: 'OFFERED',
        pickup: orderData.pickup,
        destination: orderData.destination,
        paymentType: orderData.paymentType,
        createdAt: orderData.createdAt,
        estimatedFare: estimatedFare || undefined  // 新增：傳遞預估車資
      });
      dispatchResult = {
        success: offeredDriverIds.length > 0,
        message: offeredDriverIds.length > 0
          ? `已派發給 ${offeredDriverIds.length} 位司機`
          : '無可用司機',
        batchNumber: 1,
        offeredTo: offeredDriverIds
      };
    }

    res.json({
      success: true,
      order: {
        ...orderData,
        status: order.status,
        estimatedFare
      },
      offeredTo: dispatchResult.offeredTo,
      batchNumber: dispatchResult.batchNumber,
      message: dispatchResult.success
        ? `叫車請求已發送（第 ${dispatchResult.batchNumber} 批），等待司機接單（5 分鐘內有效）`
        : '目前沒有在線司機，系統會在有司機上線時自動派單'
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

    console.log(`[Cancel Order] 收到取消請求: orderId=${orderId}, passengerId=${passengerId}`);

    // 先查詢訂單，確認狀態
    const orderCheck = await queryOne(`
      SELECT order_id, passenger_id, status
      FROM orders
      WHERE order_id = $1
    `, [orderId]);

    if (!orderCheck) {
      console.log(`[Cancel Order] 訂單 ${orderId} 不存在`);
      return res.status(404).json({ error: '訂單不存在' });
    }

    console.log(`[Cancel Order] 訂單狀態: ${orderCheck.status}, DB passenger_id: ${orderCheck.passenger_id}, 請求 passenger_id: ${passengerId}`);

    // 檢查訂單是否可以取消
    if (!['WAITING', 'OFFERED', 'ACCEPTED'].includes(orderCheck.status)) {
      console.log(`[Cancel Order] 訂單狀態 ${orderCheck.status} 無法取消`);
      return res.status(400).json({ error: `訂單狀態為 ${orderCheck.status}，無法取消` });
    }

    // 更新訂單狀態（只用 orderId，不檢查 passenger_id 避免 Firebase UID 和 DB ID 不匹配）
    const result = await query(`
      UPDATE orders
      SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP
      WHERE order_id = $1
      RETURNING *
    `, [orderId]);

    if (result.rowCount === 0) {
      return res.status(500).json({ error: '取消失敗' });
    }

    console.log(`[Cancel Order] ✅ 成功取消訂單 ${orderId}，原因：${reason}`);

    // 從 OrderDispatcher 中移除訂單追蹤
    cancelOrderTracking(orderId);

    // 通知司機訂單已取消（透過 WebSocket）
    const cancelledOrder = result.rows[0];
    const orderForNotification = {
      orderId: cancelledOrder.order_id,
      status: 'CANCELLED',
      passengerId: cancelledOrder.passenger_id,
      passengerName: cancelledOrder.passenger_name,
      pickup: {
        address: cancelledOrder.pickup_address,
        latitude: cancelledOrder.pickup_lat,
        longitude: cancelledOrder.pickup_lng
      },
      destination: cancelledOrder.destination_address ? {
        address: cancelledOrder.destination_address,
        latitude: cancelledOrder.destination_lat,
        longitude: cancelledOrder.destination_lng
      } : null,
      cancelReason: reason
    };

    // 如果有指定司機（已被接單），通知該司機
    if (cancelledOrder.driver_id) {
      notifyDriverOrderStatus(cancelledOrder.driver_id, orderForNotification);
      console.log(`[Cancel Order] 已通知司機 ${cancelledOrder.driver_id} 訂單被取消`);
    } else {
      // 否則廣播給所有在線司機（訂單可能還在派單中）
      broadcastOrderStatusToDrivers(orderForNotification);
      console.log(`[Cancel Order] 已廣播訂單取消給所有在線司機`);
    }

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
 * 查詢乘客個人資料
 * GET /api/passengers/:passengerId
 */
router.get('/:passengerId', async (req, res) => {
  const { passengerId } = req.params;

  try {
    const passenger = await queryOne(`
      SELECT
        passenger_id,
        name,
        phone,
        email,
        rating,
        total_trips,
        created_at
      FROM passengers
      WHERE passenger_id = $1
    `, [passengerId]);

    if (!passenger) {
      return res.status(404).json({ error: '乘客不存在' });
    }

    res.json({
      success: true,
      passenger: {
        passengerId: passenger.passenger_id,
        name: passenger.name,
        phone: passenger.phone,
        email: passenger.email,
        rating: parseFloat(passenger.rating || '5.0'),
        totalTrips: parseInt(passenger.total_trips || '0'),
        createdAt: passenger.created_at ? new Date(passenger.created_at).getTime() : null
      }
    });
  } catch (error) {
    console.error('[Get Passenger] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 更新乘客個人資料
 * PATCH /api/passengers/:passengerId
 */
router.patch('/:passengerId', async (req, res) => {
  const { passengerId } = req.params;
  const { name, email } = req.body;

  try {
    // 檢查乘客是否存在
    const existing = await queryOne(
      'SELECT * FROM passengers WHERE passenger_id = $1',
      [passengerId]
    );

    if (!existing) {
      return res.status(404).json({ error: '乘客不存在' });
    }

    // 更新資料
    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (name) {
      updates.push(`name = $${paramIndex++}`);
      params.push(name);
    }
    if (email !== undefined) {
      updates.push(`email = $${paramIndex++}`);
      params.push(email || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: '沒有要更新的欄位' });
    }

    params.push(passengerId);
    const sql = `
      UPDATE passengers
      SET ${updates.join(', ')}
      WHERE passenger_id = $${paramIndex}
      RETURNING *
    `;

    const result = await query(sql, params);
    const updated = result.rows[0];

    console.log(`[Passenger] 更新乘客資料: ${passengerId}`);

    res.json({
      success: true,
      passenger: {
        passengerId: updated.passenger_id,
        name: updated.name,
        phone: updated.phone,
        email: updated.email,
        rating: parseFloat(updated.rating || '5.0'),
        totalTrips: parseInt(updated.total_trips || '0')
      }
    });
  } catch (error) {
    console.error('[Update Passenger] 錯誤:', error);
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
      createdAt: o.created_at ? new Date(o.created_at).getTime() : null,
      acceptedAt: o.accepted_at ? new Date(o.accepted_at).getTime() : null,
      completedAt: o.completed_at ? new Date(o.completed_at).getTime() : null
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

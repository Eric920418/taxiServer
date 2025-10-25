import { Router } from 'express';
import { query, queryMany, queryOne } from '../db/connection';

const router = Router();

/**
 * 查詢司機的收入排行榜（所有司機對比）
 * GET /api/earnings/leaderboard?period=today|week|month
 * 注意：此路由必須在 /:driverId 之前，避免被攔截
 */
router.get('/leaderboard', async (req, res) => {
  const { period = 'today' } = req.query;

  try {
    let startDate: Date;
    const now = new Date();

    if (period === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === 'week') {
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === 'month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      return res.status(400).json({ error: '無效的期間參數' });
    }

    const leaderboard = await queryMany(`
      SELECT
        d.driver_id,
        d.name,
        d.plate,
        COUNT(o.order_id) as order_count,
        COALESCE(SUM(o.meter_amount), 0) as total_earnings
      FROM drivers d
      LEFT JOIN orders o ON d.driver_id = o.driver_id
        AND o.status = 'DONE'
        AND o.completed_at >= $1
        AND o.completed_at < $2
      GROUP BY d.driver_id, d.name, d.plate
      ORDER BY total_earnings DESC
      LIMIT 10
    `, [startDate, now]);

    res.json({
      success: true,
      period,
      leaderboard: leaderboard.map((driver, index) => ({
        rank: index + 1,
        driverId: driver.driver_id,
        name: driver.name,
        plate: driver.plate,
        orderCount: parseInt(String(driver.order_count)),
        totalEarnings: parseInt(String(driver.total_earnings))
      }))
    });

  } catch (error) {
    console.error('[Earnings Leaderboard] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 查詢司機收入統計
 * GET /api/earnings/:driverId?period=today|week|month
 */
router.get('/:driverId', async (req, res) => {
  const { driverId } = req.params;
  const { period = 'today' } = req.query;

  try {
    let startDate: Date;
    const now = new Date();

    // 計算起始日期
    if (period === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === 'week') {
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === 'month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      return res.status(400).json({
        error: '無效的期間參數，請使用 today, week, 或 month'
      });
    }

    // 查詢總收入統計
    const stats = await queryOne(`
      SELECT
        COUNT(*) as order_count,
        COALESCE(SUM(meter_amount), 0) as total_amount,
        COALESCE(SUM(actual_distance_km), 0)::numeric(8,2) as total_distance,
        COALESCE(SUM(actual_duration_min), 0) as total_duration,
        COALESCE(AVG(meter_amount), 0)::numeric(8,2) as average_fare
      FROM orders
      WHERE driver_id = $1
        AND status = 'DONE'
        AND completed_at >= $2
        AND completed_at < $3
    `, [driverId, startDate, now]);

    const earnings: any = {
      period,
      totalAmount: parseInt(String(stats?.total_amount || 0)),
      orderCount: parseInt(String(stats?.order_count || 0)),
      totalDistance: parseFloat(String(stats?.total_distance || 0)),
      totalDuration: Number((stats?.total_duration || 0)) / 60, // 轉換為小時
      averageFare: parseFloat(String(stats?.average_fare || 0))
    };

    // 根據期間類型查詢詳細數據
    if (period === 'today') {
      // 今日訂單列表
      const orders = await queryMany(`
        SELECT
          order_id,
          meter_amount as fare,
          actual_distance_km as distance,
          actual_duration_min as duration,
          completed_at
        FROM orders
        WHERE driver_id = $1
          AND status = 'DONE'
          AND completed_at >= $2
          AND completed_at < $3
        ORDER BY completed_at DESC
      `, [driverId, startDate, now]);

      earnings.orders = orders.map(o => ({
        orderId: o.order_id,
        fare: o.fare,
        distance: parseFloat(String(o.distance)),
        duration: parseFloat((Number(o.duration) / 60).toFixed(2)), // 小時
        completedAt: o.completed_at.getTime()
      }));

    } else if (period === 'week') {
      // 每日統計
      const daily = await queryMany(`
        SELECT
          DATE(completed_at) as date,
          COUNT(*) as orders,
          SUM(meter_amount) as amount
        FROM orders
        WHERE driver_id = $1
          AND status = 'DONE'
          AND completed_at >= $2
          AND completed_at < $3
        GROUP BY DATE(completed_at)
        ORDER BY date DESC
      `, [driverId, startDate, now]);

      earnings.dailyBreakdown = daily.map(d => ({
        date: d.date.toISOString().split('T')[0],
        amount: parseInt(String(d.amount)),
        orders: parseInt(String(d.orders))
      }));

    } else if (period === 'month') {
      // 每週統計
      const weekly = await queryMany(`
        SELECT
          EXTRACT(WEEK FROM completed_at) as week_num,
          COUNT(*) as orders,
          SUM(meter_amount) as amount
        FROM orders
        WHERE driver_id = $1
          AND status = 'DONE'
          AND completed_at >= $2
          AND completed_at < $3
        GROUP BY week_num
        ORDER BY week_num
      `, [driverId, startDate, now]);

      earnings.weeklyBreakdown = weekly.map((w, index) => ({
        week: `第${index + 1}週`,
        amount: parseInt(String(w.amount)),
        orders: parseInt(String(w.orders))
      }));
    }

    console.log(
      `[Earnings] 查詢司機 ${driverId} 的 ${period} 收入：NT$ ${earnings.totalAmount}`
    );

    res.json({
      success: true,
      driverId,
      earnings
    });

  } catch (error) {
    console.error('[Earnings] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 查詢司機的訂單列表（含收入詳情）
 * GET /api/earnings/:driverId/orders?status=DONE&startDate=2025-10-01&endDate=2025-10-31
 */
router.get('/:driverId/orders', async (req, res) => {
  const { driverId } = req.params;
  const { status, startDate, endDate, limit = 50, offset = 0 } = req.query;

  try {
    let sql = `
      SELECT
        o.order_id,
        o.passenger_id,
        o.status,
        o.payment_type,
        o.meter_amount as fare,
        o.actual_distance_km as distance,
        o.actual_duration_min as duration,
        o.pickup_lat,
        o.pickup_lng,
        o.pickup_address,
        o.dest_lat,
        o.dest_lng,
        o.dest_address,
        o.created_at,
        o.accepted_at,
        o.completed_at,
        p.name as passenger_name,
        p.phone as passenger_phone
      FROM orders o
      LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
      WHERE o.driver_id = $1
    `;

    const params: any[] = [driverId];

    // 狀態篩選
    if (status) {
      params.push(status);
      sql += ` AND o.status = $${params.length}`;
    }

    // 日期範圍篩選
    if (startDate) {
      params.push(startDate);
      sql += ` AND o.created_at >= $${params.length}`;
    }

    if (endDate) {
      params.push(endDate);
      sql += ` AND o.created_at <= $${params.length}`;
    }

    params.push(limit, offset);
    sql += ` ORDER BY o.completed_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const orders = await queryMany(sql, params);

    const formattedOrders = orders.map(o => ({
      orderId: o.order_id,
      passengerId: o.passenger_id,
      passengerName: o.passenger_name,
      passengerPhone: o.passenger_phone,
      driverId,
      pickup: {
        lat: parseFloat(String(o.pickup_lat)),
        lng: parseFloat(String(o.pickup_lng)),
        address: o.pickup_address
      },
      destination: o.dest_lat ? {
        lat: parseFloat(String(o.dest_lat)),
        lng: parseFloat(String(o.dest_lng)),
        address: o.dest_address
      } : null,
      status: o.status,
      paymentType: o.payment_type,
      fare: o.fare,
      distance: parseFloat(String(o.distance || 0)),
      duration: o.duration,
      createdAt: o.created_at,
      acceptedAt: o.accepted_at,
      completedAt: o.completed_at
    }));

    console.log(
      `[Earnings] 查詢司機 ${driverId} 的訂單列表，找到 ${formattedOrders.length} 筆`
    );

    res.json({
      success: true,
      orders: formattedOrders,
      total: formattedOrders.length
    });

  } catch (error) {
    console.error('[Earnings Orders] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;

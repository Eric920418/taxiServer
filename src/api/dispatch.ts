/**
 * 智能派單 API 路由
 * 提供 AI 派單引擎的 HTTP 接口
 */

import { Router } from 'express';
import pool from '../db/connection';
import { initDispatcher, getDispatcher } from '../services/ai-dispatcher';
import { getIO } from '../socket';

const router = Router();

// 初始化派單引擎
const dispatcher = initDispatcher(pool);

/**
 * POST /api/dispatch/smart
 * 智能派單 - 根據 AI 引擎推薦最適合的司機
 */
router.post('/smart', async (req, res) => {
  try {
    const { orderId, pickupLat, pickupLng, destLat, destLng, passengerId } = req.body;

    // 驗證必要參數
    if (!orderId || !pickupLat || !pickupLng || !destLat || !destLng) {
      return res.status(400).json({
        success: false,
        error: '缺少必要參數'
      });
    }

    console.log(`\n📋 收到智能派單請求 - 訂單 ${orderId}`);

    // 調用智能派單引擎
    const dispatchResult = await dispatcher.dispatch({
      orderId,
      pickupLat: parseFloat(pickupLat),
      pickupLng: parseFloat(pickupLng),
      destLat: parseFloat(destLat),
      destLng: parseFloat(destLng),
      passengerId
    });

    // 如果找到合適的司機，自動發送派單通知
    if (dispatchResult.recommendedDrivers.length > 0) {
      // 發送給第一位推薦的司機
      const targetDriver = dispatchResult.recommendedDrivers[0];

      // 透過 WebSocket 通知司機
      const io = getIO();
      if (io) {
        io.to(`driver-${targetDriver}`).emit('new-order', {
          orderId,
          pickupLat,
          pickupLng,
          destLat,
          destLng,
          predictedETA: dispatchResult.predictedETA,
          dispatchReason: dispatchResult.reason
        });

        console.log(`   📨 已通知司機 ${targetDriver}`);
      }

      // 記錄派單結果到資料庫（失敗不影響派單）
      try {
        await pool.query(`
          INSERT INTO dispatch_logs (
            order_id,
            dispatched_to,
            dispatch_score,
            dispatch_reason,
            predicted_eta,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, NOW())
        `, [
          orderId,
          targetDriver,
          dispatchResult.score,
          dispatchResult.reason,
          dispatchResult.predictedETA
        ]);
      } catch (logError: any) {
        // 日誌記錄失敗不影響派單結果
        console.log(`   ⚠️ 派單記錄寫入失敗（不影響派單）: ${logError.message}`);
      }
    }

    res.json({
      success: true,
      data: dispatchResult
    });

  } catch (error: any) {
    console.error('智能派單失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/dispatch/stats
 * 獲取派單統計資料
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await dispatcher.getDispatchStats();

    res.json({
      success: true,
      data: stats
    });
  } catch (error: any) {
    console.error('獲取派單統計失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/dispatch/hot-zones
 * 獲取當前熱區資訊
 */
router.get('/hot-zones', async (req, res) => {
  try {
    const currentHour = new Date().getHours();

    // 根據當前時間返回活躍熱區
    const activeHotZones = [
      {
        name: '東大門夜市',
        lat: 23.9986,
        lng: 121.6083,
        active: currentHour >= 18 && currentHour <= 22,
        weight: 1.5
      },
      {
        name: '花蓮火車站',
        lat: 23.9933,
        lng: 121.6011,
        active: (currentHour >= 6 && currentHour <= 9) || (currentHour >= 17 && currentHour <= 18),
        weight: 1.3
      },
      {
        name: '遠百花蓮店',
        lat: 23.9878,
        lng: 121.6061,
        active: currentHour >= 15 && currentHour <= 20,
        weight: 1.2
      },
      {
        name: '太魯閣國家公園',
        lat: 24.1555,
        lng: 121.6207,
        active: (currentHour >= 8 && currentHour <= 10) || (currentHour >= 15 && currentHour <= 16),
        weight: 1.8
      }
    ];

    res.json({
      success: true,
      currentHour,
      hotZones: activeHotZones.filter(zone => zone.active)
    });
  } catch (error: any) {
    console.error('獲取熱區資訊失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/dispatch/driver-earnings
 * 獲取司機今日收入（用於收入平衡監控）
 */
router.get('/driver-earnings', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        d.driver_id,
        d.name,
        COALESCE(SUM(o.meter_amount), 0) as today_earnings,
        COUNT(o.order_id) as today_trips,
        d.availability as current_status
      FROM drivers d
      LEFT JOIN orders o ON d.driver_id = o.driver_id
        AND o.status = 'DONE'
        AND DATE(o.completed_at) = CURRENT_DATE
      GROUP BY d.driver_id, d.name, d.availability
      ORDER BY today_earnings DESC
    `);

    // 計算平均收入
    const earnings = result.rows.map((r: any) => parseFloat(r.today_earnings));
    const avgEarnings = earnings.reduce((sum: number, e: number) => sum + e, 0) / earnings.length || 0;
    const minEarnings = Math.min(...earnings);
    const maxEarnings = Math.max(...earnings);

    res.json({
      success: true,
      data: {
        drivers: result.rows,
        statistics: {
          average: Math.round(avgEarnings),
          minimum: minEarnings,
          maximum: maxEarnings,
          gap: maxEarnings - minEarnings
        }
      }
    });
  } catch (error: any) {
    console.error('獲取司機收入失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/dispatch/simulate
 * 模擬派單（測試用）
 */
router.post('/simulate', async (req, res) => {
  try {
    const { count = 10 } = req.body;

    // 從歷史訂單中隨機選取進行模擬
    const orders = await pool.query(`
      SELECT
        order_id,
        pickup_lat,
        pickup_lng,
        dest_lat,
        dest_lng,
        passenger_id
      FROM orders
      ORDER BY RANDOM()
      LIMIT $1
    `, [count]);

    const results = [];
    for (const order of orders.rows) {
      const dispatchResult = await dispatcher.dispatch({
        orderId: `SIM-${order.order_id}`,
        pickupLat: parseFloat(order.pickup_lat),
        pickupLng: parseFloat(order.pickup_lng),
        destLat: parseFloat(order.dest_lat),
        destLng: parseFloat(order.dest_lng),
        passengerId: order.passenger_id
      });

      results.push({
        orderId: order.order_id,
        result: dispatchResult
      });
    }

    res.json({
      success: true,
      simulationCount: count,
      results
    });
  } catch (error: any) {
    console.error('模擬派單失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
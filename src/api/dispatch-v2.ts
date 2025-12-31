/**
 * 智能派單系統 V2 - 監控與管理 API
 *
 * 端點：
 * - GET /api/dispatch/v2/stats - 派單統計
 * - GET /api/dispatch/v2/driver-patterns/:driverId - 司機行為模式
 * - POST /api/dispatch/v2/retrain-model - 手動觸發 ML 重訓練
 * - GET /api/dispatch/v2/eta-cache-stats - ETA 快取統計
 * - GET /api/dispatch/v2/rejection-analysis - 拒單分析
 * - GET /api/dispatch/v2/active-orders - 活動訂單
 */

import { Router } from 'express';
import { query, queryOne, queryMany } from '../db/connection';
import { getSmartDispatcherV2 } from '../services/SmartDispatcherV2';
import { getETAService } from '../services/ETAService';
import { getRejectionPredictor } from '../services/RejectionPredictor';

const router = Router();

/**
 * 派單系統統計
 * GET /api/dispatch/v2/stats
 */
router.get('/stats', async (req, res) => {
  const { days = 7 } = req.query;

  try {
    // 派單成功率
    const dispatchStats = await queryOne(`
      SELECT
        COUNT(*) as total_orders,
        COUNT(*) FILTER (WHERE status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP', 'DONE')) as accepted_orders,
        COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled_orders,
        AVG(reject_count) as avg_reject_count,
        AVG(offered_to_count) as avg_offered_count
      FROM orders
      WHERE created_at > NOW() - INTERVAL '${parseInt(days as string)} days'
    `);

    // 平均接單時間
    const responseTimeStats = await queryOne(`
      SELECT
        AVG(EXTRACT(EPOCH FROM (accepted_at - offered_at))) as avg_response_seconds,
        MIN(EXTRACT(EPOCH FROM (accepted_at - offered_at))) as min_response_seconds,
        MAX(EXTRACT(EPOCH FROM (accepted_at - offered_at))) as max_response_seconds
      FROM orders
      WHERE status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP', 'DONE')
        AND accepted_at IS NOT NULL
        AND offered_at IS NOT NULL
        AND created_at > NOW() - INTERVAL '${parseInt(days as string)} days'
    `);

    // 各批次成功率（從派單日誌）
    const batchStats = await queryMany(`
      SELECT
        batch_number,
        COUNT(*) as total,
        COUNT(accepted_by) as accepted
      FROM dispatch_logs
      WHERE created_at > NOW() - INTERVAL '${parseInt(days as string)} days'
      GROUP BY batch_number
      ORDER BY batch_number
    `);

    // 拒單原因分佈
    const rejectionStats = await queryMany(`
      SELECT
        rejection_reason,
        COUNT(*) as count,
        ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER(), 2) as percentage
      FROM order_rejections
      WHERE created_at > NOW() - INTERVAL '${parseInt(days as string)} days'
      GROUP BY rejection_reason
      ORDER BY count DESC
    `);

    // 時段派單量
    const hourlyStats = await queryMany(`
      SELECT
        hour_of_day,
        COUNT(*) as orders,
        COUNT(*) FILTER (WHERE status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP', 'DONE')) as accepted
      FROM orders
      WHERE created_at > NOW() - INTERVAL '${parseInt(days as string)} days'
      GROUP BY hour_of_day
      ORDER BY hour_of_day
    `);

    const totalOrders = parseInt(dispatchStats.total_orders) || 0;
    const acceptedOrders = parseInt(dispatchStats.accepted_orders) || 0;

    res.json({
      success: true,
      period: `${days} days`,
      overview: {
        totalOrders,
        acceptedOrders,
        cancelledOrders: parseInt(dispatchStats.cancelled_orders) || 0,
        successRate: totalOrders > 0 ? ((acceptedOrders / totalOrders) * 100).toFixed(2) + '%' : 'N/A',
        avgRejectCount: parseFloat(dispatchStats.avg_reject_count)?.toFixed(2) || '0',
        avgOfferedCount: parseFloat(dispatchStats.avg_offered_count)?.toFixed(2) || '0',
      },
      responseTime: {
        avgSeconds: parseFloat(responseTimeStats.avg_response_seconds)?.toFixed(1) || null,
        minSeconds: parseFloat(responseTimeStats.min_response_seconds)?.toFixed(1) || null,
        maxSeconds: parseFloat(responseTimeStats.max_response_seconds)?.toFixed(1) || null,
      },
      batchPerformance: batchStats.map(b => ({
        batch: b.batch_number,
        total: parseInt(b.total),
        accepted: parseInt(b.accepted),
        successRate: ((parseInt(b.accepted) / parseInt(b.total)) * 100).toFixed(1) + '%',
      })),
      rejectionReasons: rejectionStats.map(r => ({
        reason: r.rejection_reason,
        count: parseInt(r.count),
        percentage: parseFloat(r.percentage) + '%',
      })),
      hourlyDistribution: hourlyStats.map(h => ({
        hour: h.hour_of_day,
        orders: parseInt(h.orders),
        accepted: parseInt(h.accepted),
      })),
    });
  } catch (error) {
    console.error('[Dispatch Stats] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 司機行為模式
 * GET /api/dispatch/v2/driver-patterns/:driverId
 */
router.get('/driver-patterns/:driverId', async (req, res) => {
  const { driverId } = req.params;

  try {
    // 獲取司機模式
    const pattern = await queryOne(`
      SELECT * FROM driver_patterns WHERE driver_id = $1
    `, [driverId]);

    // 獲取司機基本資訊
    const driver = await queryOne(`
      SELECT
        driver_id, name, acceptance_rate, cancel_rate, rating, total_trips, driver_type
      FROM drivers
      WHERE driver_id = $1
    `, [driverId]);

    if (!driver) {
      return res.status(404).json({ error: '司機不存在' });
    }

    // 最近拒單記錄
    const recentRejections = await queryMany(`
      SELECT
        rejection_reason,
        distance_to_pickup,
        hour_of_day,
        created_at
      FROM order_rejections
      WHERE driver_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [driverId]);

    res.json({
      success: true,
      driver: {
        driverId: driver.driver_id,
        name: driver.name,
        acceptanceRate: parseFloat(driver.acceptance_rate),
        cancelRate: parseFloat(driver.cancel_rate),
        rating: parseFloat(driver.rating),
        totalTrips: parseInt(driver.total_trips),
        driverType: driver.driver_type,
      },
      pattern: pattern ? {
        hourlyAcceptance: pattern.hourly_acceptance,
        zoneAcceptance: pattern.zone_acceptance,
        avgAcceptedDistance: parseFloat(pattern.avg_accepted_distance),
        maxAcceptedDistance: parseFloat(pattern.max_accepted_distance),
        shortTripRate: parseFloat(pattern.short_trip_rate),
        longTripRate: parseFloat(pattern.long_trip_rate),
        earningsThreshold: parseInt(pattern.earnings_threshold),
        driverType: pattern.driver_type,
        lastCalculatedAt: pattern.last_calculated_at,
        dataPoints: parseInt(pattern.data_points),
      } : null,
      recentRejections: recentRejections.map(r => ({
        reason: r.rejection_reason,
        distance: parseFloat(r.distance_to_pickup),
        hour: r.hour_of_day,
        timestamp: r.created_at,
      })),
    });
  } catch (error) {
    console.error('[Driver Patterns] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 更新司機行為模式
 * POST /api/dispatch/v2/driver-patterns/:driverId/refresh
 */
router.post('/driver-patterns/:driverId/refresh', async (req, res) => {
  const { driverId } = req.params;

  try {
    const predictor = getRejectionPredictor();
    await predictor.updateDriverPattern(driverId);

    res.json({
      success: true,
      message: `已更新司機 ${driverId} 的行為模式`,
    });
  } catch (error) {
    console.error('[Refresh Pattern] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 手動觸發 ML 重訓練
 * POST /api/dispatch/v2/retrain-model
 */
router.post('/retrain-model', async (req, res) => {
  try {
    const predictor = getRejectionPredictor();
    const stats = predictor.getStats();

    if (stats.isTraining) {
      return res.status(409).json({
        error: 'TRAINING_IN_PROGRESS',
        message: '模型正在訓練中，請稍後再試',
      });
    }

    // 非同步訓練
    predictor.trainModel().then(success => {
      console.log(`[Retrain] 訓練${success ? '成功' : '失敗'}`);
    });

    res.json({
      success: true,
      message: '已開始重新訓練模型（背景執行）',
    });
  } catch (error) {
    console.error('[Retrain Model] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 更新所有司機模式
 * POST /api/dispatch/v2/driver-patterns/refresh-all
 */
router.post('/driver-patterns/refresh-all', async (req, res) => {
  try {
    const predictor = getRejectionPredictor();

    // 非同步執行
    predictor.updateAllDriverPatterns().then(() => {
      console.log('[Refresh All] 完成更新所有司機模式');
    });

    res.json({
      success: true,
      message: '已開始更新所有司機行為模式（背景執行）',
    });
  } catch (error) {
    console.error('[Refresh All Patterns] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * ETA 快取統計
 * GET /api/dispatch/v2/eta-cache-stats
 */
router.get('/eta-cache-stats', async (req, res) => {
  try {
    const etaService = getETAService();
    const stats = await etaService.getCacheStats();

    res.json({
      success: true,
      cache: stats,
    });
  } catch (error) {
    console.error('[ETA Cache Stats] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 拒單分析
 * GET /api/dispatch/v2/rejection-analysis
 */
router.get('/rejection-analysis', async (req, res) => {
  const { days = 7 } = req.query;

  try {
    // 高拒單率司機
    const highRejectionDrivers = await queryMany(`
      SELECT
        d.driver_id,
        d.name,
        d.acceptance_rate,
        COUNT(r.rejection_id) as rejection_count
      FROM drivers d
      LEFT JOIN order_rejections r ON d.driver_id = r.driver_id
        AND r.created_at > NOW() - INTERVAL '${parseInt(days as string)} days'
      GROUP BY d.driver_id, d.name, d.acceptance_rate
      HAVING COUNT(r.rejection_id) > 5
      ORDER BY COUNT(r.rejection_id) DESC
      LIMIT 20
    `);

    // 拒單熱點時段
    const rejectionByHour = await queryMany(`
      SELECT
        hour_of_day,
        COUNT(*) as rejections,
        AVG(distance_to_pickup) as avg_distance
      FROM order_rejections
      WHERE created_at > NOW() - INTERVAL '${parseInt(days as string)} days'
      GROUP BY hour_of_day
      ORDER BY rejections DESC
    `);

    // 拒單距離分析
    const distanceAnalysis = await queryOne(`
      SELECT
        AVG(distance_to_pickup) as avg_distance,
        MIN(distance_to_pickup) as min_distance,
        MAX(distance_to_pickup) as max_distance,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY distance_to_pickup) as median_distance
      FROM order_rejections
      WHERE created_at > NOW() - INTERVAL '${parseInt(days as string)} days'
        AND distance_to_pickup IS NOT NULL
    `);

    res.json({
      success: true,
      period: `${days} days`,
      highRejectionDrivers: highRejectionDrivers.map(d => ({
        driverId: d.driver_id,
        name: d.name,
        acceptanceRate: parseFloat(d.acceptance_rate),
        rejectionCount: parseInt(d.rejection_count),
      })),
      rejectionByHour: rejectionByHour.map(h => ({
        hour: h.hour_of_day,
        rejections: parseInt(h.rejections),
        avgDistance: parseFloat(h.avg_distance)?.toFixed(2),
      })),
      distanceAnalysis: {
        avgKm: parseFloat(distanceAnalysis.avg_distance)?.toFixed(2),
        minKm: parseFloat(distanceAnalysis.min_distance)?.toFixed(2),
        maxKm: parseFloat(distanceAnalysis.max_distance)?.toFixed(2),
        medianKm: parseFloat(distanceAnalysis.median_distance)?.toFixed(2),
      },
    });
  } catch (error) {
    console.error('[Rejection Analysis] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 活動訂單
 * GET /api/dispatch/v2/active-orders
 */
router.get('/active-orders', async (req, res) => {
  try {
    const dispatcher = getSmartDispatcherV2();
    const stats = dispatcher.getActiveOrdersStats();

    res.json({
      success: true,
      ...stats,
    });
  } catch (error) {
    console.error('[Active Orders] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * ML 模型狀態
 * GET /api/dispatch/v2/model-status
 */
router.get('/model-status', async (req, res) => {
  try {
    const predictor = getRejectionPredictor();
    const stats = predictor.getStats();

    res.json({
      success: true,
      model: stats,
    });
  } catch (error) {
    console.error('[Model Status] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 派單日誌
 * GET /api/dispatch/v2/logs
 */
router.get('/logs', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  try {
    const logs = await queryMany(`
      SELECT
        dl.*,
        o.status as order_status,
        o.pickup_address
      FROM dispatch_logs dl
      LEFT JOIN orders o ON dl.order_id = o.order_id
      ORDER BY dl.created_at DESC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit as string), parseInt(offset as string)]);

    res.json({
      success: true,
      logs: logs.map(l => ({
        logId: l.log_id,
        orderId: l.order_id,
        batchNumber: l.batch_number,
        recommendedDrivers: l.recommended_drivers,
        weightConfig: l.weight_config,
        hourOfDay: l.hour_of_day,
        dayOfWeek: l.day_of_week,
        demandLevel: l.demand_level,
        acceptedBy: l.accepted_by,
        responseTimeMs: l.response_time_ms,
        orderStatus: l.order_status,
        pickupAddress: l.pickup_address,
        createdAt: l.created_at,
      })),
    });
  } catch (error) {
    console.error('[Dispatch Logs] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;

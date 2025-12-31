/**
 * 資料聚合服務
 * 提供高效的資料統計和分析功能
 */

import { query } from '../db/connection-advanced';
import * as cache from './cache';
import logger, { performanceLogger } from './logger';
import { analyticsQueue } from './queue';

// ============================================
// 即時統計聚合
// ============================================

export class RealtimeAggregator {
  private aggregates: Map<string, any> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;

  /**
   * 啟動即時聚合
   */
  start(intervalMs: number = 5000) {
    if (this.updateInterval) {
      return;
    }

    this.updateInterval = setInterval(() => {
      this.updateAggregates();
    }, intervalMs);

    // 立即執行一次
    this.updateAggregates();
    logger.info('Realtime aggregator started');
  }

  /**
   * 停止即時聚合
   */
  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      logger.info('Realtime aggregator stopped');
    }
  }

  /**
   * 更新聚合數據
   */
  private async updateAggregates() {
    try {
      const [
        systemStats,
        driverStats,
        orderStats,
        revenueStats
      ] = await Promise.all([
        this.aggregateSystemStats(),
        this.aggregateDriverStats(),
        this.aggregateOrderStats(),
        this.aggregateRevenueStats()
      ]);

      this.aggregates.set('system', systemStats);
      this.aggregates.set('drivers', driverStats);
      this.aggregates.set('orders', orderStats);
      this.aggregates.set('revenue', revenueStats);

      // 快取聚合結果
      await cache.cacheApiResponse('aggregates:realtime', Object.fromEntries(this.aggregates), 30);
    } catch (error) {
      logger.error('Failed to update aggregates', error);
    }
  }

  /**
   * 聚合系統統計
   */
  private async aggregateSystemStats() {
    const result = await query(`
      SELECT
        (SELECT COUNT(*) FROM drivers WHERE availability = 'AVAILABLE') as available_drivers,
        (SELECT COUNT(*) FROM drivers WHERE availability = 'ON_TRIP') as busy_drivers,
        (SELECT COUNT(*) FROM orders WHERE status = 'IN_PROGRESS') as active_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'OFFERED' AND created_at > NOW() - INTERVAL '5 minutes') as pending_orders,
        (SELECT COUNT(DISTINCT passenger_id) FROM orders WHERE created_at > NOW() - INTERVAL '1 hour') as active_passengers
    `, [], { useReplica: true });

    return result.rows[0];
  }

  /**
   * 聚合司機統計
   */
  private async aggregateDriverStats() {
    const result = await query(`
      WITH driver_metrics AS (
        SELECT
          d.driver_id,
          d.name,
          d.rating,
          COUNT(o.order_id) as today_trips,
          COALESCE(SUM(o.total_amount), 0) as today_revenue,
          AVG(o.actual_duration_min) as avg_trip_duration
        FROM drivers d
        LEFT JOIN orders o ON d.driver_id = o.driver_id
          AND o.status = 'COMPLETED'
          AND DATE(o.completed_at) = CURRENT_DATE
        WHERE d.availability != 'OFFLINE'
        GROUP BY d.driver_id, d.name, d.rating
      )
      SELECT
        COUNT(*) as total_active,
        AVG(rating) as avg_rating,
        SUM(today_trips) as total_trips_today,
        SUM(today_revenue) as total_revenue_today,
        AVG(avg_trip_duration) as avg_trip_duration,
        json_agg(json_build_object(
          'driver_id', driver_id,
          'name', name,
          'trips', today_trips,
          'revenue', today_revenue
        ) ORDER BY today_revenue DESC LIMIT 5) as top_performers
      FROM driver_metrics
    `, [], { useReplica: true });

    return result.rows[0];
  }

  /**
   * 聚合訂單統計
   */
  private async aggregateOrderStats() {
    const result = await query(`
      WITH hourly_orders AS (
        SELECT
          EXTRACT(HOUR FROM created_at) as hour,
          COUNT(*) as count,
          AVG(total_amount) as avg_amount
        FROM orders
        WHERE created_at > CURRENT_DATE
        GROUP BY EXTRACT(HOUR FROM created_at)
      )
      SELECT
        (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURRENT_DATE) as today_total,
        (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURRENT_DATE AND status = 'COMPLETED') as today_completed,
        (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURRENT_DATE AND status = 'CANCELLED') as today_cancelled,
        (SELECT AVG(EXTRACT(EPOCH FROM (accepted_at - offered_at))/60)
         FROM orders WHERE accepted_at IS NOT NULL AND DATE(created_at) = CURRENT_DATE) as avg_acceptance_time,
        (SELECT AVG(actual_duration_min) FROM orders WHERE status = 'COMPLETED' AND DATE(completed_at) = CURRENT_DATE) as avg_duration,
        json_agg(json_build_object('hour', hour, 'count', count, 'avg_amount', avg_amount) ORDER BY hour) as hourly_distribution
      FROM hourly_orders
    `, [], { useReplica: true });

    return result.rows[0];
  }

  /**
   * 聚合營收統計
   */
  private async aggregateRevenueStats() {
    const result = await query(`
      WITH daily_revenue AS (
        SELECT
          DATE(completed_at) as date,
          SUM(total_amount) as revenue,
          COUNT(*) as orders
        FROM orders
        WHERE status = 'COMPLETED'
          AND completed_at > CURRENT_DATE - INTERVAL '7 days'
        GROUP BY DATE(completed_at)
      )
      SELECT
        (SELECT SUM(total_amount) FROM orders WHERE status = 'COMPLETED' AND DATE(completed_at) = CURRENT_DATE) as today,
        (SELECT SUM(total_amount) FROM orders WHERE status = 'COMPLETED' AND DATE(completed_at) = CURRENT_DATE - 1) as yesterday,
        (SELECT SUM(total_amount) FROM orders WHERE status = 'COMPLETED' AND completed_at > CURRENT_DATE - INTERVAL '7 days') as week_total,
        (SELECT SUM(total_amount) FROM orders WHERE status = 'COMPLETED' AND completed_at > CURRENT_DATE - INTERVAL '30 days') as month_total,
        json_agg(json_build_object('date', date, 'revenue', revenue, 'orders', orders) ORDER BY date DESC) as daily_trend
      FROM daily_revenue
    `, [], { useReplica: true });

    return result.rows[0];
  }

  /**
   * 取得聚合數據
   */
  getAggregates(key?: string) {
    if (key) {
      return this.aggregates.get(key);
    }
    return Object.fromEntries(this.aggregates);
  }
}

// ============================================
// 批次聚合處理
// ============================================

export class BatchAggregator {
  /**
   * 執行每日聚合
   */
  static async runDailyAggregation() {
    const timer = performanceLogger.startTimer('daily_aggregation');

    try {
      // 聚合司機每日統計
      await this.aggregateDriverDaily();

      // 聚合訂單每日統計
      await this.aggregateOrderDaily();

      // 聚合熱區統計
      await this.aggregateHotZones();

      // 清理舊資料
      await this.cleanupOldData();

      timer.end({ status: 'success' });
      logger.info('Daily aggregation completed');
    } catch (error) {
      timer.end({ status: 'error' });
      logger.error('Daily aggregation failed', error);
      throw error;
    }
  }

  /**
   * 聚合司機每日統計
   */
  private static async aggregateDriverDaily() {
    const result = await query(`
      INSERT INTO driver_daily_stats (
        driver_id, date, total_trips, total_revenue, total_distance,
        total_duration, avg_rating, acceptance_rate, online_hours
      )
      SELECT
        driver_id,
        CURRENT_DATE - 1 as date,
        COUNT(*) as total_trips,
        SUM(total_amount) as total_revenue,
        SUM(actual_distance_km) as total_distance,
        SUM(actual_duration_min) as total_duration,
        AVG(rating) as avg_rating,
        COUNT(CASE WHEN status != 'REJECTED' THEN 1 END)::float / NULLIF(COUNT(*), 0) * 100 as acceptance_rate,
        EXTRACT(EPOCH FROM (MAX(completed_at) - MIN(accepted_at)))/3600 as online_hours
      FROM orders
      WHERE driver_id IS NOT NULL
        AND DATE(created_at) = CURRENT_DATE - 1
      GROUP BY driver_id
      ON CONFLICT (driver_id, date) DO UPDATE SET
        total_trips = EXCLUDED.total_trips,
        total_revenue = EXCLUDED.total_revenue,
        total_distance = EXCLUDED.total_distance,
        total_duration = EXCLUDED.total_duration,
        avg_rating = EXCLUDED.avg_rating,
        acceptance_rate = EXCLUDED.acceptance_rate,
        online_hours = EXCLUDED.online_hours
    `, [], { useReplica: false });

    logger.info(`Aggregated daily stats for ${result.rowCount} drivers`);
  }

  /**
   * 聚合訂單每日統計
   */
  private static async aggregateOrderDaily() {
    const result = await query(`
      INSERT INTO order_daily_stats (
        date, total_orders, completed_orders, cancelled_orders,
        total_revenue, avg_distance, avg_duration, avg_amount,
        peak_hour, unique_drivers, unique_passengers
      )
      SELECT
        CURRENT_DATE - 1 as date,
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed_orders,
        COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_orders,
        SUM(CASE WHEN status = 'COMPLETED' THEN total_amount ELSE 0 END) as total_revenue,
        AVG(actual_distance_km) as avg_distance,
        AVG(actual_duration_min) as avg_duration,
        AVG(total_amount) as avg_amount,
        MODE() WITHIN GROUP (ORDER BY EXTRACT(HOUR FROM created_at)) as peak_hour,
        COUNT(DISTINCT driver_id) as unique_drivers,
        COUNT(DISTINCT passenger_id) as unique_passengers
      FROM orders
      WHERE DATE(created_at) = CURRENT_DATE - 1
      ON CONFLICT (date) DO UPDATE SET
        total_orders = EXCLUDED.total_orders,
        completed_orders = EXCLUDED.completed_orders,
        cancelled_orders = EXCLUDED.cancelled_orders,
        total_revenue = EXCLUDED.total_revenue,
        avg_distance = EXCLUDED.avg_distance,
        avg_duration = EXCLUDED.avg_duration,
        avg_amount = EXCLUDED.avg_amount,
        peak_hour = EXCLUDED.peak_hour,
        unique_drivers = EXCLUDED.unique_drivers,
        unique_passengers = EXCLUDED.unique_passengers
    `, [], { useReplica: false });

    logger.info('Aggregated daily order statistics');
  }

  /**
   * 聚合熱區統計
   */
  private static async aggregateHotZones() {
    const result = await query(`
      INSERT INTO hotzone_stats (date, zone_lat, zone_lng, order_count, avg_wait_time, avg_revenue)
      SELECT
        CURRENT_DATE - 1 as date,
        ROUND(pickup_lat::numeric, 2) as zone_lat,
        ROUND(pickup_lng::numeric, 2) as zone_lng,
        COUNT(*) as order_count,
        AVG(EXTRACT(EPOCH FROM (accepted_at - offered_at))/60) as avg_wait_time,
        AVG(total_amount) as avg_revenue
      FROM orders
      WHERE DATE(created_at) = CURRENT_DATE - 1
        AND status = 'COMPLETED'
      GROUP BY ROUND(pickup_lat::numeric, 2), ROUND(pickup_lng::numeric, 2)
      HAVING COUNT(*) >= 5
      ON CONFLICT (date, zone_lat, zone_lng) DO UPDATE SET
        order_count = EXCLUDED.order_count,
        avg_wait_time = EXCLUDED.avg_wait_time,
        avg_revenue = EXCLUDED.avg_revenue
    `, [], { useReplica: false });

    logger.info(`Aggregated ${result.rowCount} hot zones`);
  }

  /**
   * 清理舊資料
   */
  private static async cleanupOldData() {
    // 刪除超過 90 天的詳細記錄
    const result = await query(`
      DELETE FROM orders
      WHERE created_at < CURRENT_DATE - INTERVAL '90 days'
        AND status IN ('CANCELLED', 'TIMEOUT')
    `, [], { useReplica: false });

    logger.info(`Cleaned up ${result.rowCount} old records`);
  }
}

// ============================================
// 視窗聚合
// ============================================

export class WindowAggregator {
  private windows: Map<string, any[]> = new Map();

  /**
   * 添加資料到視窗
   */
  add(key: string, value: any, windowSizeMs: number = 60000) {
    if (!this.windows.has(key)) {
      this.windows.set(key, []);
    }

    const window = this.windows.get(key)!;
    const now = Date.now();

    // 添加新值
    window.push({ value, timestamp: now });

    // 清理過期值
    const cutoff = now - windowSizeMs;
    const filtered = window.filter(item => item.timestamp >= cutoff);
    this.windows.set(key, filtered);
  }

  /**
   * 取得視窗統計
   */
  getStats(key: string) {
    const window = this.windows.get(key) || [];
    const values = window.map(item => item.value);

    if (values.length === 0) {
      return null;
    }

    const numbers = values.filter(v => typeof v === 'number');

    return {
      count: values.length,
      sum: numbers.reduce((a, b) => a + b, 0),
      avg: numbers.reduce((a, b) => a + b, 0) / numbers.length,
      min: Math.min(...numbers),
      max: Math.max(...numbers),
      first: values[0],
      last: values[values.length - 1]
    };
  }

  /**
   * 清除視窗
   */
  clear(key?: string) {
    if (key) {
      this.windows.delete(key);
    } else {
      this.windows.clear();
    }
  }
}

// ============================================
// 預測性聚合
// ============================================

export class PredictiveAggregator {
  /**
   * 預測下一小時訂單量
   */
  static async predictNextHourOrders(): Promise<number> {
    const result = await query(`
      WITH historical_data AS (
        SELECT
          EXTRACT(HOUR FROM created_at) as hour,
          EXTRACT(DOW FROM created_at) as day_of_week,
          COUNT(*) as order_count
        FROM orders
        WHERE created_at > CURRENT_DATE - INTERVAL '30 days'
        GROUP BY EXTRACT(HOUR FROM created_at), EXTRACT(DOW FROM created_at)
      )
      SELECT
        AVG(order_count) as predicted_orders
      FROM historical_data
      WHERE hour = EXTRACT(HOUR FROM NOW() + INTERVAL '1 hour')
        AND day_of_week = EXTRACT(DOW FROM NOW())
    `, [], { useReplica: true });

    return Math.round(result.rows[0]?.predicted_orders || 0);
  }

  /**
   * 預測熱區
   */
  static async predictHotZones(): Promise<any[]> {
    const currentHour = new Date().getHours();
    const dayOfWeek = new Date().getDay();

    const result = await query(`
      SELECT
        zone_lat,
        zone_lng,
        AVG(order_count) as predicted_orders,
        AVG(avg_revenue) as predicted_revenue
      FROM hotzone_stats
      WHERE EXTRACT(HOUR FROM date) = $1
        AND EXTRACT(DOW FROM date) = $2
      GROUP BY zone_lat, zone_lng
      ORDER BY AVG(order_count) DESC
      LIMIT 10
    `, [currentHour, dayOfWeek], { useReplica: true });

    return result.rows;
  }

  /**
   * 預測司機需求
   */
  static async predictDriverDemand(): Promise<any> {
    const result = await query(`
      WITH demand_analysis AS (
        SELECT
          EXTRACT(HOUR FROM created_at) as hour,
          COUNT(*) as orders,
          COUNT(DISTINCT driver_id) as drivers,
          AVG(EXTRACT(EPOCH FROM (accepted_at - offered_at))/60) as avg_wait
        FROM orders
        WHERE created_at > CURRENT_DATE - INTERVAL '7 days'
        GROUP BY EXTRACT(HOUR FROM created_at)
      )
      SELECT
        hour,
        orders,
        drivers,
        avg_wait,
        CASE
          WHEN avg_wait > 5 THEN 'HIGH'
          WHEN avg_wait > 3 THEN 'MEDIUM'
          ELSE 'LOW'
        END as demand_level,
        GREATEST(0, ROUND((orders::float / NULLIF(drivers, 0) - 1) * 10)) as additional_drivers_needed
      FROM demand_analysis
      WHERE hour = EXTRACT(HOUR FROM NOW())
    `, [], { useReplica: true });

    return result.rows[0];
  }
}

// ============================================
// 單例實例
// ============================================

export const realtimeAggregator = new RealtimeAggregator();
export const windowAggregator = new WindowAggregator();

// 排程每日聚合
export function scheduleDailyAggregation() {
  analyticsQueue.add(
    'daily-aggregation',
    {},
    { repeat: { cron: '0 1 * * *' } } // 每天凌晨 1 點執行
  );
}

export default {
  RealtimeAggregator,
  BatchAggregator,
  WindowAggregator,
  PredictiveAggregator,
  realtimeAggregator,
  windowAggregator,
  scheduleDailyAggregation
};
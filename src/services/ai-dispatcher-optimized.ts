/**
 * 花蓮計程車系統 - 智能派單引擎 2.0 (優化版)
 * 優化查詢效能，加入快取機制
 */

import { Pool } from 'pg';
import { Driver, Order, Location } from '../types';
import * as cache from './cache';
import logger, { dispatchLogger, performanceLogger } from './logger';

// ============================================
// 配置參數（基於數據分析結果）
// ============================================

// 熱區定義（基於分析報告）
const HOT_ZONES = {
  '東大門夜市': {
    lat: 23.9986,
    lng: 121.6083,
    radius: 1, // km
    peakHours: [18, 19, 20, 21, 22],
    weight: 1.5
  },
  '花蓮火車站': {
    lat: 23.9933,
    lng: 121.6011,
    radius: 0.8,
    peakHours: [6, 7, 8, 9, 17, 18],
    weight: 1.3
  },
  '遠百花蓮店': {
    lat: 23.9878,
    lng: 121.6061,
    radius: 0.5,
    peakHours: [15, 16, 17, 18, 19, 20],
    weight: 1.2
  },
  '太魯閣國家公園': {
    lat: 24.1555,
    lng: 121.6207,
    radius: 2,
    peakHours: [8, 9, 10, 15, 16],
    weight: 1.8 // 高單價路線
  }
};

// 黃金時段定義（基於營收分析）
const GOLDEN_HOURS: Record<number, { revenueBoost: number; priorityLevel: string }> = {
  19: { revenueBoost: 1.5, priorityLevel: 'HIGH' },
  15: { revenueBoost: 1.4, priorityLevel: 'HIGH' },
  17: { revenueBoost: 1.2, priorityLevel: 'MEDIUM' },
  7:  { revenueBoost: 1.2, priorityLevel: 'MEDIUM' },
  22: { revenueBoost: 1.3, priorityLevel: 'MEDIUM' }
};

// 司機類型（基於效率分析）
enum DriverType {
  FAST_TURNOVER = 'FAST_TURNOVER',     // 張師傅型：快速週轉
  LONG_DISTANCE = 'LONG_DISTANCE',     // 李師傅型：長距離專家
  HIGH_VOLUME = 'HIGH_VOLUME'          // 王師傅型：訂單量大
}

// ============================================
// 智能派單引擎主類（優化版）
// ============================================

export class OptimizedSmartDispatcher {
  private pool: Pool;
  private dailyEarningsCache: Map<string, number> = new Map();
  private lastCacheUpdate: Date = new Date();
  private driverStatsCache: Map<string, any> = new Map();

  constructor(pool: Pool) {
    this.pool = pool;
    // 每小時更新收入緩存
    setInterval(() => this.updateAllCaches(), 3600000);
    // 初始化快取
    this.updateAllCaches();
  }

  /**
   * 主派單方法 - 智能選擇最適合的司機
   */
  async dispatch(order: {
    orderId: string;
    pickupLat: number;
    pickupLng: number;
    destLat: number;
    destLng: number;
    passengerId: string;
  }): Promise<{
    recommendedDrivers: string[];
    reason: string;
    predictedETA: number;
    score: number;
  }> {
    const timer = performanceLogger.startTimer('dispatch');
    dispatchLogger.info(`智能派單引擎啟動 - 訂單 ${order.orderId}`);

    const currentHour = new Date().getHours();
    const orderDistance = this.calculateDistance(
      order.pickupLat, order.pickupLng,
      order.destLat, order.destLng
    );

    // 1. 獲取可用司機（優化版）
    const availableDrivers = await this.getAvailableDriversOptimized();
    dispatchLogger.info(`找到 ${availableDrivers.length} 位可用司機`);

    if (availableDrivers.length === 0) {
      timer.end({ status: 'no_drivers' });
      return {
        recommendedDrivers: [],
        reason: '目前沒有可用司機',
        predictedETA: -1,
        score: 0
      };
    }

    // 2. 批次獲取司機收入（優化版）
    await this.batchLoadDriverEarnings(availableDrivers.map(d => d.driverId));

    // 3. 計算每位司機的評分
    const scoredDrivers = await Promise.all(
      availableDrivers.map(async (driver) => {
        const score = await this.calculateDriverScoreOptimized(driver, order, currentHour, orderDistance);
        return { driver, score };
      })
    );

    // 4. 排序並選出前3名
    scoredDrivers.sort((a, b) => b.score.total - a.score.total);
    const top3 = scoredDrivers.slice(0, 3);

    // 5. 預測 ETA
    const predictedETA = this.predictETA(
      order.pickupLat, order.pickupLng,
      top3[0].driver.currentLat, top3[0].driver.currentLng,
      currentHour
    );

    // 6. 生成推薦原因
    const reason = this.generateDispatchReason(top3[0].score);

    dispatchLogger.info(`派單完成`, {
      orderId: order.orderId,
      recommendedDrivers: top3.map(d => d.driver.driverId),
      topScore: top3[0].score.total,
      predictedETA
    });

    timer.end({ status: 'success', drivers: top3.length });

    return {
      recommendedDrivers: top3.map(d => d.driver.driverId),
      reason,
      predictedETA,
      score: top3[0].score.total
    };
  }

  /**
   * 優化版：獲取可用司機（使用快取）
   */
  private async getAvailableDriversOptimized(): Promise<any[]> {
    // 先嘗試從快取獲取
    const cachedDrivers = await cache.getCachedApiResponse('available-drivers');

    if (cachedDrivers && Array.isArray(cachedDrivers)) {
      // 檢查快取是否仍然有效（30秒內）
      const cacheAge = Date.now() - (cachedDrivers as any)._timestamp;
      if (cacheAge < 30000) {
        dispatchLogger.debug('使用快取的可用司機列表');
        return cachedDrivers;
      }
    }

    // 優化的SQL查詢（使用索引）
    const result = await this.pool.query(`
      WITH recent_stats AS (
        SELECT
          driver_id,
          AVG(actual_duration_min) as avg_trip_duration,
          AVG(actual_distance_km) as avg_trip_distance,
          COUNT(*) as recent_trips
        FROM orders
        WHERE status = 'COMPLETED'
          AND completed_at > NOW() - INTERVAL '7 days'
        GROUP BY driver_id
      )
      SELECT
        d.driver_id,
        d.name,
        d.current_lat,
        d.current_lng,
        d.acceptance_rate,
        d.rating,
        d.total_trips,
        COALESCE(rs.avg_trip_duration, 11) as avg_trip_duration,
        COALESCE(rs.avg_trip_distance, 4.66) as avg_trip_distance,
        COALESCE(rs.recent_trips, 0) as recent_trips
      FROM drivers d
      LEFT JOIN recent_stats rs ON d.driver_id = rs.driver_id
      WHERE d.availability = 'AVAILABLE'
        AND d.last_heartbeat > NOW() - INTERVAL '2 minutes'
      ORDER BY d.last_heartbeat DESC
      LIMIT 50
    `);

    const drivers = result.rows.map(row => ({
      driverId: row.driver_id,
      name: row.name,
      currentLat: parseFloat(row.current_lat) || 23.9933,
      currentLng: parseFloat(row.current_lng) || 121.6011,
      acceptanceRate: parseFloat(row.acceptance_rate) || 100,
      rating: parseFloat(row.rating) || 5.0,
      totalTrips: row.total_trips || 0,
      avgTripDuration: parseFloat(row.avg_trip_duration),
      avgTripDistance: parseFloat(row.avg_trip_distance),
      recentTrips: row.recent_trips
    }));

    // 快取結果
    await cache.cacheApiResponse('available-drivers', {
      ...drivers,
      _timestamp: Date.now()
    }, 30);

    return drivers;
  }

  /**
   * 批次載入司機收入（優化版）
   */
  private async batchLoadDriverEarnings(driverIds: string[]) {
    // 找出需要更新的司機
    const driversToUpdate = driverIds.filter(id => !this.dailyEarningsCache.has(id));

    if (driversToUpdate.length === 0) {
      return; // 全部都有快取
    }

    // 批次查詢
    const result = await this.pool.query(`
      SELECT
        driver_id,
        COALESCE(SUM(total_amount), 0) as today_earnings
      FROM orders
      WHERE driver_id = ANY($1)
        AND status = 'COMPLETED'
        AND DATE(completed_at) = CURRENT_DATE
      GROUP BY driver_id
    `, [driversToUpdate]);

    // 更新快取
    const earningsMap = new Map(
      result.rows.map(row => [row.driver_id, parseFloat(row.today_earnings)])
    );

    for (const driverId of driversToUpdate) {
      const earnings = earningsMap.get(driverId) || 0;
      this.dailyEarningsCache.set(driverId, earnings);
      await cache.cacheDriverEarnings(driverId, earnings);
    }
  }

  /**
   * 優化版：計算司機評分
   */
  private async calculateDriverScoreOptimized(
    driver: any,
    order: any,
    currentHour: number,
    orderDistance: number
  ): Promise<{
    total: number;
    components: {
      distance: number;
      hotZone: number;
      earnings: number;
      efficiency: number;
      acceptance: number;
      golden: number;
    };
  }> {
    const components = {
      distance: 0,
      hotZone: 0,
      earnings: 0,
      efficiency: 0,
      acceptance: 0,
      golden: 0
    };

    // 1. 距離評分（越近越高，最高30分）
    const driverDistance = this.calculateDistance(
      driver.currentLat, driver.currentLng,
      order.pickupLat, order.pickupLng
    );
    components.distance = Math.max(0, 30 - driverDistance * 3);

    // 2. 熱區評分（在熱區內加分，最高20分）
    if (this.isInHotZone(order.pickupLat, order.pickupLng, currentHour)) {
      components.hotZone = 20;
    }

    // 3. 收入平衡評分（從快取獲取）
    const todayEarnings = this.dailyEarningsCache.get(driver.driverId) || 0;
    const avgEarnings = 8500;
    if (todayEarnings < avgEarnings) {
      components.earnings = 25 * (1 - todayEarnings / avgEarnings);
    }

    // 4. 效率匹配評分
    const driverType = this.classifyDriver(driver);
    if (orderDistance < 3 && driverType === DriverType.FAST_TURNOVER) {
      components.efficiency = 15;
    } else if (orderDistance > 10 && driverType === DriverType.LONG_DISTANCE) {
      components.efficiency = 15;
    } else if (driverType === DriverType.HIGH_VOLUME) {
      components.efficiency = 10;
    }

    // 5. 接單率評分
    components.acceptance = (driver.acceptanceRate / 100) * 5;

    // 6. 黃金時段評分
    if (GOLDEN_HOURS[currentHour]) {
      components.golden = 5 * GOLDEN_HOURS[currentHour].revenueBoost;
    }

    const total = Object.values(components).reduce((a, b) => a + b, 0);

    return { total, components };
  }

  /**
   * 更新所有快取
   */
  private async updateAllCaches() {
    const timer = performanceLogger.startTimer('cache_update');

    try {
      // 更新收入快取
      await this.updateEarningsCache();

      // 更新熱區快取
      await cache.cacheHotZones(HOT_ZONES);

      // 更新派單統計
      const stats = await this.getDispatchStats();
      await cache.cacheDispatchStats(stats);

      dispatchLogger.info('快取更新完成');
      timer.end({ status: 'success' });
    } catch (error) {
      dispatchLogger.error('快取更新失敗', error);
      timer.end({ status: 'error' });
    }
  }

  /**
   * 更新收入快取（優化版）
   */
  private async updateEarningsCache(): Promise<void> {
    const result = await this.pool.query(`
      SELECT
        driver_id,
        COALESCE(SUM(total_amount), 0) as today_earnings
      FROM orders
      WHERE status = 'COMPLETED'
        AND DATE(completed_at) = CURRENT_DATE
      GROUP BY driver_id
    `);

    this.dailyEarningsCache.clear();

    for (const row of result.rows) {
      const driverId = row.driver_id;
      const earnings = parseFloat(row.today_earnings);
      this.dailyEarningsCache.set(driverId, earnings);
      await cache.cacheDriverEarnings(driverId, earnings);
    }

    this.lastCacheUpdate = new Date();
  }

  /**
   * 取得派單統計（優化版）
   */
  async getDispatchStats(): Promise<any> {
    // 先檢查快取
    const cachedStats = await cache.getDispatchStats();
    if (cachedStats) {
      return cachedStats;
    }

    // 使用單一查詢獲取所有統計
    const result = await this.pool.query(`
      WITH stats AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed_orders,
          COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled_orders,
          COUNT(*) as total_orders,
          AVG(CASE WHEN status = 'COMPLETED' THEN actual_duration_min END) as avg_duration,
          AVG(CASE WHEN status = 'COMPLETED' THEN actual_distance_km END) as avg_distance,
          AVG(CASE WHEN status = 'COMPLETED' THEN total_amount END) as avg_amount
        FROM orders
        WHERE created_at > NOW() - INTERVAL '24 hours'
      ),
      hourly_stats AS (
        SELECT
          EXTRACT(HOUR FROM created_at) as hour,
          COUNT(*) as order_count
        FROM orders
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY EXTRACT(HOUR FROM created_at)
      ),
      driver_performance AS (
        SELECT
          driver_id,
          COUNT(*) as trip_count,
          AVG(total_amount) as avg_earnings
        FROM orders
        WHERE status = 'COMPLETED'
          AND created_at > NOW() - INTERVAL '24 hours'
        GROUP BY driver_id
        ORDER BY trip_count DESC
        LIMIT 10
      )
      SELECT
        (SELECT row_to_json(stats) FROM stats) as overall_stats,
        (SELECT json_agg(hourly_stats) FROM hourly_stats) as hourly_distribution,
        (SELECT json_agg(driver_performance) FROM driver_performance) as top_drivers
    `);

    const stats = {
      overall: result.rows[0].overall_stats,
      hourlyDistribution: result.rows[0].hourly_distribution,
      topDrivers: result.rows[0].top_drivers,
      timestamp: new Date().toISOString()
    };

    // 快取結果
    await cache.cacheDispatchStats(stats);

    return stats;
  }

  // ============================================
  // 輔助方法
  // ============================================

  /**
   * 判斷是否在熱區內
   */
  private isInHotZone(lat: number, lng: number, hour: number): boolean {
    for (const [zoneName, zone] of Object.entries(HOT_ZONES)) {
      const distance = this.calculateDistance(lat, lng, zone.lat, zone.lng);
      if (distance <= zone.radius && zone.peakHours.includes(hour)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 分類司機類型
   */
  private classifyDriver(driver: any): DriverType {
    if (driver.avgTripDuration < 10 && driver.recentTrips > 20) {
      return DriverType.FAST_TURNOVER;
    } else if (driver.avgTripDistance > 7) {
      return DriverType.LONG_DISTANCE;
    } else {
      return DriverType.HIGH_VOLUME;
    }
  }

  /**
   * 生成派單原因
   */
  private generateDispatchReason(score: any): string {
    const reasons = [];

    if (score.components.distance > 20) {
      reasons.push('距離最近');
    }
    if (score.components.hotZone > 0) {
      reasons.push('熱區優先');
    }
    if (score.components.earnings > 15) {
      reasons.push('收入平衡');
    }
    if (score.components.efficiency > 10) {
      reasons.push('效率匹配');
    }
    if (score.components.golden > 0) {
      reasons.push('黃金時段');
    }

    return reasons.join('、') || '綜合評分最高';
  }

  /**
   * 預測到達時間
   */
  private predictETA(
    pickupLat: number,
    pickupLng: number,
    driverLat: number,
    driverLng: number,
    hour: number
  ): number {
    const distance = this.calculateDistance(pickupLat, pickupLng, driverLat, driverLng);

    let avgSpeed = 30; // km/h
    if (hour >= 7 && hour <= 9) {
      avgSpeed = 20;
    } else if (hour >= 17 && hour <= 19) {
      avgSpeed = 25;
    } else if (hour >= 23 || hour <= 5) {
      avgSpeed = 40;
    }

    const eta = Math.ceil(distance / avgSpeed * 60);
    return Math.max(3, eta);
  }

  /**
   * 計算距離（Haversine 公式）
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}

// ============================================
// 工廠函數
// ============================================

let dispatcherInstance: OptimizedSmartDispatcher | null = null;

export function initDispatcher(pool: Pool): OptimizedSmartDispatcher {
  if (!dispatcherInstance) {
    dispatcherInstance = new OptimizedSmartDispatcher(pool);
  }
  return dispatcherInstance;
}

export function getDispatcher(): OptimizedSmartDispatcher {
  if (!dispatcherInstance) {
    throw new Error('Dispatcher 尚未初始化');
  }
  return dispatcherInstance;
}

export default OptimizedSmartDispatcher;
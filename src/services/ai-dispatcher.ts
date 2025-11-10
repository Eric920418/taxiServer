/**
 * 花蓮計程車系統 - 智能派單引擎 2.0
 * 基於數據分析的規則引擎，不需要 GPU！
 *
 * 核心功能：
 * 1. 熱區加權派單
 * 2. 司機收入平衡
 * 3. ETA 智能預測
 * 4. 效率匹配系統
 */

import { Pool } from 'pg';
import { Driver, Order, Location } from '../types';

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
// 智能派單引擎主類
// ============================================

export class SmartDispatcher {
  private pool: Pool;
  private dailyEarningsCache: Map<string, number> = new Map();
  private lastCacheUpdate: Date = new Date();

  constructor(pool: Pool) {
    this.pool = pool;
    // 每小時更新收入緩存
    setInterval(() => this.updateEarningsCache(), 3600000);
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
    console.log(`\n🤖 智能派單引擎啟動 - 訂單 ${order.orderId}`);

    const currentHour = new Date().getHours();
    const orderDistance = this.calculateDistance(
      order.pickupLat, order.pickupLng,
      order.destLat, order.destLng
    );

    // 1. 獲取可用司機
    const availableDrivers = await this.getAvailableDrivers();
    console.log(`   找到 ${availableDrivers.length} 位可用司機`);

    if (availableDrivers.length === 0) {
      return {
        recommendedDrivers: [],
        reason: '目前沒有可用司機',
        predictedETA: -1,
        score: 0
      };
    }

    // 2. 計算每位司機的評分
    const scoredDrivers = await Promise.all(
      availableDrivers.map(async (driver) => {
        const score = await this.calculateDriverScore(driver, order, currentHour, orderDistance);
        return { driver, score };
      })
    );

    // 3. 排序並選出前3名
    scoredDrivers.sort((a, b) => b.score.total - a.score.total);
    const top3 = scoredDrivers.slice(0, 3);

    // 4. 預測 ETA
    const predictedETA = this.predictETA(
      order.pickupLat, order.pickupLng,
      top3[0].driver.currentLat, top3[0].driver.currentLng,
      currentHour
    );

    // 5. 生成推薦原因
    const reason = this.generateDispatchReason(top3[0].score);

    console.log(`   🎯 推薦司機：${top3.map(d => d.driver.driverId).join(', ')}`);
    console.log(`   📊 最高分數：${top3[0].score.total.toFixed(2)}`);
    console.log(`   ⏱️ 預計到達：${predictedETA} 分鐘`);

    return {
      recommendedDrivers: top3.map(d => d.driver.driverId),
      reason,
      predictedETA,
      score: top3[0].score.total
    };
  }

  /**
   * 計算司機評分（核心算法）
   */
  private async calculateDriverScore(
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
      distance: 0,    // 距離評分
      hotZone: 0,     // 熱區評分
      earnings: 0,    // 收入平衡評分
      efficiency: 0,  // 效率匹配評分
      acceptance: 0,  // 接單率評分
      golden: 0       // 黃金時段評分
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

    // 3. 收入平衡評分（收入低的加分，最高25分）
    const todayEarnings = await this.getDriverTodayEarnings(driver.driverId);
    const avgEarnings = 8500; // 基於分析的平均日收入
    if (todayEarnings < avgEarnings) {
      components.earnings = 25 * (1 - todayEarnings / avgEarnings);
    }

    // 4. 效率匹配評分（根據訂單類型匹配司機，最高15分）
    const driverType = this.classifyDriver(driver);
    components.efficiency = this.matchEfficiency(driverType, orderDistance);

    // 5. 接單率評分（接單率高的加分，最高5分）
    if (driver.acceptanceRate > 70) {
      components.acceptance = 5 * (driver.acceptanceRate / 100);
    }

    // 6. 黃金時段評分（黃金時段加分，最高5分）
    if (GOLDEN_HOURS[currentHour]) {
      components.golden = 5;
    }

    // 計算總分
    const total = Object.values(components).reduce((sum, score) => sum + score, 0);

    return { total, components };
  }

  /**
   * 判斷是否在熱區
   */
  private isInHotZone(lat: number, lng: number, hour: number): boolean {
    for (const [zoneName, zone] of Object.entries(HOT_ZONES)) {
      const distance = this.calculateDistance(lat, lng, zone.lat, zone.lng);
      if (distance <= zone.radius && zone.peakHours.includes(hour)) {
        console.log(`   📍 訂單在熱區：${zoneName}`);
        return true;
      }
    }
    return false;
  }

  /**
   * 司機分類
   */
  private classifyDriver(driver: any): DriverType {
    // 基於歷史數據分類司機
    if (driver.avgTripDuration < 10) {
      return DriverType.FAST_TURNOVER;
    } else if (driver.avgTripDistance > 5) {
      return DriverType.LONG_DISTANCE;
    } else {
      return DriverType.HIGH_VOLUME;
    }
  }

  /**
   * 效率匹配評分
   */
  private matchEfficiency(driverType: DriverType, orderDistance: number): number {
    if (orderDistance < 3) {
      // 短程訂單
      return driverType === DriverType.FAST_TURNOVER ? 15 : 7;
    } else if (orderDistance > 10) {
      // 長程訂單
      return driverType === DriverType.LONG_DISTANCE ? 15 : 7;
    } else {
      // 中程訂單
      return driverType === DriverType.HIGH_VOLUME ? 15 : 10;
    }
  }

  /**
   * 預測 ETA（基於時段和距離）
   */
  private predictETA(
    pickupLat: number, pickupLng: number,
    driverLat: number, driverLng: number,
    hour: number
  ): number {
    const distance = this.calculateDistance(pickupLat, pickupLng, driverLat, driverLng);

    // 基於時段的速度調整
    let avgSpeed = 30; // 基礎速度 30 km/h

    // 高峰時段降速
    if ([7, 8, 17, 18, 19].includes(hour)) {
      avgSpeed = 20;
    }
    // 深夜提速
    else if (hour >= 23 || hour <= 5) {
      avgSpeed = 40;
    }

    const eta = Math.ceil(distance / avgSpeed * 60); // 分鐘
    return Math.max(3, eta); // 最少3分鐘
  }

  /**
   * 獲取可用司機
   */
  private async getAvailableDrivers(): Promise<any[]> {
    const result = await this.pool.query(`
      SELECT
        d.*,
        COALESCE(stats.avg_trip_duration, 11) as avgTripDuration,
        COALESCE(stats.avg_trip_distance, 4.66) as avgTripDistance
      FROM drivers d
      LEFT JOIN (
        SELECT
          driver_id,
          AVG(actual_duration_min) as avg_trip_duration,
          AVG(actual_distance_km) as avg_trip_distance
        FROM orders
        WHERE status = 'DONE'
          AND completed_at > NOW() - INTERVAL '7 days'
        GROUP BY driver_id
      ) stats ON d.driver_id = stats.driver_id
      WHERE d.availability = 'AVAILABLE'
        AND d.last_heartbeat > NOW() - INTERVAL '1 minute'
    `);

    return result.rows.map(row => ({
      driverId: row.driver_id,
      name: row.name,
      currentLat: parseFloat(row.current_lat) || 23.9933, // 預設花蓮火車站
      currentLng: parseFloat(row.current_lng) || 121.6011,
      acceptanceRate: parseFloat(row.acceptance_rate) || 100,
      avgTripDuration: parseFloat(row.avgtripduration),
      avgTripDistance: parseFloat(row.avgtripdistance)
    }));
  }

  /**
   * 獲取司機今日收入
   */
  private async getDriverTodayEarnings(driverId: string): Promise<number> {
    // 使用緩存提高效能
    if (this.dailyEarningsCache.has(driverId)) {
      return this.dailyEarningsCache.get(driverId) || 0;
    }

    const result = await this.pool.query(`
      SELECT COALESCE(SUM(meter_amount), 0) as today_earnings
      FROM orders
      WHERE driver_id = $1
        AND status = 'DONE'
        AND DATE(completed_at) = CURRENT_DATE
    `, [driverId]);

    const earnings = parseFloat(result.rows[0].today_earnings);
    this.dailyEarningsCache.set(driverId, earnings);
    return earnings;
  }

  /**
   * 更新收入緩存
   */
  private async updateEarningsCache(): Promise<void> {
    console.log('更新司機收入緩存...');
    const result = await this.pool.query(`
      SELECT
        driver_id,
        COALESCE(SUM(meter_amount), 0) as today_earnings
      FROM orders
      WHERE status = 'DONE'
        AND DATE(completed_at) = CURRENT_DATE
      GROUP BY driver_id
    `);

    this.dailyEarningsCache.clear();
    result.rows.forEach(row => {
      this.dailyEarningsCache.set(row.driver_id, parseFloat(row.today_earnings));
    });
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

  /**
   * 生成派單原因說明
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
    if (score.components.efficiency > 12) {
      reasons.push('效率匹配');
    }
    if (score.components.golden > 0) {
      reasons.push('黃金時段');
    }

    return reasons.join(' + ') || '綜合評分最高';
  }

  /**
   * 獲取派單統計
   */
  async getDispatchStats(): Promise<any> {
    const stats = await this.pool.query(`
      SELECT
        COUNT(*) as total_orders,
        AVG(EXTRACT(EPOCH FROM (accepted_at - created_at))) as avg_accept_time,
        COUNT(CASE WHEN status = 'DONE' THEN 1 END) as completed_orders,
        COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_orders
      FROM orders
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

    const driverStats = await this.pool.query(`
      SELECT
        driver_id,
        COUNT(*) as trips_today,
        SUM(meter_amount) as earnings_today
      FROM orders
      WHERE status = 'DONE'
        AND DATE(completed_at) = CURRENT_DATE
      GROUP BY driver_id
      ORDER BY earnings_today DESC
    `);

    return {
      overall: stats.rows[0],
      drivers: driverStats.rows
    };
  }
}

// 導出單例
let dispatcher: SmartDispatcher | null = null;

export function initDispatcher(pool: Pool): SmartDispatcher {
  if (!dispatcher) {
    dispatcher = new SmartDispatcher(pool);
    console.log('✅ 智能派單引擎初始化完成');
  }
  return dispatcher;
}

export function getDispatcher(): SmartDispatcher {
  if (!dispatcher) {
    throw new Error('派單引擎尚未初始化，請先調用 initDispatcher()');
  }
  return dispatcher;
}
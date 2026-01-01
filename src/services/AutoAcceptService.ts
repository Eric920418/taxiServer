/**
 * 花蓮計程車系統 - AI 自動接單服務
 * 基於 RejectionPredictor 擴展，計算自動接單推薦分數
 *
 * 功能：
 * 1. 管理司機自動接單設定
 * 2. 計算自動接單推薦分數
 * 3. 驗證自動接單條件
 * 4. 風控機制（每日上限、冷卻時間、異常偵測）
 */

import { Pool, PoolClient } from 'pg';
import { RejectionPredictor, PredictionFeatures } from './RejectionPredictor';

// ============================================
// 類型定義
// ============================================

export interface AutoAcceptSettings {
  driverId: string;
  enabled: boolean;
  maxPickupDistanceKm: number;
  minFareAmount: number;
  minTripDistanceKm: number;
  activeHours: number[];
  blacklistedZones: string[];
  smartModeEnabled: boolean;
  autoAcceptThreshold: number;
  dailyAutoAcceptLimit: number;
  cooldownMinutes: number;
  consecutiveLimit: number;
}

export interface AutoAcceptScore {
  score: number;                    // 0-100 分數
  recommended: boolean;             // 是否推薦自動接單
  reason: string;                   // 推薦原因
  components: {
    rejectionProbability: number;   // 拒單機率 (0-1)
    distanceScore: number;          // 距離分數
    fareScore: number;              // 車資分數
    timeScore: number;              // 時段分數
    driverFitScore: number;         // 司機適配度
  };
  allowAutoAccept: boolean;         // 是否允許自動接單
  blockReason?: string;             // 阻擋原因
}

export interface AutoAcceptDecision {
  decision: 'AUTO_ACCEPT' | 'MANUAL' | 'BLOCKED';
  orderId: string;
  driverId: string;
  score: number;
  threshold: number;
  blockReason?: string;
}

export interface DailyStats {
  autoAcceptCount: number;
  manualAcceptCount: number;
  blockedCount: number;
  consecutiveAutoAccepts: number;
  lastAutoAcceptAt: Date | null;
  autoAcceptCompleted: number;
  autoAcceptCancelled: number;
}

// ============================================
// 配置
// ============================================

const CONFIG = {
  // 預設設定
  DEFAULT_SETTINGS: {
    enabled: false,
    maxPickupDistanceKm: 5.0,
    minFareAmount: 100,
    minTripDistanceKm: 1.0,
    activeHours: [],
    blacklistedZones: [],
    smartModeEnabled: true,
    autoAcceptThreshold: 70.0,
    dailyAutoAcceptLimit: 30,
    cooldownMinutes: 2,
    consecutiveLimit: 5,
  },

  // 分數權重
  SCORE_WEIGHTS: {
    rejectionInverse: 0.40,    // 拒單機率反向 (40%)
    distance: 0.20,            // 距離因素 (20%)
    fare: 0.15,                // 車資因素 (15%)
    time: 0.15,                // 時段因素 (15%)
    driverFit: 0.10,           // 司機適配度 (10%)
  },

  // 風控閾值
  RISK_CONTROL: {
    minCompletionRate: 0.80,   // 最低完成率 80%
    maxConsecutiveBlocks: 3,   // 連續阻擋次數後暫停
    suspensionHours: 24,       // 暫停時長（小時）
  },

  // 分數映射
  SCORE_RANGES: {
    distance: { excellent: 2, good: 5, acceptable: 8 },  // km
    fare: { excellent: 300, good: 200, acceptable: 100 }, // 元
  },
};

// ============================================
// 自動接單服務
// ============================================

export class AutoAcceptService {
  private pool: Pool;
  private rejectionPredictor: RejectionPredictor;
  private settingsCache: Map<string, AutoAcceptSettings> = new Map();

  constructor(pool: Pool, rejectionPredictor: RejectionPredictor) {
    this.pool = pool;
    this.rejectionPredictor = rejectionPredictor;
  }

  // ============================================
  // 設定管理
  // ============================================

  /**
   * 獲取司機自動接單設定
   */
  async getSettings(driverId: string): Promise<AutoAcceptSettings> {
    // 優先從快取取
    const cached = this.settingsCache.get(driverId);
    if (cached) return cached;

    const result = await this.pool.query(
      `SELECT * FROM driver_auto_accept_settings WHERE driver_id = $1`,
      [driverId]
    );

    if (result.rows.length === 0) {
      // 返回預設設定
      return {
        driverId,
        ...CONFIG.DEFAULT_SETTINGS,
      };
    }

    const row = result.rows[0];
    const settings: AutoAcceptSettings = {
      driverId: row.driver_id,
      enabled: row.enabled,
      maxPickupDistanceKm: parseFloat(row.max_pickup_distance_km),
      minFareAmount: row.min_fare_amount,
      minTripDistanceKm: parseFloat(row.min_trip_distance_km),
      activeHours: row.active_hours || [],
      blacklistedZones: row.blacklisted_zones || [],
      smartModeEnabled: row.smart_mode_enabled,
      autoAcceptThreshold: parseFloat(row.auto_accept_threshold),
      dailyAutoAcceptLimit: row.daily_auto_accept_limit,
      cooldownMinutes: row.cooldown_minutes,
      consecutiveLimit: row.consecutive_limit,
    };

    this.settingsCache.set(driverId, settings);
    return settings;
  }

  /**
   * 更新司機自動接單設定
   */
  async updateSettings(driverId: string, settings: Partial<AutoAcceptSettings>): Promise<AutoAcceptSettings> {
    const current = await this.getSettings(driverId);
    const updated = { ...current, ...settings };

    await this.pool.query(
      `INSERT INTO driver_auto_accept_settings (
        driver_id, enabled, max_pickup_distance_km, min_fare_amount,
        min_trip_distance_km, active_hours, blacklisted_zones,
        smart_mode_enabled, auto_accept_threshold, daily_auto_accept_limit,
        cooldown_minutes, consecutive_limit
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (driver_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        max_pickup_distance_km = EXCLUDED.max_pickup_distance_km,
        min_fare_amount = EXCLUDED.min_fare_amount,
        min_trip_distance_km = EXCLUDED.min_trip_distance_km,
        active_hours = EXCLUDED.active_hours,
        blacklisted_zones = EXCLUDED.blacklisted_zones,
        smart_mode_enabled = EXCLUDED.smart_mode_enabled,
        auto_accept_threshold = EXCLUDED.auto_accept_threshold,
        daily_auto_accept_limit = EXCLUDED.daily_auto_accept_limit,
        cooldown_minutes = EXCLUDED.cooldown_minutes,
        consecutive_limit = EXCLUDED.consecutive_limit,
        updated_at = CURRENT_TIMESTAMP`,
      [
        driverId,
        updated.enabled,
        updated.maxPickupDistanceKm,
        updated.minFareAmount,
        updated.minTripDistanceKm,
        JSON.stringify(updated.activeHours),
        JSON.stringify(updated.blacklistedZones),
        updated.smartModeEnabled,
        updated.autoAcceptThreshold,
        updated.dailyAutoAcceptLimit,
        updated.cooldownMinutes,
        updated.consecutiveLimit,
      ]
    );

    // 更新快取
    this.settingsCache.set(driverId, updated);
    return updated;
  }

  // ============================================
  // 自動接單分數計算
  // ============================================

  /**
   * 計算自動接單推薦分數
   */
  async calculateAutoAcceptScore(
    driverId: string,
    orderFeatures: {
      pickupDistanceKm: number;
      tripDistanceKm: number;
      estimatedFare: number;
      hourOfDay: number;
      dayOfWeek: number;
      pickupZone?: string;
    },
    driverFeatures: PredictionFeatures
  ): Promise<AutoAcceptScore> {
    const settings = await this.getSettings(driverId);

    // 1. 計算拒單機率（反向作為自動接單基礎）
    const rejectionProbability = await this.rejectionPredictor.predict(driverId, driverFeatures);
    const rejectionInverseScore = (1 - rejectionProbability) * 100;

    // 2. 計算距離分數
    const distanceScore = this.calculateDistanceScore(orderFeatures.pickupDistanceKm);

    // 3. 計算車資分數
    const fareScore = this.calculateFareScore(orderFeatures.estimatedFare);

    // 4. 計算時段分數
    const timeScore = this.calculateTimeScore(orderFeatures.hourOfDay, settings.activeHours);

    // 5. 計算司機適配度
    const driverFitScore = this.calculateDriverFitScore(
      orderFeatures.tripDistanceKm,
      driverFeatures.driverTodayEarnings,
      driverFeatures.driverAcceptanceRate
    );

    // 加權總分
    const totalScore =
      rejectionInverseScore * CONFIG.SCORE_WEIGHTS.rejectionInverse +
      distanceScore * CONFIG.SCORE_WEIGHTS.distance +
      fareScore * CONFIG.SCORE_WEIGHTS.fare +
      timeScore * CONFIG.SCORE_WEIGHTS.time +
      driverFitScore * CONFIG.SCORE_WEIGHTS.driverFit;

    // 檢查是否允許自動接單
    const { allowed, blockReason } = await this.checkAutoAcceptAllowed(
      driverId,
      settings,
      orderFeatures
    );

    // 生成推薦原因
    const reason = this.generateRecommendationReason(
      totalScore,
      { rejectionInverseScore, distanceScore, fareScore, timeScore, driverFitScore }
    );

    return {
      score: Math.round(totalScore * 10) / 10,
      recommended: totalScore >= settings.autoAcceptThreshold && allowed,
      reason,
      components: {
        rejectionProbability,
        distanceScore,
        fareScore,
        timeScore,
        driverFitScore,
      },
      allowAutoAccept: allowed,
      blockReason,
    };
  }

  private calculateDistanceScore(distanceKm: number): number {
    const { excellent, good, acceptable } = CONFIG.SCORE_RANGES.distance;
    if (distanceKm <= excellent) return 100;
    if (distanceKm <= good) return 80;
    if (distanceKm <= acceptable) return 60;
    return Math.max(0, 100 - distanceKm * 10);
  }

  private calculateFareScore(fare: number): number {
    const { excellent, good, acceptable } = CONFIG.SCORE_RANGES.fare;
    if (fare >= excellent) return 100;
    if (fare >= good) return 80;
    if (fare >= acceptable) return 60;
    return Math.max(0, fare / acceptable * 60);
  }

  private calculateTimeScore(hour: number, activeHours: number[]): number {
    // 如果沒有設定活動時段，所有時段都是 100 分
    if (activeHours.length === 0) return 100;

    // 在活動時段內：100 分
    if (activeHours.includes(hour)) return 100;

    // 接近活動時段：50 分
    const nearActive = activeHours.some(h => Math.abs(h - hour) <= 1 || Math.abs(h - hour) >= 23);
    if (nearActive) return 50;

    // 不在活動時段：0 分
    return 0;
  }

  private calculateDriverFitScore(
    tripDistanceKm: number,
    todayEarnings: number,
    acceptanceRate: number
  ): number {
    // 今日收入較低 → 更適合接單
    const earningsScore = todayEarnings < 3000 ? 100 :
                         todayEarnings < 6000 ? 70 :
                         todayEarnings < 9000 ? 40 : 20;

    // 接單率高 → 更適合自動接單
    const acceptanceScore = acceptanceRate >= 90 ? 100 :
                           acceptanceRate >= 80 ? 80 :
                           acceptanceRate >= 70 ? 60 : 40;

    return (earningsScore + acceptanceScore) / 2;
  }

  private generateRecommendationReason(
    totalScore: number,
    scores: Record<string, number>
  ): string {
    const reasons: string[] = [];

    if (scores.rejectionInverseScore >= 80) reasons.push('接單機率高');
    if (scores.distanceScore >= 80) reasons.push('距離近');
    if (scores.fareScore >= 80) reasons.push('車資合理');
    if (scores.timeScore >= 80) reasons.push('在活動時段');
    if (scores.driverFitScore >= 80) reasons.push('司機狀態佳');

    if (reasons.length === 0) {
      return totalScore >= 70 ? '綜合評估適合' : '建議手動審核';
    }

    return reasons.join(' + ');
  }

  // ============================================
  // 風控機制
  // ============================================

  /**
   * 檢查是否允許自動接單
   */
  private async checkAutoAcceptAllowed(
    driverId: string,
    settings: AutoAcceptSettings,
    orderFeatures: {
      pickupDistanceKm: number;
      tripDistanceKm: number;
      estimatedFare: number;
      hourOfDay: number;
      pickupZone?: string;
    }
  ): Promise<{ allowed: boolean; blockReason?: string }> {
    // 1. 自動接單未啟用
    if (!settings.enabled) {
      return { allowed: false, blockReason: '自動接單未啟用' };
    }

    // 2. 距離超過設定
    if (orderFeatures.pickupDistanceKm > settings.maxPickupDistanceKm) {
      return { allowed: false, blockReason: `距離 ${orderFeatures.pickupDistanceKm}km 超過設定 ${settings.maxPickupDistanceKm}km` };
    }

    // 3. 車資低於設定
    if (orderFeatures.estimatedFare < settings.minFareAmount) {
      return { allowed: false, blockReason: `車資 ${orderFeatures.estimatedFare} 低於設定 ${settings.minFareAmount}` };
    }

    // 4. 行程距離低於設定
    if (orderFeatures.tripDistanceKm < settings.minTripDistanceKm) {
      return { allowed: false, blockReason: `行程 ${orderFeatures.tripDistanceKm}km 低於設定 ${settings.minTripDistanceKm}km` };
    }

    // 5. 不在活動時段
    if (settings.activeHours.length > 0 && !settings.activeHours.includes(orderFeatures.hourOfDay)) {
      return { allowed: false, blockReason: `當前時段 ${orderFeatures.hourOfDay}:00 不在活動時段` };
    }

    // 6. 在黑名單區域
    if (orderFeatures.pickupZone && settings.blacklistedZones.includes(orderFeatures.pickupZone)) {
      return { allowed: false, blockReason: `上車點 ${orderFeatures.pickupZone} 在黑名單中` };
    }

    // 7. 檢查每日統計（風控）
    const stats = await this.getDailyStats(driverId);

    // 7a. 每日上限
    if (stats.autoAcceptCount >= settings.dailyAutoAcceptLimit) {
      return { allowed: false, blockReason: `今日自動接單 ${stats.autoAcceptCount} 已達上限 ${settings.dailyAutoAcceptLimit}` };
    }

    // 7b. 冷卻時間
    if (stats.lastAutoAcceptAt) {
      const cooldownMs = settings.cooldownMinutes * 60 * 1000;
      const elapsed = Date.now() - stats.lastAutoAcceptAt.getTime();
      if (elapsed < cooldownMs) {
        const remainingSec = Math.ceil((cooldownMs - elapsed) / 1000);
        return { allowed: false, blockReason: `冷卻中，還需等待 ${remainingSec} 秒` };
      }
    }

    // 7c. 連續自動接單限制
    if (stats.consecutiveAutoAccepts >= settings.consecutiveLimit) {
      return { allowed: false, blockReason: `連續自動接單 ${stats.consecutiveAutoAccepts} 次，需手動確認` };
    }

    // 7d. 完成率檢查
    const totalAutoAccept = stats.autoAcceptCompleted + stats.autoAcceptCancelled;
    if (totalAutoAccept >= 5) {  // 至少 5 單才檢查
      const completionRate = stats.autoAcceptCompleted / totalAutoAccept;
      if (completionRate < CONFIG.RISK_CONTROL.minCompletionRate) {
        return {
          allowed: false,
          blockReason: `自動接單完成率 ${(completionRate * 100).toFixed(0)}% 低於 ${CONFIG.RISK_CONTROL.minCompletionRate * 100}%`
        };
      }
    }

    return { allowed: true };
  }

  /**
   * 獲取今日統計
   */
  async getDailyStats(driverId: string): Promise<DailyStats> {
    const today = new Date().toISOString().split('T')[0];

    const result = await this.pool.query(
      `SELECT * FROM daily_auto_accept_stats WHERE driver_id = $1 AND stat_date = $2`,
      [driverId, today]
    );

    if (result.rows.length === 0) {
      return {
        autoAcceptCount: 0,
        manualAcceptCount: 0,
        blockedCount: 0,
        consecutiveAutoAccepts: 0,
        lastAutoAcceptAt: null,
        autoAcceptCompleted: 0,
        autoAcceptCancelled: 0,
      };
    }

    const row = result.rows[0];
    return {
      autoAcceptCount: row.auto_accept_count,
      manualAcceptCount: row.manual_accept_count,
      blockedCount: row.blocked_count,
      consecutiveAutoAccepts: row.consecutive_auto_accepts,
      lastAutoAcceptAt: row.last_auto_accept_at ? new Date(row.last_auto_accept_at) : null,
      autoAcceptCompleted: row.auto_accept_completed,
      autoAcceptCancelled: row.auto_accept_cancelled,
    };
  }

  // ============================================
  // 決策記錄
  // ============================================

  /**
   * 記錄自動接單決策
   */
  async logDecision(decision: AutoAcceptDecision, orderFeatures: {
    pickupDistanceKm: number;
    estimatedFare: number;
    tripDistanceKm: number;
    hourOfDay: number;
    zoneName?: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. 記錄到 auto_accept_logs
      await client.query(
        `INSERT INTO auto_accept_logs (
          driver_id, order_id, auto_accept_score, threshold_used,
          decision, block_reason, pickup_distance_km, estimated_fare,
          trip_distance_km, hour_of_day, zone_name
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          decision.driverId,
          decision.orderId,
          decision.score,
          decision.threshold,
          decision.decision,
          decision.blockReason || null,
          orderFeatures.pickupDistanceKm,
          orderFeatures.estimatedFare,
          orderFeatures.tripDistanceKm,
          orderFeatures.hourOfDay,
          orderFeatures.zoneName || null,
        ]
      );

      // 2. 更新每日統計
      const today = new Date().toISOString().split('T')[0];
      const isAutoAccept = decision.decision === 'AUTO_ACCEPT';
      const isBlocked = decision.decision === 'BLOCKED';

      await client.query(
        `INSERT INTO daily_auto_accept_stats (
          driver_id, stat_date,
          auto_accept_count, manual_accept_count, blocked_count,
          consecutive_auto_accepts, last_auto_accept_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (driver_id, stat_date) DO UPDATE SET
          auto_accept_count = daily_auto_accept_stats.auto_accept_count + $3,
          manual_accept_count = daily_auto_accept_stats.manual_accept_count + $4,
          blocked_count = daily_auto_accept_stats.blocked_count + $5,
          consecutive_auto_accepts = CASE
            WHEN $3 = 1 THEN daily_auto_accept_stats.consecutive_auto_accepts + 1
            ELSE 0
          END,
          last_auto_accept_at = CASE
            WHEN $3 = 1 THEN CURRENT_TIMESTAMP
            ELSE daily_auto_accept_stats.last_auto_accept_at
          END,
          updated_at = CURRENT_TIMESTAMP`,
        [
          decision.driverId,
          today,
          isAutoAccept ? 1 : 0,
          decision.decision === 'MANUAL' ? 1 : 0,
          isBlocked ? 1 : 0,
          isAutoAccept ? 1 : 0,
          isAutoAccept ? new Date() : null,
        ]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[AutoAcceptService] 記錄決策失敗:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 更新訂單完成狀態（用於完成率追蹤）
   */
  async updateOrderCompletion(driverId: string, orderId: string, completed: boolean): Promise<void> {
    const today = new Date().toISOString().split('T')[0];

    // 檢查是否為自動接單的訂單
    const logResult = await this.pool.query(
      `SELECT decision FROM auto_accept_logs WHERE order_id = $1 AND decision = 'AUTO_ACCEPT'`,
      [orderId]
    );

    if (logResult.rows.length === 0) return;

    // 更新統計
    if (completed) {
      await this.pool.query(
        `UPDATE daily_auto_accept_stats
         SET auto_accept_completed = auto_accept_completed + 1, updated_at = CURRENT_TIMESTAMP
         WHERE driver_id = $1 AND stat_date = $2`,
        [driverId, today]
      );
    } else {
      await this.pool.query(
        `UPDATE daily_auto_accept_stats
         SET auto_accept_cancelled = auto_accept_cancelled + 1, updated_at = CURRENT_TIMESTAMP
         WHERE driver_id = $1 AND stat_date = $2`,
        [driverId, today]
      );
    }
  }

  // ============================================
  // 統計查詢
  // ============================================

  /**
   * 獲取自動接單統計（給 API 用）
   */
  async getAutoAcceptStats(driverId: string): Promise<{
    today: DailyStats;
    last7Days: {
      totalAutoAccepts: number;
      totalManual: number;
      totalBlocked: number;
      avgScore: number;
      completionRate: number;
    };
  }> {
    const today = await this.getDailyStats(driverId);

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const result = await this.pool.query(
      `SELECT
        COALESCE(SUM(auto_accept_count), 0) as total_auto,
        COALESCE(SUM(manual_accept_count), 0) as total_manual,
        COALESCE(SUM(blocked_count), 0) as total_blocked,
        COALESCE(SUM(auto_accept_completed), 0) as total_completed,
        COALESCE(SUM(auto_accept_cancelled), 0) as total_cancelled
       FROM daily_auto_accept_stats
       WHERE driver_id = $1 AND stat_date >= $2`,
      [driverId, sevenDaysAgo.toISOString().split('T')[0]]
    );

    const scoreResult = await this.pool.query(
      `SELECT COALESCE(AVG(auto_accept_score), 0) as avg_score
       FROM auto_accept_logs
       WHERE driver_id = $1 AND created_at >= $2`,
      [driverId, sevenDaysAgo]
    );

    const row = result.rows[0];
    const totalAutoAccepts = parseInt(row.total_auto);
    const totalCompleted = parseInt(row.total_completed);
    const totalCancelled = parseInt(row.total_cancelled);

    return {
      today,
      last7Days: {
        totalAutoAccepts,
        totalManual: parseInt(row.total_manual),
        totalBlocked: parseInt(row.total_blocked),
        avgScore: parseFloat(scoreResult.rows[0].avg_score) || 0,
        completionRate: (totalCompleted + totalCancelled) > 0
          ? totalCompleted / (totalCompleted + totalCancelled)
          : 1.0,
      },
    };
  }

  /**
   * 清除設定快取
   */
  clearCache(driverId?: string): void {
    if (driverId) {
      this.settingsCache.delete(driverId);
    } else {
      this.settingsCache.clear();
    }
  }
}

// ============================================
// 匯出單例創建函數
// ============================================

let autoAcceptServiceInstance: AutoAcceptService | null = null;

export function getAutoAcceptService(pool: Pool, rejectionPredictor: RejectionPredictor): AutoAcceptService {
  if (!autoAcceptServiceInstance) {
    autoAcceptServiceInstance = new AutoAcceptService(pool, rejectionPredictor);
  }
  return autoAcceptServiceInstance;
}

export function resetAutoAcceptService(): void {
  autoAcceptServiceInstance = null;
}

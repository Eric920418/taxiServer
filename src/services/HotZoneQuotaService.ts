/**
 * 花蓮計程車系統 - 熱區配額管理服務
 * 管理熱門區域的訂單配額，實現混合模式（先漲價再排隊）
 *
 * 功能：
 * 1. 熱區座標匹配（判斷訂單是否在熱區內）
 * 2. 配額管理（每小時配額限制）
 * 3. 動態漲價（80% 使用率開始漲價，最高 1.5 倍）
 * 4. 排隊機制（100% 使用率進入排隊）
 * 5. 配額自動重置
 */

import { Pool, PoolClient } from 'pg';

// ============================================
// 類型定義
// ============================================

export interface HotZoneConfig {
  zoneId: number;
  zoneName: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  peakHours: number[];
  hourlyQuotaNormal: number;
  hourlyQuotaPeak: number;
  surgeThreshold: number;
  surgeMultiplierMax: number;
  surgeStep: number;
  queueEnabled: boolean;
  maxQueueSize: number;
  queueTimeoutMinutes: number;
  isActive: boolean;
  priority: number;
}

export interface QuotaStatus {
  zoneId: number;
  zoneName: string;
  quotaDate: string;
  quotaHour: number;
  quotaLimit: number;
  quotaUsed: number;
  availableQuota: number;
  usagePercentage: number;
  currentSurge: number;
  isPeak: boolean;
  queueLength: number;
}

export interface QueueEntry {
  queueId: number;
  zoneId: number;
  orderId: string;
  passengerId: string;
  queuePosition: number;
  estimatedWaitMinutes: number;
  surgeMultiplier: number;
  originalFare: number;
  surgedFare: number;
  queuedAt: Date;
}

export interface ZoneCheckResult {
  inHotZone: boolean;
  zone?: HotZoneConfig;
  quotaStatus?: QuotaStatus;
  action: 'NORMAL' | 'SURGE' | 'QUEUE';
  surgeMultiplier: number;
  queueInfo?: {
    position: number;
    estimatedWait: number;
  };
}

// ============================================
// 配置
// ============================================

const CONFIG = {
  // 地球半徑（公里）
  EARTH_RADIUS_KM: 6371,

  // 預設漲價參數
  DEFAULT_SURGE: {
    threshold: 0.80,     // 80% 開始漲價
    maxMultiplier: 1.50, // 最高 1.5 倍
    step: 0.10,          // 每 10% 漲一檔
  },

  // 排隊設定
  QUEUE: {
    avgWaitPerOrder: 3,  // 每單預估等待時間（分鐘）
    maxTimeout: 15,      // 最大超時時間（分鐘）
  },

  // 快取
  CACHE_TTL_MS: 60 * 1000, // 1 分鐘快取
};

// ============================================
// 熱區配額服務
// ============================================

export class HotZoneQuotaService {
  private pool: Pool;
  private zoneCache: Map<number, HotZoneConfig> = new Map();
  private zoneCacheTime: number = 0;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // ============================================
  // 熱區配置管理
  // ============================================

  /**
   * 獲取所有活動熱區
   */
  async getAllActiveZones(): Promise<HotZoneConfig[]> {
    // 檢查快取
    if (this.zoneCache.size > 0 && Date.now() - this.zoneCacheTime < CONFIG.CACHE_TTL_MS) {
      return Array.from(this.zoneCache.values());
    }

    const result = await this.pool.query(
      `SELECT * FROM hot_zone_configs WHERE is_active = TRUE ORDER BY priority DESC`
    );

    const zones = result.rows.map(row => this.mapRowToZoneConfig(row));

    // 更新快取
    this.zoneCache.clear();
    zones.forEach(zone => this.zoneCache.set(zone.zoneId, zone));
    this.zoneCacheTime = Date.now();

    return zones;
  }

  /**
   * 根據座標找到熱區
   */
  async findZone(lat: number, lng: number): Promise<HotZoneConfig | null> {
    const zones = await this.getAllActiveZones();

    // 按優先級排序，找到第一個匹配的熱區
    for (const zone of zones) {
      const distance = this.calculateDistance(lat, lng, zone.centerLat, zone.centerLng);
      if (distance <= zone.radiusKm) {
        return zone;
      }
    }

    return null;
  }

  /**
   * 獲取單個熱區配置
   */
  async getZone(zoneId: number): Promise<HotZoneConfig | null> {
    const cached = this.zoneCache.get(zoneId);
    if (cached) return cached;

    const result = await this.pool.query(
      `SELECT * FROM hot_zone_configs WHERE zone_id = $1`,
      [zoneId]
    );

    if (result.rows.length === 0) return null;
    return this.mapRowToZoneConfig(result.rows[0]);
  }

  private mapRowToZoneConfig(row: any): HotZoneConfig {
    return {
      zoneId: row.zone_id,
      zoneName: row.zone_name,
      centerLat: parseFloat(row.center_lat),
      centerLng: parseFloat(row.center_lng),
      radiusKm: parseFloat(row.radius_km),
      peakHours: row.peak_hours || [],
      hourlyQuotaNormal: row.hourly_quota_normal,
      hourlyQuotaPeak: row.hourly_quota_peak,
      surgeThreshold: parseFloat(row.surge_threshold),
      surgeMultiplierMax: parseFloat(row.surge_multiplier_max),
      surgeStep: parseFloat(row.surge_step),
      queueEnabled: row.queue_enabled,
      maxQueueSize: row.max_queue_size,
      queueTimeoutMinutes: row.queue_timeout_minutes,
      isActive: row.is_active,
      priority: row.priority,
    };
  }

  // ============================================
  // 配額管理
  // ============================================

  /**
   * 檢查熱區配額狀態
   */
  async checkQuota(zoneId: number): Promise<QuotaStatus> {
    const now = new Date();
    const quotaDate = now.toISOString().split('T')[0];
    const quotaHour = now.getHours();

    const zone = await this.getZone(zoneId);
    if (!zone) {
      throw new Error(`熱區不存在: ${zoneId}`);
    }

    // 判斷是否尖峰時段
    const isPeak = zone.peakHours.includes(quotaHour);
    const quotaLimit = isPeak ? zone.hourlyQuotaPeak : zone.hourlyQuotaNormal;

    // 獲取或創建當前小時配額
    const quotaResult = await this.pool.query(
      `INSERT INTO hot_zone_quotas (zone_id, quota_date, quota_hour, quota_limit)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (zone_id, quota_date, quota_hour) DO UPDATE SET quota_limit = $4
       RETURNING *`,
      [zoneId, quotaDate, quotaHour, quotaLimit]
    );

    const quota = quotaResult.rows[0];

    // 獲取排隊長度
    const queueResult = await this.pool.query(
      `SELECT COUNT(*) as queue_length FROM hot_zone_queue
       WHERE zone_id = $1 AND status = 'WAITING'`,
      [zoneId]
    );

    const quotaUsed = quota.quota_used;
    const usagePercentage = quotaUsed / quotaLimit;

    // 計算漲價倍率
    const currentSurge = this.calculateSurgeMultiplier(
      usagePercentage,
      zone.surgeThreshold,
      zone.surgeMultiplierMax,
      zone.surgeStep
    );

    // 更新資料庫中的漲價倍率
    if (currentSurge !== parseFloat(quota.current_surge)) {
      await this.pool.query(
        `UPDATE hot_zone_quotas SET current_surge = $1, updated_at = CURRENT_TIMESTAMP
         WHERE quota_id = $2`,
        [currentSurge, quota.quota_id]
      );
    }

    return {
      zoneId,
      zoneName: zone.zoneName,
      quotaDate,
      quotaHour,
      quotaLimit,
      quotaUsed,
      availableQuota: Math.max(0, quotaLimit - quotaUsed),
      usagePercentage,
      currentSurge,
      isPeak,
      queueLength: parseInt(queueResult.rows[0].queue_length),
    };
  }

  /**
   * 完整的熱區檢查（用於派單前）
   */
  async checkZoneAndQuota(lat: number, lng: number, estimatedFare: number): Promise<ZoneCheckResult> {
    // 1. 找到熱區
    const zone = await this.findZone(lat, lng);

    if (!zone) {
      return {
        inHotZone: false,
        action: 'NORMAL',
        surgeMultiplier: 1.0,
      };
    }

    // 2. 檢查配額
    const quotaStatus = await this.checkQuota(zone.zoneId);

    // 3. 決定動作
    let action: 'NORMAL' | 'SURGE' | 'QUEUE' = 'NORMAL';
    let surgeMultiplier = 1.0;
    let queueInfo: { position: number; estimatedWait: number } | undefined;

    if (quotaStatus.usagePercentage >= 1.0) {
      // 配額用完 → 排隊
      if (zone.queueEnabled && quotaStatus.queueLength < zone.maxQueueSize) {
        action = 'QUEUE';
        queueInfo = {
          position: quotaStatus.queueLength + 1,
          estimatedWait: (quotaStatus.queueLength + 1) * CONFIG.QUEUE.avgWaitPerOrder,
        };
      } else {
        // 排隊已滿或未啟用，仍然漲價到最高
        action = 'SURGE';
      }
      surgeMultiplier = quotaStatus.currentSurge;
    } else if (quotaStatus.usagePercentage >= zone.surgeThreshold) {
      // 超過閾值 → 漲價
      action = 'SURGE';
      surgeMultiplier = quotaStatus.currentSurge;
    }

    return {
      inHotZone: true,
      zone,
      quotaStatus,
      action,
      surgeMultiplier,
      queueInfo,
    };
  }

  /**
   * 消耗配額
   */
  async consumeQuota(zoneId: number, orderId: string, fare: number, surgeMultiplier: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const now = new Date();
      const quotaDate = now.toISOString().split('T')[0];
      const quotaHour = now.getHours();

      // 增加使用量（使用 FOR UPDATE 鎖定）
      const updateResult = await client.query(
        `UPDATE hot_zone_quotas
         SET quota_used = quota_used + 1, updated_at = CURRENT_TIMESTAMP
         WHERE zone_id = $1 AND quota_date = $2 AND quota_hour = $3
         AND quota_used < quota_limit
         RETURNING *`,
        [zoneId, quotaDate, quotaHour]
      );

      if (updateResult.rows.length === 0) {
        // 配額已滿，無法消耗
        await client.query('ROLLBACK');
        return false;
      }

      // 記錄訂單追蹤
      await client.query(
        `INSERT INTO hot_zone_orders (
          zone_id, order_id, quota_date, quota_hour,
          surge_multiplier, original_fare, final_fare
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [zoneId, orderId, quotaDate, quotaHour, surgeMultiplier, fare, Math.round(fare * surgeMultiplier)]
      );

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[HotZoneQuotaService] 消耗配額失敗:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 釋放配額（訂單取消時）
   */
  async releaseQuota(orderId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 找到訂單追蹤記錄
      const trackResult = await client.query(
        `SELECT * FROM hot_zone_orders WHERE order_id = $1 AND quota_released = FALSE`,
        [orderId]
      );

      if (trackResult.rows.length === 0) {
        await client.query('COMMIT');
        return;
      }

      const track = trackResult.rows[0];

      // 減少使用量
      await client.query(
        `UPDATE hot_zone_quotas
         SET quota_used = GREATEST(0, quota_used - 1),
             orders_cancelled = orders_cancelled + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE zone_id = $1 AND quota_date = $2 AND quota_hour = $3`,
        [track.zone_id, track.quota_date, track.quota_hour]
      );

      // 標記已釋放
      await client.query(
        `UPDATE hot_zone_orders
         SET quota_released = TRUE, released_at = CURRENT_TIMESTAMP
         WHERE tracking_id = $1`,
        [track.tracking_id]
      );

      // 檢查排隊中的訂單，釋放第一個
      await this.processQueue(client, track.zone_id);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[HotZoneQuotaService] 釋放配額失敗:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 標記訂單完成
   */
  async markOrderCompleted(orderId: string): Promise<void> {
    await this.pool.query(
      `UPDATE hot_zone_quotas hzq
       SET orders_completed = orders_completed + 1, updated_at = CURRENT_TIMESTAMP
       FROM hot_zone_orders hzo
       WHERE hzo.order_id = $1
         AND hzo.zone_id = hzq.zone_id
         AND hzo.quota_date = hzq.quota_date
         AND hzo.quota_hour = hzq.quota_hour`,
      [orderId]
    );
  }

  // ============================================
  // 排隊管理
  // ============================================

  /**
   * 加入排隊
   */
  async enqueue(
    zoneId: number,
    orderId: string,
    passengerId: string,
    originalFare: number
  ): Promise<QueueEntry> {
    const quotaStatus = await this.checkQuota(zoneId);

    // 計算排隊位置
    const position = quotaStatus.queueLength + 1;
    const estimatedWait = position * CONFIG.QUEUE.avgWaitPerOrder;
    const surgedFare = Math.round(originalFare * quotaStatus.currentSurge);

    const result = await this.pool.query(
      `INSERT INTO hot_zone_queue (
        zone_id, order_id, passenger_id, queue_position,
        estimated_wait_minutes, surge_multiplier, original_fare, surged_fare
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [zoneId, orderId, passengerId, position, estimatedWait, quotaStatus.currentSurge, originalFare, surgedFare]
    );

    const row = result.rows[0];
    return {
      queueId: row.queue_id,
      zoneId: row.zone_id,
      orderId: row.order_id,
      passengerId: row.passenger_id,
      queuePosition: row.queue_position,
      estimatedWaitMinutes: row.estimated_wait_minutes,
      surgeMultiplier: parseFloat(row.surge_multiplier),
      originalFare: row.original_fare,
      surgedFare: row.surged_fare,
      queuedAt: new Date(row.queued_at),
    };
  }

  /**
   * 取消排隊
   */
  async dequeue(orderId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 找到排隊記錄
      const queueResult = await client.query(
        `SELECT * FROM hot_zone_queue WHERE order_id = $1 AND status = 'WAITING'`,
        [orderId]
      );

      if (queueResult.rows.length === 0) {
        await client.query('COMMIT');
        return;
      }

      const queue = queueResult.rows[0];

      // 更新狀態為已取消
      await client.query(
        `UPDATE hot_zone_queue SET status = 'CANCELLED' WHERE queue_id = $1`,
        [queue.queue_id]
      );

      // 更新後面的排隊位置
      await client.query(
        `UPDATE hot_zone_queue
         SET queue_position = queue_position - 1,
             estimated_wait_minutes = (queue_position - 1) * $1
         WHERE zone_id = $2 AND status = 'WAITING' AND queue_position > $3`,
        [CONFIG.QUEUE.avgWaitPerOrder, queue.zone_id, queue.queue_position]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 處理排隊（配額釋放時呼叫）
   */
  private async processQueue(client: PoolClient, zoneId: number): Promise<void> {
    // 找到排隊第一位
    const queueResult = await client.query(
      `SELECT * FROM hot_zone_queue
       WHERE zone_id = $1 AND status = 'WAITING'
       ORDER BY queue_position ASC
       LIMIT 1
       FOR UPDATE`,
      [zoneId]
    );

    if (queueResult.rows.length === 0) return;

    const queue = queueResult.rows[0];

    // 釋放排隊
    await client.query(
      `UPDATE hot_zone_queue
       SET status = 'RELEASED', released_at = CURRENT_TIMESTAMP, release_reason = 'QUOTA_AVAILABLE'
       WHERE queue_id = $1`,
      [queue.queue_id]
    );

    // 更新其他排隊位置
    await client.query(
      `UPDATE hot_zone_queue
       SET queue_position = queue_position - 1,
           estimated_wait_minutes = (queue_position - 1) * $1
       WHERE zone_id = $2 AND status = 'WAITING'`,
      [CONFIG.QUEUE.avgWaitPerOrder, zoneId]
    );

    // TODO: 發送 WebSocket 通知給乘客
    console.log(`[HotZoneQuotaService] 排隊訂單 ${queue.order_id} 已釋放`);
  }

  /**
   * 清理超時排隊
   */
  async cleanupExpiredQueue(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE hot_zone_queue
       SET status = 'EXPIRED', release_reason = 'TIMEOUT'
       WHERE status = 'WAITING'
         AND queued_at < NOW() - INTERVAL '1 minute' * $1
       RETURNING queue_id`,
      [CONFIG.QUEUE.maxTimeout]
    );

    return result.rowCount || 0;
  }

  // ============================================
  // 統計查詢
  // ============================================

  /**
   * 獲取所有熱區當前狀態
   */
  async getAllZoneStatus(): Promise<QuotaStatus[]> {
    const zones = await this.getAllActiveZones();
    const statuses: QuotaStatus[] = [];

    for (const zone of zones) {
      try {
        const status = await this.checkQuota(zone.zoneId);
        statuses.push(status);
      } catch (error) {
        console.error(`[HotZoneQuotaService] 獲取熱區 ${zone.zoneName} 狀態失敗:`, error);
      }
    }

    return statuses;
  }

  /**
   * 獲取熱區統計
   */
  async getZoneStats(zoneId: number, days: number = 7): Promise<{
    totalOrders: number;
    totalFare: number;
    avgSurge: number;
    peakUsage: number;
    cancelRate: number;
  }> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const result = await this.pool.query(
      `SELECT
        COUNT(*) as total_orders,
        COALESCE(SUM(final_fare), 0) as total_fare,
        COALESCE(AVG(surge_multiplier), 1.0) as avg_surge
       FROM hot_zone_orders
       WHERE zone_id = $1 AND created_at >= $2`,
      [zoneId, startDate]
    );

    const quotaResult = await this.pool.query(
      `SELECT
        MAX(CAST(quota_used AS DECIMAL) / NULLIF(quota_limit, 0)) as peak_usage,
        COALESCE(SUM(orders_cancelled), 0) as cancelled,
        COALESCE(SUM(orders_completed), 0) as completed
       FROM hot_zone_quotas
       WHERE zone_id = $1 AND quota_date >= $2`,
      [zoneId, startDate.toISOString().split('T')[0]]
    );

    const orderRow = result.rows[0];
    const quotaRow = quotaResult.rows[0];

    const completed = parseInt(quotaRow.completed) || 0;
    const cancelled = parseInt(quotaRow.cancelled) || 0;
    const total = completed + cancelled;

    return {
      totalOrders: parseInt(orderRow.total_orders) || 0,
      totalFare: parseInt(orderRow.total_fare) || 0,
      avgSurge: parseFloat(orderRow.avg_surge) || 1.0,
      peakUsage: parseFloat(quotaRow.peak_usage) || 0,
      cancelRate: total > 0 ? cancelled / total : 0,
    };
  }

  // ============================================
  // 管理功能
  // ============================================

  /**
   * 新增熱區
   */
  async createZone(config: Omit<HotZoneConfig, 'zoneId'>): Promise<HotZoneConfig> {
    const result = await this.pool.query(
      `INSERT INTO hot_zone_configs (
        zone_name, center_lat, center_lng, radius_km, peak_hours,
        hourly_quota_normal, hourly_quota_peak, surge_threshold,
        surge_multiplier_max, surge_step, queue_enabled, max_queue_size,
        queue_timeout_minutes, is_active, priority
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        config.zoneName, config.centerLat, config.centerLng, config.radiusKm,
        JSON.stringify(config.peakHours), config.hourlyQuotaNormal, config.hourlyQuotaPeak,
        config.surgeThreshold, config.surgeMultiplierMax, config.surgeStep,
        config.queueEnabled, config.maxQueueSize, config.queueTimeoutMinutes,
        config.isActive, config.priority
      ]
    );

    // 清除快取
    this.zoneCache.clear();

    return this.mapRowToZoneConfig(result.rows[0]);
  }

  /**
   * 更新熱區
   */
  async updateZone(zoneId: number, updates: Partial<HotZoneConfig>): Promise<HotZoneConfig | null> {
    const zone = await this.getZone(zoneId);
    if (!zone) return null;

    const updated = { ...zone, ...updates };

    await this.pool.query(
      `UPDATE hot_zone_configs SET
        zone_name = $2, center_lat = $3, center_lng = $4, radius_km = $5,
        peak_hours = $6, hourly_quota_normal = $7, hourly_quota_peak = $8,
        surge_threshold = $9, surge_multiplier_max = $10, surge_step = $11,
        queue_enabled = $12, max_queue_size = $13, queue_timeout_minutes = $14,
        is_active = $15, priority = $16, updated_at = CURRENT_TIMESTAMP
       WHERE zone_id = $1`,
      [
        zoneId, updated.zoneName, updated.centerLat, updated.centerLng, updated.radiusKm,
        JSON.stringify(updated.peakHours), updated.hourlyQuotaNormal, updated.hourlyQuotaPeak,
        updated.surgeThreshold, updated.surgeMultiplierMax, updated.surgeStep,
        updated.queueEnabled, updated.maxQueueSize, updated.queueTimeoutMinutes,
        updated.isActive, updated.priority
      ]
    );

    // 清除快取
    this.zoneCache.clear();

    return updated;
  }

  // ============================================
  // 工具方法
  // ============================================

  /**
   * 計算兩點距離（Haversine 公式）
   */
  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const toRad = (deg: number) => deg * Math.PI / 180;

    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return CONFIG.EARTH_RADIUS_KM * c;
  }

  /**
   * 計算漲價倍率
   */
  private calculateSurgeMultiplier(
    usagePercentage: number,
    threshold: number,
    maxMultiplier: number,
    step: number
  ): number {
    if (usagePercentage < threshold) return 1.0;

    const overThreshold = usagePercentage - threshold;
    const steps = Math.ceil(overThreshold / step);
    const surge = 1.0 + steps * 0.10;

    return Math.min(surge, maxMultiplier);
  }

  /**
   * 清除快取
   */
  clearCache(): void {
    this.zoneCache.clear();
    this.zoneCacheTime = 0;
  }
}

// ============================================
// 匯出單例
// ============================================

let hotZoneServiceInstance: HotZoneQuotaService | null = null;

export function getHotZoneQuotaService(pool: Pool): HotZoneQuotaService {
  if (!hotZoneServiceInstance) {
    hotZoneServiceInstance = new HotZoneQuotaService(pool);
  }
  return hotZoneServiceInstance;
}

export function resetHotZoneQuotaService(): void {
  hotZoneServiceInstance = null;
}

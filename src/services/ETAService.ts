/**
 * 花蓮計程車系統 - ETA 服務
 * 混合 ETA 策略：< 3km 用估算，>= 3km 用 Google Distance Matrix API
 *
 * 功能：
 * 1. Haversine 距離計算
 * 2. Google Distance Matrix API 調用
 * 3. ETA 快取管理
 * 4. API 用量監控
 */

import { Pool } from 'pg';

// ============================================
// 類型定義
// ============================================

export interface Location {
  lat: number;
  lng: number;
}

export interface ETAResult {
  seconds: number;
  distanceMeters: number;
  source: 'ESTIMATED' | 'CACHED' | 'GOOGLE_API';
}

export interface ETACacheEntry {
  cache_id: number;
  distance_meters: number;
  duration_seconds: number;
  hour_of_day: number;
  cached_at: Date;
  hit_count: number;
}

// ============================================
// 配置
// ============================================

const CONFIG = {
  // 混合策略閾值
  GOOGLE_API_DISTANCE_THRESHOLD_KM: 3,

  // 估算參數
  ROAD_FACTOR: 1.3,              // 實際路程係數（直線 * 1.3）
  BASE_SPEED_KMH: 25,            // 基礎速度 km/h
  PEAK_SPEED_KMH: 18,            // 高峰期速度
  NIGHT_SPEED_KMH: 35,           // 深夜速度
  MIN_ETA_SECONDS: 180,          // 最小 ETA（3 分鐘）

  // 高峰時段
  PEAK_HOURS: [7, 8, 17, 18, 19],
  NIGHT_HOURS: [23, 0, 1, 2, 3, 4, 5],

  // 快取設定
  CACHE_PRECISION: 4,            // 座標精度（小數點後 4 位，約 10 公尺）
  CACHE_TTL_HOURS: 1,            // 快取有效期

  // API 限制
  DAILY_API_LIMIT: 100,          // 每日 API 調用上限
};

// ============================================
// ETA 服務類
// ============================================

export class ETAService {
  private pool: Pool;
  private googleMapsApiKey: string;
  private dailyApiCalls: number = 0;
  private lastResetDate: string = '';

  // 內存快取（加速頻繁查詢）
  private memoryCache: Map<string, { result: ETAResult; expireAt: number }> = new Map();

  constructor(pool: Pool, googleMapsApiKey: string) {
    this.pool = pool;
    this.googleMapsApiKey = googleMapsApiKey;

    // 每小時清理過期內存快取
    setInterval(() => this.cleanupMemoryCache(), 3600000);

    // 初始化時清理資料庫過期快取
    this.cleanupExpiredDBCache();
  }

  /**
   * 獲取 ETA（主方法）
   * 混合策略：< 3km 用估算，>= 3km 用 Google API
   */
  async getETA(origin: Location, destination: Location): Promise<ETAResult> {
    const directDistance = this.calculateHaversineDistance(origin, destination);

    // < 3km 用估算
    if (directDistance < CONFIG.GOOGLE_API_DISTANCE_THRESHOLD_KM) {
      return this.estimateETA(directDistance);
    }

    // >= 3km 先查快取
    const cached = await this.checkCache(origin, destination);
    if (cached) {
      return cached;
    }

    // 檢查 API 配額
    if (!this.canCallGoogleAPI()) {
      console.log('[ETAService] API 配額已用完，使用估算');
      return this.estimateETA(directDistance);
    }

    // 調用 Google API
    try {
      const apiResult = await this.callGoogleDistanceMatrixAPI(origin, destination);
      await this.saveToCache(origin, destination, apiResult);
      return apiResult;
    } catch (error) {
      console.error('[ETAService] Google API 調用失敗，使用估算:', error);
      return this.estimateETA(directDistance);
    }
  }

  /**
   * 批量獲取 ETA（用於一次評估多個司機）
   */
  async getBatchETA(
    drivers: Array<{ driverId: string; location: Location }>,
    destination: Location
  ): Promise<Map<string, ETAResult>> {
    const results = new Map<string, ETAResult>();

    // 分類：需要 API 的和可以估算的
    const needsAPI: Array<{ driverId: string; location: Location; distance: number }> = [];
    const canEstimate: Array<{ driverId: string; location: Location; distance: number }> = [];

    for (const driver of drivers) {
      const distance = this.calculateHaversineDistance(driver.location, destination);

      if (distance < CONFIG.GOOGLE_API_DISTANCE_THRESHOLD_KM) {
        canEstimate.push({ ...driver, distance });
      } else {
        // 先查快取
        const cached = await this.checkCache(driver.location, destination);
        if (cached) {
          results.set(driver.driverId, cached);
        } else {
          needsAPI.push({ ...driver, distance });
        }
      }
    }

    // 處理可估算的
    for (const item of canEstimate) {
      results.set(item.driverId, this.estimateETA(item.distance));
    }

    // 批量處理需要 API 的（最多 25 個，Google API 限制）
    if (needsAPI.length > 0 && this.canCallGoogleAPI()) {
      const batchSize = Math.min(needsAPI.length, 25);
      const batch = needsAPI.slice(0, batchSize);

      try {
        const apiResults = await this.callGoogleBatchAPI(
          batch.map(d => d.location),
          destination
        );

        for (let i = 0; i < batch.length; i++) {
          if (apiResults[i]) {
            results.set(batch[i].driverId, apiResults[i]);
            await this.saveToCache(batch[i].location, destination, apiResults[i]);
          } else {
            results.set(batch[i].driverId, this.estimateETA(batch[i].distance));
          }
        }
      } catch (error) {
        console.error('[ETAService] 批量 API 調用失敗:', error);
        // 回退到估算
        for (const item of batch) {
          results.set(item.driverId, this.estimateETA(item.distance));
        }
      }

      // 剩餘的用估算
      for (let i = batchSize; i < needsAPI.length; i++) {
        results.set(needsAPI[i].driverId, this.estimateETA(needsAPI[i].distance));
      }
    } else {
      // API 配額不足，全部用估算
      for (const item of needsAPI) {
        results.set(item.driverId, this.estimateETA(item.distance));
      }
    }

    return results;
  }

  /**
   * 計算 Haversine 距離（公里）
   */
  calculateHaversineDistance(origin: Location, destination: Location): number {
    const R = 6371; // 地球半徑（公里）
    const dLat = this.toRadians(destination.lat - origin.lat);
    const dLng = this.toRadians(destination.lng - origin.lng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(origin.lat)) *
        Math.cos(this.toRadians(destination.lat)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * 估算 ETA（不調用 API）
   */
  private estimateETA(directDistanceKm: number): ETAResult {
    const hour = new Date().getHours();

    // 根據時段選擇速度
    let speedKmh = CONFIG.BASE_SPEED_KMH;
    if (CONFIG.PEAK_HOURS.includes(hour)) {
      speedKmh = CONFIG.PEAK_SPEED_KMH;
    } else if (CONFIG.NIGHT_HOURS.includes(hour)) {
      speedKmh = CONFIG.NIGHT_SPEED_KMH;
    }

    // 估算實際路程距離
    const roadDistanceKm = directDistanceKm * CONFIG.ROAD_FACTOR;
    const roadDistanceMeters = Math.round(roadDistanceKm * 1000);

    // 計算 ETA
    const etaSeconds = Math.max(
      CONFIG.MIN_ETA_SECONDS,
      Math.ceil((roadDistanceKm / speedKmh) * 3600)
    );

    return {
      seconds: etaSeconds,
      distanceMeters: roadDistanceMeters,
      source: 'ESTIMATED',
    };
  }

  /**
   * 檢查快取
   */
  private async checkCache(origin: Location, destination: Location): Promise<ETAResult | null> {
    const hour = new Date().getHours();

    // 先查內存快取
    const memKey = this.getCacheKey(origin, destination, hour);
    const memCached = this.memoryCache.get(memKey);
    if (memCached && memCached.expireAt > Date.now()) {
      return memCached.result;
    }

    // 查資料庫快取
    const roundedOrigin = this.roundCoordinates(origin);
    const roundedDest = this.roundCoordinates(destination);

    try {
      const result = await this.pool.query(
        `SELECT distance_meters, duration_seconds, hit_count
         FROM eta_cache
         WHERE origin_lat = $1 AND origin_lng = $2
           AND dest_lat = $3 AND dest_lng = $4
           AND hour_of_day = $5
           AND expires_at > CURRENT_TIMESTAMP`,
        [roundedOrigin.lat, roundedOrigin.lng, roundedDest.lat, roundedDest.lng, hour]
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];

        // 更新命中次數
        await this.pool.query(
          `UPDATE eta_cache SET hit_count = hit_count + 1
           WHERE origin_lat = $1 AND origin_lng = $2
             AND dest_lat = $3 AND dest_lng = $4
             AND hour_of_day = $5`,
          [roundedOrigin.lat, roundedOrigin.lng, roundedDest.lat, roundedDest.lng, hour]
        );

        const cached: ETAResult = {
          seconds: row.duration_seconds,
          distanceMeters: row.distance_meters,
          source: 'CACHED',
        };

        // 存入內存快取
        this.memoryCache.set(memKey, {
          result: cached,
          expireAt: Date.now() + CONFIG.CACHE_TTL_HOURS * 3600 * 1000,
        });

        return cached;
      }
    } catch (error) {
      console.error('[ETAService] 查詢快取失敗:', error);
    }

    return null;
  }

  /**
   * 儲存到快取
   */
  private async saveToCache(origin: Location, destination: Location, result: ETAResult): Promise<void> {
    const hour = new Date().getHours();
    const roundedOrigin = this.roundCoordinates(origin);
    const roundedDest = this.roundCoordinates(destination);

    try {
      await this.pool.query(
        `INSERT INTO eta_cache (origin_lat, origin_lng, dest_lat, dest_lng, distance_meters, duration_seconds, hour_of_day)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (origin_lat, origin_lng, dest_lat, dest_lng, hour_of_day)
         DO UPDATE SET
           distance_meters = EXCLUDED.distance_meters,
           duration_seconds = EXCLUDED.duration_seconds,
           cached_at = CURRENT_TIMESTAMP,
           expires_at = CURRENT_TIMESTAMP + INTERVAL '1 hour'`,
        [
          roundedOrigin.lat,
          roundedOrigin.lng,
          roundedDest.lat,
          roundedDest.lng,
          result.distanceMeters,
          result.seconds,
          hour,
        ]
      );

      // 存入內存快取
      const memKey = this.getCacheKey(origin, destination, hour);
      this.memoryCache.set(memKey, {
        result,
        expireAt: Date.now() + CONFIG.CACHE_TTL_HOURS * 3600 * 1000,
      });
    } catch (error) {
      console.error('[ETAService] 儲存快取失敗:', error);
    }
  }

  /**
   * 調用 Google Distance Matrix API
   */
  private async callGoogleDistanceMatrixAPI(
    origin: Location,
    destination: Location
  ): Promise<ETAResult> {
    const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
    url.searchParams.set('origins', `${origin.lat},${origin.lng}`);
    url.searchParams.set('destinations', `${destination.lat},${destination.lng}`);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('departure_time', 'now');
    url.searchParams.set('key', this.googleMapsApiKey);

    this.incrementApiCalls();

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.status !== 'OK' || !data.rows?.[0]?.elements?.[0]) {
      throw new Error(`Google API 錯誤: ${data.status}`);
    }

    const element = data.rows[0].elements[0];
    if (element.status !== 'OK') {
      throw new Error(`路線計算失敗: ${element.status}`);
    }

    console.log(`[ETAService] Google API: ${element.distance.text}, ${element.duration.text}`);

    return {
      seconds: element.duration_in_traffic?.value || element.duration.value,
      distanceMeters: element.distance.value,
      source: 'GOOGLE_API',
    };
  }

  /**
   * 批量調用 Google Distance Matrix API
   */
  private async callGoogleBatchAPI(
    origins: Location[],
    destination: Location
  ): Promise<ETAResult[]> {
    const originsStr = origins.map(o => `${o.lat},${o.lng}`).join('|');

    const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
    url.searchParams.set('origins', originsStr);
    url.searchParams.set('destinations', `${destination.lat},${destination.lng}`);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('departure_time', 'now');
    url.searchParams.set('key', this.googleMapsApiKey);

    this.incrementApiCalls();

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.status !== 'OK') {
      throw new Error(`Google API 錯誤: ${data.status}`);
    }

    console.log(`[ETAService] Google Batch API: ${origins.length} 個起點`);

    return data.rows.map((row: any) => {
      const element = row.elements[0];
      if (element.status !== 'OK') {
        return null;
      }
      return {
        seconds: element.duration_in_traffic?.value || element.duration.value,
        distanceMeters: element.distance.value,
        source: 'GOOGLE_API' as const,
      };
    });
  }

  /**
   * 檢查是否可以調用 Google API
   */
  private canCallGoogleAPI(): boolean {
    this.resetDailyCounterIfNeeded();
    return this.dailyApiCalls < CONFIG.DAILY_API_LIMIT;
  }

  /**
   * 增加 API 調用計數
   */
  private incrementApiCalls(): void {
    this.resetDailyCounterIfNeeded();
    this.dailyApiCalls++;
    console.log(`[ETAService] API 調用次數: ${this.dailyApiCalls}/${CONFIG.DAILY_API_LIMIT}`);
  }

  /**
   * 重置每日計數器
   */
  private resetDailyCounterIfNeeded(): void {
    const today = new Date().toISOString().split('T')[0];
    if (this.lastResetDate !== today) {
      this.dailyApiCalls = 0;
      this.lastResetDate = today;
      console.log('[ETAService] 每日 API 計數器已重置');
    }
  }

  /**
   * 清理過期資料庫快取
   */
  private async cleanupExpiredDBCache(): Promise<void> {
    try {
      const result = await this.pool.query(
        `DELETE FROM eta_cache WHERE expires_at < CURRENT_TIMESTAMP`
      );
      if (result.rowCount && result.rowCount > 0) {
        console.log(`[ETAService] 清理 ${result.rowCount} 筆過期快取`);
      }
    } catch (error) {
      console.error('[ETAService] 清理快取失敗:', error);
    }
  }

  /**
   * 清理內存快取
   */
  private cleanupMemoryCache(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of this.memoryCache.entries()) {
      if (value.expireAt < now) {
        this.memoryCache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[ETAService] 清理 ${cleaned} 筆內存快取`);
    }
  }

  /**
   * 獲取快取統計
   */
  async getCacheStats(): Promise<{
    dbCacheCount: number;
    memoryCacheCount: number;
    totalHits: number;
    dailyApiCalls: number;
    dailyApiLimit: number;
  }> {
    const dbResult = await this.pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(hit_count), 0) as total_hits
       FROM eta_cache
       WHERE expires_at > CURRENT_TIMESTAMP`
    );

    return {
      dbCacheCount: parseInt(dbResult.rows[0].count),
      memoryCacheCount: this.memoryCache.size,
      totalHits: parseInt(dbResult.rows[0].total_hits),
      dailyApiCalls: this.dailyApiCalls,
      dailyApiLimit: CONFIG.DAILY_API_LIMIT,
    };
  }

  // ============================================
  // 輔助方法
  // ============================================

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  private roundCoordinates(location: Location): Location {
    const factor = Math.pow(10, CONFIG.CACHE_PRECISION);
    return {
      lat: Math.round(location.lat * factor) / factor,
      lng: Math.round(location.lng * factor) / factor,
    };
  }

  private getCacheKey(origin: Location, destination: Location, hour: number): string {
    const o = this.roundCoordinates(origin);
    const d = this.roundCoordinates(destination);
    return `${o.lat},${o.lng}-${d.lat},${d.lng}-${hour}`;
  }
}

// ============================================
// 單例
// ============================================

let etaServiceInstance: ETAService | null = null;

export function initETAService(pool: Pool, googleMapsApiKey: string): ETAService {
  if (!etaServiceInstance) {
    etaServiceInstance = new ETAService(pool, googleMapsApiKey);
    console.log('[ETAService] 初始化完成');
  }
  return etaServiceInstance;
}

export function getETAService(): ETAService {
  if (!etaServiceInstance) {
    throw new Error('[ETAService] 尚未初始化，請先呼叫 initETAService()');
  }
  return etaServiceInstance;
}

/**
 * QueueZoneResolver — 判斷座標落在哪個 active queue zone（圓形）
 *
 * 設計：
 *   - 啟動時 + 每 60s 從 DB 拉一次 zones 進記憶體（在班司機 join/leave 不會頻繁改 zone 定義）
 *   - resolveZone(lat, lng) 跑 Haversine 距離 vs radius_meters，返回第一個命中（zone 數量極少 O(N)）
 *   - 若多個 zone 重疊，返回半徑最小的（最精準命中）
 *
 * 使用：dispatcher 派單入口呼叫一次決定是否走 Queue 流程
 */

import pool from '../db/connection';

export interface ZoneCacheEntry {
  zone_id: string;
  name: string;
  center_lat: number;
  center_lng: number;
  radius_meters: number;
  /** SERIAL = 嚴格排班順位（一次一人 15s）；PARALLEL = 批次推播（先按先贏）。Migration 026 加。 */
  dispatch_mode: 'SERIAL' | 'PARALLEL';
}

class QueueZoneResolverImpl {
  private zones: ZoneCacheEntry[] = [];
  private lastRefreshAt: number = 0;
  private readonly REFRESH_INTERVAL_MS = 60 * 1000;

  /**
   * 強制重新載入 zone list（admin 改 zone 後可手動觸發）
   */
  async refresh(): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT zone_id, name, center_lat, center_lng, radius_meters,
                COALESCE(dispatch_mode, 'PARALLEL') AS dispatch_mode
         FROM queue_zones
         WHERE is_active = true`
      );
      this.zones = result.rows.map(r => ({
        zone_id: r.zone_id,
        name: r.name,
        center_lat: parseFloat(r.center_lat),
        center_lng: parseFloat(r.center_lng),
        radius_meters: r.radius_meters,
        dispatch_mode: (r.dispatch_mode === 'SERIAL' ? 'SERIAL' : 'PARALLEL') as 'SERIAL' | 'PARALLEL',
      }));
      this.lastRefreshAt = Date.now();
      console.log(`[QueueZoneResolver] 載入 ${this.zones.length} 個 active zones`);
    } catch (e: any) {
      console.error('[QueueZoneResolver] refresh 失敗:', e.message);
    }
  }

  /**
   * 取得 zones 快取（自動 refresh if stale）
   */
  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.lastRefreshAt > this.REFRESH_INTERVAL_MS) {
      await this.refresh();
    }
  }

  /**
   * 判斷座標落在哪個 zone。返回 null 表示不在任何 zone。
   * 多 zone 重疊時取半徑最小的（最精準）。
   */
  async resolveZone(lat: number, lng: number): Promise<ZoneCacheEntry | null> {
    await this.ensureFresh();
    if (this.zones.length === 0) return null;

    let best: ZoneCacheEntry | null = null;
    let bestRadius = Infinity;

    for (const z of this.zones) {
      const dist = this.haversine(lat, lng, z.center_lat, z.center_lng);
      if (dist <= z.radius_meters && z.radius_meters < bestRadius) {
        best = z;
        bestRadius = z.radius_meters;
      }
    }
    return best;
  }

  /**
   * Haversine 距離（公尺）
   */
  haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const toRad = (deg: number) => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

export const queueZoneResolver = new QueueZoneResolverImpl();

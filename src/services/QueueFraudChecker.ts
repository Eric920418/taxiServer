/**
 * QueueFraudChecker — 每分鐘掃 ACTIVE 排班 entries 踢出不符條件的司機
 *
 * 踢出條件：
 *   1. 司機 availability != AVAILABLE（OFFLINE/REST/ON_TRIP）→ reason='OFFLINE' / 'BUSY'
 *   2. GPS 漂出 zone（連續 100m 偏離 2 分鐘）→ reason='GPS_OUT'
 *   3. 加入 > 30 分鐘沒接到單 → reason='EXPIRED'
 *
 * 設計：
 *   - 用 driverLocations memory 取最新 GPS（比 DB 新）
 *   - GPS 漂出用「last_drift_at」追蹤連續性，避免短暫 GPS 抖動誤踢
 *   - 簡化：本實作沒持久 last_drift_at，每次掃如果偏離就標暫時 marker（記憶體）
 */

import pool from '../db/connection';
import { driverSockets, driverLocations } from '../socket';
import { queueZoneResolver } from './QueueZoneResolver';

const MAX_QUEUE_MINUTES = 30;
const GPS_DRIFT_TOLERANCE_METERS = 100;
const GPS_DRIFT_GRACE_SECONDS = 120; // 連續偏離 2 分鐘才算

class QueueFraudCheckerImpl {
  // 記憶體追蹤每個 driver_id 第一次 GPS 偏離的時間（連續偏離超過 GRACE 才踢）
  private driftSince: Map<string, number> = new Map();

  /**
   * 每分鐘執行一次
   */
  async checkOnce(): Promise<void> {
    try {
      // 抓所有 ACTIVE entries + 對應 zone + driver
      const result = await pool.query(
        `SELECT qe.entry_id, qe.driver_id, qe.zone_id, qe.joined_at,
                z.center_lat, z.center_lng, z.radius_meters,
                d.availability, d.current_lat, d.current_lng
         FROM queue_entries qe
         JOIN queue_zones z ON z.zone_id = qe.zone_id
         JOIN drivers d ON d.driver_id = qe.driver_id
         WHERE qe.status = 'ACTIVE'`
      );
      if (result.rows.length === 0) return;

      const now = Date.now();
      const toKickIds: Array<{ driver_id: string; reason: string }> = [];

      for (const row of result.rows) {
        const driverId = row.driver_id;

        // 條件 1：司機不在線（OFFLINE）
        if (row.availability === 'OFFLINE') {
          toKickIds.push({ driver_id: driverId, reason: 'OFFLINE' });
          this.driftSince.delete(driverId);
          continue;
        }
        // 條件 1b：司機 ON_TRIP（接單後應該被 markDispatched 標走，但 cron 兜底）
        if (row.availability === 'ON_TRIP') {
          toKickIds.push({ driver_id: driverId, reason: 'BUSY' });
          this.driftSince.delete(driverId);
          continue;
        }

        // 條件 2：GPS 漂出 zone 連續 GRACE 秒
        const realtimeLoc = driverLocations.get(driverId);
        const lat = realtimeLoc?.lat ?? (row.current_lat ? parseFloat(row.current_lat) : null);
        const lng = realtimeLoc?.lng ?? (row.current_lng ? parseFloat(row.current_lng) : null);

        if (lat !== null && lng !== null) {
          const dist = queueZoneResolver.haversine(
            lat, lng,
            parseFloat(row.center_lat), parseFloat(row.center_lng),
          );
          const limit = parseInt(row.radius_meters) + GPS_DRIFT_TOLERANCE_METERS;
          if (dist > limit) {
            // 偏離了 — 看是否累計超過 GRACE
            const firstDriftAt = this.driftSince.get(driverId);
            if (firstDriftAt === undefined) {
              this.driftSince.set(driverId, now);
            } else if ((now - firstDriftAt) / 1000 >= GPS_DRIFT_GRACE_SECONDS) {
              toKickIds.push({ driver_id: driverId, reason: 'GPS_OUT' });
              this.driftSince.delete(driverId);
              continue;
            }
          } else {
            // 回到 zone 內 → 清除 drift marker
            this.driftSince.delete(driverId);
          }
        }

        // 條件 3：超過最長排班時間
        const joinedAtMs = new Date(row.joined_at).getTime();
        const minutesInQueue = (now - joinedAtMs) / 60000;
        if (minutesInQueue > MAX_QUEUE_MINUTES) {
          toKickIds.push({ driver_id: driverId, reason: 'EXPIRED' });
          this.driftSince.delete(driverId);
          continue;
        }

        // 條件 4：司機沒在 socket 連線（雖然 availability != OFFLINE 但可能 zombie）
        if (!driverSockets.has(driverId)) {
          toKickIds.push({ driver_id: driverId, reason: 'NO_SOCKET' });
          this.driftSince.delete(driverId);
          continue;
        }
      }

      // 批次踢出
      if (toKickIds.length > 0) {
        for (const k of toKickIds) {
          await pool.query(
            `UPDATE queue_entries
             SET status = 'LEFT',
                 left_at = CURRENT_TIMESTAMP,
                 left_reason = $2
             WHERE driver_id = $1 AND status = 'ACTIVE'`,
            [k.driver_id, k.reason]
          );
          console.log(`[QueueFraudChecker] 踢出 ${k.driver_id}: ${k.reason}`);
        }
      }
    } catch (e: any) {
      console.error('[QueueFraudChecker] 掃描失敗:', e.message);
    }
  }
}

export const queueFraudChecker = new QueueFraudCheckerImpl();

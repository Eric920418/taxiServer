/**
 * QueueOrderingService — 取得某 zone 內可派的排班司機，依規則排序
 *
 * 排序規則（業主 spec）：
 *   1. 折扣接受度（max_acceptable_discount_amount DESC）— 願意給客人折扣多的優先
 *   2. FIFO（joined_at ASC）— 先進先出
 *   3. 距離（pickup 到司機目前位置 ASC）— 最後 tiebreaker
 *
 * 匹配條件：
 *   - status = 'ACTIVE'
 *   - max_acceptable_discount_amount >= order.discount_amount
 *     （訂單抽成 ≤ 司機能接受的最大抽成）
 *   - 司機目前在線（driverSockets 有 socket 連線）
 *
 * 回傳格式：可直接 emit order:offer 給司機 socket
 */

import pool from '../db/connection';
import { driverSockets, driverLocations } from '../socket';
import { queueZoneResolver } from './QueueZoneResolver';

export interface QueueDriverCandidate {
  driver_id: string;
  entry_id: number;
  joined_at: Date;
  max_acceptable_discount_amount: number;
  current_lat: number | null;
  current_lng: number | null;
  distance_meters_to_pickup: number | null;
  socket_id: string | null;
}

export class QueueOrderingService {
  /**
   * 取得某 zone 內合資格的排班司機（排序好的）
   *
   * @param zoneId
   * @param orderDiscountAmount 訂單抽成 % (司機 max_acceptable >= 此值才符合)
   * @param pickupLat / pickupLng 訂單上車點，給距離排序用
   */
  async getQueueDriversForOrder(
    zoneId: string,
    orderDiscountAmount: number,
    pickupLat: number,
    pickupLng: number,
  ): Promise<QueueDriverCandidate[]> {
    const result = await pool.query(
      `SELECT qe.entry_id, qe.driver_id, qe.joined_at, qe.max_acceptable_discount_amount,
              d.current_lat, d.current_lng, d.availability
       FROM queue_entries qe
       JOIN drivers d ON d.driver_id = qe.driver_id
       WHERE qe.zone_id = $1
         AND qe.status = 'ACTIVE'
         AND qe.max_acceptable_discount_amount >= $2
         AND d.availability = 'AVAILABLE'`,
      [zoneId, orderDiscountAmount]
    );

    if (result.rows.length === 0) return [];

    // 篩掉沒在線的司機（driverSockets memory check）
    // 加上 distance + socket，做最終排序
    const candidates: QueueDriverCandidate[] = [];
    for (const row of result.rows) {
      const socketId = driverSockets.get(row.driver_id);
      if (!socketId) continue; // 沒在線跳過

      // 取最即時座標（driverLocations 比 DB 新）
      const realtimeLoc = driverLocations.get(row.driver_id);
      const lat = realtimeLoc?.lat ?? (row.current_lat ? parseFloat(row.current_lat) : null);
      const lng = realtimeLoc?.lng ?? (row.current_lng ? parseFloat(row.current_lng) : null);

      const distance = lat !== null && lng !== null
        ? queueZoneResolver.haversine(pickupLat, pickupLng, lat, lng)
        : null;

      candidates.push({
        driver_id: row.driver_id,
        entry_id: row.entry_id,
        joined_at: row.joined_at,
        max_acceptable_discount_amount: row.max_acceptable_discount_amount,
        current_lat: lat,
        current_lng: lng,
        distance_meters_to_pickup: distance,
        socket_id: socketId,
      });
    }

    // 排序：回饋金 DESC > FIFO ASC > 距離 ASC
    candidates.sort((a, b) => {
      // 1. max_acceptable_discount_amount DESC
      if (b.max_acceptable_discount_amount !== a.max_acceptable_discount_amount) {
        return b.max_acceptable_discount_amount - a.max_acceptable_discount_amount;
      }
      // 2. joined_at ASC
      const tA = new Date(a.joined_at).getTime();
      const tB = new Date(b.joined_at).getTime();
      if (tA !== tB) return tA - tB;
      // 3. distance ASC（null 視為最遠）
      const dA = a.distance_meters_to_pickup ?? Infinity;
      const dB = b.distance_meters_to_pickup ?? Infinity;
      return dA - dB;
    });

    return candidates;
  }

  /**
   * 司機接 queue 訂單後標記其 entry 為 LEFT (已派出)
   */
  async markDispatched(driverId: string): Promise<void> {
    await pool.query(
      `UPDATE queue_entries
       SET status = 'LEFT', left_at = CURRENT_TIMESTAMP, left_reason = 'ACCEPTED'
       WHERE driver_id = $1 AND status = 'ACTIVE'`,
      [driverId]
    );
  }

  /**
   * 司機拒 queue 訂單 → 移到隊尾（更新 joined_at = NOW，status 維持 ACTIVE）
   */
  async moveToTail(driverId: string): Promise<void> {
    await pool.query(
      `UPDATE queue_entries
       SET joined_at = CURRENT_TIMESTAMP
       WHERE driver_id = $1 AND status = 'ACTIVE'`,
      [driverId]
    );
  }
}

export const queueOrderingService = new QueueOrderingService();

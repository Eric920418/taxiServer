/**
 * queue.ts — 司機排班 endpoints (driver-facing)
 *
 * 條件 (P3 加防作弊 cron 後會自動踢出，這裡只擋加入):
 *   - 司機在線（availability != OFFLINE）
 *   - 不在 ON_TRIP（沒進行中訂單）
 *   - GPS 必須在 zone 內（圓心 + radius，Haversine 計算）
 *
 * 一個司機同時只能在一個 ACTIVE 排班（DB UNIQUE INDEX 強制）
 */

import { Router, Request, Response } from 'express';
import pool from '../db/connection';

const router = Router();

/**
 * Haversine 距離（公尺）
 */
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
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

// GET /api/queue/zones — 列出 active zones + 即時排班數
// 司機 App 用來顯示「前站｜6  慈濟｜3」這種格式
router.get('/zones', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT z.zone_id, z.name, z.center_lat, z.center_lng, z.radius_meters,
              COALESCE((
                SELECT COUNT(*) FROM queue_entries qe
                WHERE qe.zone_id = z.zone_id AND qe.status = 'ACTIVE'
              ), 0)::int AS active_drivers
       FROM queue_zones z
       WHERE z.is_active = true
       ORDER BY z.name`
    );
    res.json({ zones: result.rows });
  } catch (e: any) {
    console.error('[Queue] list zones 錯誤:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/queue/my-status?driver_id=D001
// 司機目前是否在某 zone 排班
router.get('/my-status', async (req: Request, res: Response) => {
  const driverId = req.query.driver_id as string;
  if (!driverId) return res.status(400).json({ error: '缺少 driver_id' });

  try {
    const result = await pool.query(
      `SELECT qe.entry_id, qe.zone_id, qe.joined_at, qe.max_acceptable_commission_pct,
              z.name AS zone_name,
              (SELECT COUNT(*) FROM queue_entries qe2
                 WHERE qe2.zone_id = qe.zone_id
                   AND qe2.status = 'ACTIVE'
                   AND qe2.joined_at < qe.joined_at)::int + 1 AS position
       FROM queue_entries qe
       JOIN queue_zones z ON z.zone_id = qe.zone_id
       WHERE qe.driver_id = $1 AND qe.status = 'ACTIVE'`,
      [driverId]
    );
    if (result.rows.length === 0) {
      return res.json({ in_queue: false });
    }
    const row = result.rows[0];
    const minutesInQueue = Math.floor((Date.now() - new Date(row.joined_at).getTime()) / 60000);
    res.json({
      in_queue: true,
      entry_id: row.entry_id,
      zone_id: row.zone_id,
      zone_name: row.zone_name,
      joined_at: row.joined_at,
      minutes_in_queue: minutesInQueue,
      max_acceptable_commission_pct: row.max_acceptable_commission_pct,
      position: row.position,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/queue/join
// body: { driver_id, zone_id, current_lat, current_lng, max_acceptable_commission_pct? }
router.post('/join', async (req: Request, res: Response) => {
  const { driver_id, zone_id, current_lat, current_lng, max_acceptable_commission_pct } = req.body || {};

  if (!driver_id || !zone_id) {
    return res.status(400).json({ error: '缺少 driver_id 或 zone_id' });
  }
  if (typeof current_lat !== 'number' || typeof current_lng !== 'number') {
    return res.status(400).json({ error: 'GPS 座標必填且須為數字' });
  }

  try {
    // 1. 驗證司機狀態
    const driverRes = await pool.query(
      `SELECT availability FROM drivers WHERE driver_id = $1`,
      [driver_id]
    );
    if (driverRes.rows.length === 0) {
      return res.status(404).json({ error: '司機不存在' });
    }
    const availability = driverRes.rows[0].availability;
    if (availability === 'OFFLINE') {
      return res.status(400).json({ error: '司機未上線，無法加入排班' });
    }
    if (availability === 'ON_TRIP') {
      return res.status(400).json({ error: '行程中無法加入排班，請先完成當前訂單' });
    }

    // 2. 驗證 zone 存在 + active
    const zoneRes = await pool.query(
      `SELECT center_lat, center_lng, radius_meters FROM queue_zones WHERE zone_id = $1 AND is_active = true`,
      [zone_id]
    );
    if (zoneRes.rows.length === 0) {
      return res.status(404).json({ error: 'Zone 不存在或已停用' });
    }
    const zone = zoneRes.rows[0];

    // 3. 驗證 GPS 在 zone 範圍內
    const dist = distanceMeters(
      current_lat, current_lng,
      Number(zone.center_lat), Number(zone.center_lng),
    );
    if (dist > Number(zone.radius_meters)) {
      return res.status(400).json({
        error: `您不在排班區範圍內（距離 ${Math.round(dist)}m，限 ${zone.radius_meters}m）`,
      });
    }

    // 4. 確認沒有其他 ACTIVE 排班（DB UNIQUE 也會擋，但先給友善錯誤）
    const existsRes = await pool.query(
      `SELECT entry_id FROM queue_entries WHERE driver_id = $1 AND status = 'ACTIVE'`,
      [driver_id]
    );
    if (existsRes.rows.length > 0) {
      return res.status(409).json({
        error: '您已在其他排班，請先退出再加入',
        active_entry_id: existsRes.rows[0].entry_id,
      });
    }

    // 5. 寫入 queue_entry
    const insertRes = await pool.query(
      `INSERT INTO queue_entries (driver_id, zone_id, max_acceptable_commission_pct)
       VALUES ($1, $2, $3)
       RETURNING entry_id, joined_at`,
      [driver_id, zone_id, max_acceptable_commission_pct ?? 100]
    );

    // 6. 計算順位（同 zone 內 ACTIVE、joined_at 比自己早的數量 + 1）
    const positionRes = await pool.query(
      `SELECT COUNT(*)::int + 1 AS position
       FROM queue_entries
       WHERE zone_id = $1 AND status = 'ACTIVE' AND joined_at < $2`,
      [zone_id, insertRes.rows[0].joined_at]
    );

    res.status(201).json({
      success: true,
      entry_id: insertRes.rows[0].entry_id,
      joined_at: insertRes.rows[0].joined_at,
      position: positionRes.rows[0].position,
    });
  } catch (e: any) {
    console.error('[Queue] join 錯誤:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/queue/leave
// body: { driver_id, reason? }
router.post('/leave', async (req: Request, res: Response) => {
  const { driver_id, reason } = req.body || {};
  if (!driver_id) return res.status(400).json({ error: '缺少 driver_id' });

  try {
    const result = await pool.query(
      `UPDATE queue_entries
       SET status = 'LEFT',
           left_at = CURRENT_TIMESTAMP,
           left_reason = $2
       WHERE driver_id = $1 AND status = 'ACTIVE'
       RETURNING entry_id`,
      [driver_id, reason || 'MANUAL']
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '您目前沒有 ACTIVE 排班' });
    }
    res.json({ success: true, entry_id: result.rows[0].entry_id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

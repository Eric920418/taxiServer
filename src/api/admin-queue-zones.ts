/**
 * admin-queue-zones.ts — 排班區 CRUD
 *
 * 排班區：圓形範圍（中心 + 半徑公尺），admin 在地圖選區
 * 例：「前站」中心 23.9930, 121.6033, radius 300m
 */

import { Router, Response, Request } from 'express';
import { authenticateAdmin, AdminRole, requireRole } from './admin';
import pool from '../db/connection';
import { isWithinHualienBounds } from '../services/HualienAddressDB';

const router = Router();

interface AuthedRequest extends Request {
  admin?: { admin_id: string; username: string; role: AdminRole };
}

router.use(authenticateAdmin);

interface ZoneInput {
  zone_id?: string;
  name?: string;
  center_lat?: number;
  center_lng?: number;
  radius_meters?: number;
  is_active?: boolean;
  /** SERIAL = 嚴格排班順位（一次一人 15s）, PARALLEL = 批次推（誰按快誰拿）。Migration 026 加。 */
  dispatch_mode?: 'SERIAL' | 'PARALLEL';
}

function validate(input: ZoneInput, isCreate: boolean): string | null {
  if (isCreate) {
    if (!input.zone_id || !input.zone_id.trim()) return 'zone_id 必填';
    if (!input.name || !input.name.trim()) return '名稱必填';
    if (input.center_lat === undefined || input.center_lng === undefined) return '中心座標必填';
    if (input.radius_meters === undefined) return '半徑必填';
  }
  if (input.zone_id !== undefined && !/^[A-Za-z0-9_-]{1,50}$/.test(input.zone_id)) {
    return 'zone_id 只能含英數、底線、連字號，最多 50 字元';
  }
  if (input.name !== undefined && (input.name.length < 1 || input.name.length > 50)) {
    return '名稱長度 1-50 字';
  }
  if (input.center_lat !== undefined && input.center_lng !== undefined) {
    if (typeof input.center_lat !== 'number' || typeof input.center_lng !== 'number') {
      return '中心座標必須是數字';
    }
    if (!isWithinHualienBounds(input.center_lat, input.center_lng)) {
      return '中心座標必須在花蓮縣範圍內';
    }
  }
  if (input.radius_meters !== undefined) {
    if (typeof input.radius_meters !== 'number' || input.radius_meters < 50 || input.radius_meters > 5000) {
      return '半徑須為 50-5000 公尺';
    }
  }
  if (input.dispatch_mode !== undefined && !['SERIAL', 'PARALLEL'].includes(input.dispatch_mode)) {
    return 'dispatch_mode 必須是 SERIAL 或 PARALLEL';
  }
  return null;
}

// GET /api/admin/queue-zones?include_inactive=true
router.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    const where = includeInactive ? '' : 'WHERE is_active = true';
    const result = await pool.query(
      `SELECT z.zone_id, z.name, z.center_lat, z.center_lng, z.radius_meters,
              z.is_active, z.created_at, z.updated_at,
              COALESCE(z.dispatch_mode, 'PARALLEL') AS dispatch_mode,
              COALESCE((
                SELECT COUNT(*) FROM queue_entries qe
                WHERE qe.zone_id = z.zone_id AND qe.status = 'ACTIVE'
              ), 0) AS active_drivers
       FROM queue_zones z
       ${where}
       ORDER BY z.is_active DESC, z.name`
    );
    res.json({ success: true, data: result.rows });
  } catch (e: any) {
    console.error('[Queue Zones] list 錯誤:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/admin/queue-zones/:id
router.get('/:id', async (req: AuthedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM queue_zones WHERE zone_id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Zone 不存在' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/admin/queue-zones
router.post(
  '/',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    try {
      const input: ZoneInput = req.body;
      const err = validate(input, true);
      if (err) return res.status(400).json({ success: false, error: err });

      const exists = await pool.query('SELECT zone_id FROM queue_zones WHERE zone_id = $1', [input.zone_id]);
      if (exists.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'zone_id 已存在' });
      }

      await pool.query(
        `INSERT INTO queue_zones (zone_id, name, center_lat, center_lng, radius_meters, is_active, dispatch_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.zone_id,
          input.name,
          input.center_lat,
          input.center_lng,
          input.radius_meters,
          input.is_active !== false,
          input.dispatch_mode ?? 'PARALLEL',
        ]
      );
      res.status(201).json({ success: true, message: 'Zone 已建立' });
    } catch (e: any) {
      console.error('[Queue Zones] create 錯誤:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

// PUT /api/admin/queue-zones/:id
router.put(
  '/:id',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    try {
      const input: ZoneInput = req.body;
      const err = validate(input, false);
      if (err) return res.status(400).json({ success: false, error: err });

      const sets: string[] = [];
      const params: any[] = [];
      const fieldMap: Record<string, any> = {
        name: input.name,
        center_lat: input.center_lat,
        center_lng: input.center_lng,
        radius_meters: input.radius_meters,
        is_active: input.is_active,
        dispatch_mode: input.dispatch_mode,
      };
      for (const [col, val] of Object.entries(fieldMap)) {
        if (val !== undefined) {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        }
      }
      if (sets.length === 0) {
        return res.status(400).json({ success: false, error: '無可更新欄位' });
      }
      sets.push(`updated_at = CURRENT_TIMESTAMP`);
      params.push(req.params.id);

      const result = await pool.query(
        `UPDATE queue_zones SET ${sets.join(', ')} WHERE zone_id = $${params.length} RETURNING *`,
        params
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Zone 不存在' });
      }
      res.json({ success: true, data: result.rows[0] });
    } catch (e: any) {
      console.error('[Queue Zones] update 錯誤:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

// DELETE /api/admin/queue-zones/:id（軟刪）
router.delete(
  '/:id',
  requireRole([AdminRole.SUPER_ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    try {
      // 先把該 zone 內所有 ACTIVE 排班司機踢出
      await pool.query(
        `UPDATE queue_entries
         SET status = 'LEFT', left_at = CURRENT_TIMESTAMP, left_reason = 'ZONE_DEACTIVATED'
         WHERE zone_id = $1 AND status = 'ACTIVE'`,
        [req.params.id]
      );
      const result = await pool.query(
        `UPDATE queue_zones SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE zone_id = $1 RETURNING zone_id`,
        [req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Zone 不存在' });
      }
      res.json({ success: true, message: 'Zone 已停用，相關 ACTIVE 排班已踢出' });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

export default router;

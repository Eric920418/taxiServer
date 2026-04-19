/**
 * admin-address-failures.ts
 *
 * 「待補齊地標」Admin API — 管理 address_lookup_failures 表
 */

import { Router, Response, Request } from 'express';
import { authenticateAdmin, AdminRole, requireRole } from './admin';
import pool from '../db/connection';
import { hualienAddressDB } from '../services/HualienAddressDB';

const router = Router();
router.use(authenticateAdmin);

interface AuthedRequest extends Request {
  admin?: { admin_id: string; username: string; role: AdminRole };
}

// ============================================================
// GET /api/admin/address-failures
// ============================================================
router.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const source = req.query.source as string;
    const resolved = req.query.resolved as string;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.page_size as string) || 50, 200);
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: any[] = [];

    if (source) {
      params.push(source);
      conditions.push(`source = $${params.length}`);
    }
    if (resolved === 'true') {
      conditions.push('resolved_landmark_id IS NOT NULL');
    } else if (resolved === 'false') {
      conditions.push('resolved_landmark_id IS NULL AND dismissed_at IS NULL');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(pageSize, offset);
    const listResult = await pool.query(
      `SELECT af.*, l.name AS resolved_landmark_name, a.username AS resolved_by_username
       FROM address_lookup_failures af
       LEFT JOIN landmarks l ON l.id = af.resolved_landmark_id
       LEFT JOIN admins a ON a.admin_id = af.resolved_by
       ${whereClause}
       ORDER BY
         (af.resolved_landmark_id IS NULL AND af.dismissed_at IS NULL) DESC,
         af.hit_count DESC,
         af.last_seen_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM address_lookup_failures af ${whereClause}`,
      params.slice(0, -2)
    );

    res.json({
      success: true,
      data: listResult.rows,
      pagination: {
        page,
        page_size: pageSize,
        total: parseInt(countResult.rows[0].total),
      },
    });
  } catch (error: any) {
    console.error('[Admin AddressFailures] 列表查詢失敗:', error);
    res.status(500).json({ success: false, error: error.message, stack: error.stack });
  }
});

// ============================================================
// POST /api/admin/address-failures/:id/resolve
// 標記為已處理（需指定對應到哪個 landmark）
// ============================================================
router.post(
  '/:id/resolve',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const landmarkId = req.body.landmark_id;

      if (!landmarkId || typeof landmarkId !== 'number') {
        return res.status(400).json({ success: false, error: 'landmark_id 必填（數字）' });
      }

      const landmarkCheck = await pool.query(
        'SELECT id FROM landmarks WHERE id = $1 AND deleted_at IS NULL',
        [landmarkId]
      );
      if (landmarkCheck.rows.length === 0) {
        return res.status(400).json({ success: false, error: `地標 #${landmarkId} 不存在或已刪除` });
      }

      const result = await pool.query(
        `UPDATE address_lookup_failures
           SET resolved_landmark_id = $1, resolved_at = NOW(), resolved_by = $2
           WHERE id = $3
           RETURNING *`,
        [landmarkId, req.admin!.admin_id, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: '找不到此失敗記錄' });
      }

      res.json({ success: true, data: result.rows[0] });
    } catch (error: any) {
      console.error('[Admin AddressFailures] resolve 失敗:', error);
      res.status(500).json({ success: false, error: error.message, stack: error.stack });
    }
  }
);

// ============================================================
// DELETE /api/admin/address-failures/:id
// 標記為忽略（垃圾輸入/非地標）
// ============================================================
router.delete(
  '/:id',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const result = await pool.query(
        `UPDATE address_lookup_failures
           SET dismissed_at = NOW()
           WHERE id = $1 RETURNING id`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: '找不到此失敗記錄' });
      }
      res.json({ success: true, message: '已忽略' });
    } catch (error: any) {
      console.error('[Admin AddressFailures] dismiss 失敗:', error);
      res.status(500).json({ success: false, error: error.message, stack: error.stack });
    }
  }
);

// ============================================================
// GET /api/admin/address-failures/stats
// 統計摘要
// ============================================================
router.get('/stats', async (_req: AuthedRequest, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT
        source,
        COUNT(*) FILTER (WHERE resolved_landmark_id IS NULL AND dismissed_at IS NULL) AS pending,
        COUNT(*) FILTER (WHERE resolved_landmark_id IS NOT NULL) AS resolved,
        COUNT(*) FILTER (WHERE dismissed_at IS NOT NULL) AS dismissed,
        SUM(hit_count) FILTER (WHERE resolved_landmark_id IS NULL AND dismissed_at IS NULL) AS pending_total_hits
      FROM address_lookup_failures
      GROUP BY source
    `);
    res.json({
      success: true,
      data: result.rows,
      index_built_at: hualienAddressDB.getLastBuiltAt(),
    });
  } catch (error: any) {
    console.error('[Admin AddressFailures] stats 失敗:', error);
    res.status(500).json({ success: false, error: error.message, stack: error.stack });
  }
});

export default router;

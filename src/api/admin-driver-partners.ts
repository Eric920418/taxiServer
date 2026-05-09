/**
 * admin-driver-partners.ts — 司機綁定 Partner（N:N 關係）
 *
 * 約束：
 *   - 每個 relationship_type (PRIMARY_FLEET / BRAND / RECRUITED_BY) 每司機僅 1 筆
 *   - 重複設同一 type → upsert（更新 partner_id）
 *   - 軟刪：is_active = false（保留歷史）
 */

import { Router, Response, Request } from 'express';
import { authenticateAdmin, AdminRole, requireRole } from './admin';
import pool from '../db/connection';

const router = Router();

interface AuthedRequest extends Request {
  admin?: { admin_id: string; username: string; role: AdminRole };
}

router.use(authenticateAdmin);

const VALID_RELATIONSHIPS = ['PRIMARY_FLEET', 'BRAND', 'RECRUITED_BY'] as const;
type RelationshipType = typeof VALID_RELATIONSHIPS[number];

// GET /api/admin/drivers/:driverId/partners — 列出該司機綁定的所有 partner
router.get('/:driverId/partners', async (req: AuthedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT dp.driver_id, dp.partner_id, dp.relationship_type, dp.joined_at, dp.is_active,
              p.name AS partner_name, p.type AS partner_type
       FROM driver_partners dp
       JOIN partners p ON p.partner_id = dp.partner_id
       WHERE dp.driver_id = $1 AND dp.is_active = true
       ORDER BY dp.relationship_type`,
      [req.params.driverId]
    );
    res.json({ success: true, data: result.rows });
  } catch (e: any) {
    console.error('[Driver Partners] list 錯誤:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/admin/drivers/:driverId/partners — 整批設定（取代既有）
//   body: { PRIMARY_FLEET?: 'partner_id', BRAND?: 'partner_id', RECRUITED_BY?: 'partner_id' }
//   缺的 type 不動；給 null 表示移除（軟刪）
router.put(
  '/:driverId/partners',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    const driverId = req.params.driverId;
    const body = req.body || {};

    // 驗證 driver 存在
    const driverCheck = await pool.query('SELECT driver_id FROM drivers WHERE driver_id = $1', [driverId]);
    if (driverCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: '司機不存在' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const rel of VALID_RELATIONSHIPS) {
        if (!(rel in body)) continue; // 不在 body 內的 type 不動
        const partnerId = body[rel];

        if (partnerId === null || partnerId === '') {
          // 移除（軟刪）
          await client.query(
            `UPDATE driver_partners SET is_active = false WHERE driver_id = $1 AND relationship_type = $2`,
            [driverId, rel]
          );
        } else {
          // 驗證 partner 存在 + active
          const partnerCheck = await client.query(
            `SELECT partner_id, type FROM partners WHERE partner_id = $1 AND is_active = true`,
            [partnerId]
          );
          if (partnerCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: `Partner ${partnerId} 不存在或已停用` });
          }

          // upsert
          await client.query(
            `INSERT INTO driver_partners (driver_id, partner_id, relationship_type, is_active)
             VALUES ($1, $2, $3, true)
             ON CONFLICT (driver_id, relationship_type)
             DO UPDATE SET partner_id = EXCLUDED.partner_id, is_active = true, joined_at = CURRENT_TIMESTAMP`,
            [driverId, partnerId, rel]
          );
        }
      }

      await client.query('COMMIT');

      // 回傳更新後的 binding
      const updated = await pool.query(
        `SELECT dp.partner_id, dp.relationship_type, dp.is_active,
                p.name AS partner_name, p.type AS partner_type
         FROM driver_partners dp
         JOIN partners p ON p.partner_id = dp.partner_id
         WHERE dp.driver_id = $1 AND dp.is_active = true`,
        [driverId]
      );
      res.json({ success: true, data: updated.rows });
    } catch (e: any) {
      await client.query('ROLLBACK');
      console.error('[Driver Partners] update 錯誤:', e);
      res.status(500).json({ success: false, error: e.message });
    } finally {
      client.release();
    }
  }
);

export default router;

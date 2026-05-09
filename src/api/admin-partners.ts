/**
 * admin-partners.ts — Partner（合作對象）CRUD
 *
 * Partner 三類型同一張 schema：
 *   - FLEET     車隊（例：大豐）
 *   - BRAND     品牌
 *   - RECRUITER 招募人 / 區域管理者
 *
 * 一筆 partner 可代表多種角色（例如某品牌也是合作車隊），但本系統用 type 標主要類型。
 */

import { Router, Response, Request } from 'express';
import { authenticateAdmin, AdminRole, requireRole } from './admin';
import pool from '../db/connection';

const router = Router();

interface AuthedRequest extends Request {
  admin?: { admin_id: string; username: string; role: AdminRole };
}

router.use(authenticateAdmin);

const VALID_TYPES = ['FLEET', 'BRAND', 'RECRUITER'] as const;
type PartnerType = typeof VALID_TYPES[number];

interface PartnerInput {
  partner_id?: string;
  name?: string;
  type?: PartnerType;
  parent_partner_id?: string | null;
  contact_phone?: string | null;
  contact_name?: string | null;
  is_active?: boolean;
}

function validate(input: PartnerInput, isCreate: boolean): string | null {
  if (isCreate) {
    if (!input.partner_id || !input.partner_id.trim()) return 'partner_id 必填';
    if (!input.name || !input.name.trim()) return '名稱必填';
    if (!input.type) return '類型必填';
  }
  if (input.type !== undefined && !VALID_TYPES.includes(input.type)) {
    return `類型必須是 ${VALID_TYPES.join('/')}`;
  }
  if (input.partner_id !== undefined && !/^[A-Za-z0-9_-]{1,50}$/.test(input.partner_id)) {
    return 'partner_id 只能含英數、底線、連字號，最多 50 字元';
  }
  if (input.name !== undefined && input.name.length > 100) return '名稱超過 100 字元';
  return null;
}

// GET /api/admin/partners?type=FLEET&is_active=true
router.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const { type, is_active } = req.query;
    const conditions: string[] = [];
    const params: any[] = [];

    if (type) {
      params.push(type);
      conditions.push(`type = $${params.length}`);
    }
    if (is_active !== undefined) {
      params.push(is_active === 'true');
      conditions.push(`is_active = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT partner_id, name, type, parent_partner_id, contact_phone, contact_name,
              is_active, created_at, updated_at
       FROM partners
       ${where}
       ORDER BY type, name`,
      params
    );
    res.json({ success: true, data: result.rows });
  } catch (e: any) {
    console.error('[Admin Partners] list 錯誤:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/admin/partners/:id
router.get('/:id', async (req: AuthedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM partners WHERE partner_id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Partner 不存在' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (e: any) {
    console.error('[Admin Partners] get 錯誤:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/admin/partners
router.post(
  '/',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    try {
      const input: PartnerInput = req.body;
      const err = validate(input, true);
      if (err) return res.status(400).json({ success: false, error: err });

      const exists = await pool.query('SELECT partner_id FROM partners WHERE partner_id = $1', [input.partner_id]);
      if (exists.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'partner_id 已存在' });
      }

      await pool.query(
        `INSERT INTO partners (partner_id, name, type, parent_partner_id, contact_phone, contact_name, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.partner_id,
          input.name,
          input.type,
          input.parent_partner_id || null,
          input.contact_phone || null,
          input.contact_name || null,
          input.is_active !== false,
        ]
      );
      res.status(201).json({ success: true, message: 'Partner 已建立' });
    } catch (e: any) {
      console.error('[Admin Partners] create 錯誤:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

// PUT /api/admin/partners/:id
router.put(
  '/:id',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    try {
      const input: PartnerInput = req.body;
      const err = validate(input, false);
      if (err) return res.status(400).json({ success: false, error: err });

      const sets: string[] = [];
      const params: any[] = [];
      const fieldMap: Record<string, any> = {
        name: input.name,
        type: input.type,
        parent_partner_id: input.parent_partner_id,
        contact_phone: input.contact_phone,
        contact_name: input.contact_name,
        is_active: input.is_active,
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
        `UPDATE partners SET ${sets.join(', ')} WHERE partner_id = $${params.length} RETURNING *`,
        params
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Partner 不存在' });
      }
      res.json({ success: true, data: result.rows[0] });
    } catch (e: any) {
      console.error('[Admin Partners] update 錯誤:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

// DELETE /api/admin/partners/:id（軟刪 → is_active=false）
router.delete(
  '/:id',
  requireRole([AdminRole.SUPER_ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    try {
      const result = await pool.query(
        `UPDATE partners SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE partner_id = $1 RETURNING partner_id`,
        [req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Partner 不存在' });
      }
      res.json({ success: true, message: 'Partner 已停用（軟刪）' });
    } catch (e: any) {
      console.error('[Admin Partners] delete 錯誤:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

export default router;

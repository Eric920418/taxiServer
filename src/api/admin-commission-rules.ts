/**
 * admin-commission-rules.ts — 分潤規則 CRUD
 *
 * 規則類型：
 *   - FIXED_PER_ORDER: 每單固定金額（元），例：每單 10 元給招募人
 *   - PERCENTAGE: 車資的百分比，例：5% 給車隊
 *
 * 一個 partner 可有多筆 rule，但同時只取「最新生效」一筆。
 * 改 rule 不影響歷史 BillingSnapshot（distribution 已寫死）。
 */

import { Router, Response, Request } from 'express';
import { authenticateAdmin, AdminRole, requireRole } from './admin';
import pool from '../db/connection';

const router = Router();

interface AuthedRequest extends Request {
  admin?: { admin_id: string; username: string; role: AdminRole };
}

router.use(authenticateAdmin);

const VALID_RULE_TYPES = ['FIXED_PER_ORDER', 'PERCENTAGE'] as const;

interface RuleInput {
  partner_id?: string;
  rule_type?: 'FIXED_PER_ORDER' | 'PERCENTAGE';
  amount?: number;
  effective_from?: string;
  effective_to?: string | null;
  is_active?: boolean;
  notes?: string | null;
}

function validate(input: RuleInput, isCreate: boolean): string | null {
  if (isCreate) {
    if (!input.partner_id) return 'partner_id 必填';
    if (!input.rule_type) return 'rule_type 必填';
    if (input.amount === undefined || input.amount === null) return 'amount 必填';
  }
  if (input.rule_type !== undefined && !VALID_RULE_TYPES.includes(input.rule_type)) {
    return `rule_type 必須是 ${VALID_RULE_TYPES.join('/')}`;
  }
  if (input.amount !== undefined) {
    if (typeof input.amount !== 'number' || input.amount < 0) {
      return 'amount 必須是非負數字';
    }
    if (input.rule_type === 'PERCENTAGE' && input.amount > 100) {
      return 'PERCENTAGE rule amount 不可超過 100';
    }
  }
  return null;
}

// GET /api/admin/commission-rules?partner_id=xxx&active_only=true
router.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const { partner_id, active_only } = req.query;
    const conditions: string[] = [];
    const params: any[] = [];

    if (partner_id) {
      params.push(partner_id);
      conditions.push(`r.partner_id = $${params.length}`);
    }
    if (active_only === 'true') {
      conditions.push(`r.is_active = true`);
      conditions.push(`r.effective_from <= CURRENT_TIMESTAMP`);
      conditions.push(`(r.effective_to IS NULL OR r.effective_to > CURRENT_TIMESTAMP)`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT r.rule_id, r.partner_id, r.rule_type, r.amount, r.effective_from, r.effective_to,
              r.is_active, r.notes, r.created_at,
              p.name AS partner_name, p.type AS partner_type
       FROM commission_rules r
       JOIN partners p ON p.partner_id = r.partner_id
       ${where}
       ORDER BY r.partner_id, r.effective_from DESC`,
      params
    );
    res.json({ success: true, data: result.rows });
  } catch (e: any) {
    console.error('[Commission Rules] list 錯誤:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/admin/commission-rules — 新增規則
router.post(
  '/',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    try {
      const input: RuleInput = req.body;
      const err = validate(input, true);
      if (err) return res.status(400).json({ success: false, error: err });

      // 驗 partner 存在
      const partnerCheck = await pool.query('SELECT partner_id FROM partners WHERE partner_id = $1 AND is_active = true', [input.partner_id]);
      if (partnerCheck.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Partner 不存在或已停用' });
      }

      const result = await pool.query(
        `INSERT INTO commission_rules (partner_id, rule_type, amount, effective_from, effective_to, is_active, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          input.partner_id,
          input.rule_type,
          input.amount,
          input.effective_from || new Date(),
          input.effective_to || null,
          input.is_active !== false,
          input.notes || null,
        ]
      );
      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (e: any) {
      console.error('[Commission Rules] create 錯誤:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

// PUT /api/admin/commission-rules/:id
router.put(
  '/:id',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    try {
      const input: RuleInput = req.body;
      const err = validate(input, false);
      if (err) return res.status(400).json({ success: false, error: err });

      const sets: string[] = [];
      const params: any[] = [];
      const fieldMap: Record<string, any> = {
        rule_type: input.rule_type,
        amount: input.amount,
        effective_from: input.effective_from,
        effective_to: input.effective_to,
        is_active: input.is_active,
        notes: input.notes,
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
      params.push(req.params.id);

      const result = await pool.query(
        `UPDATE commission_rules SET ${sets.join(', ')} WHERE rule_id = $${params.length} RETURNING *`,
        params
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: '規則不存在' });
      }
      res.json({ success: true, data: result.rows[0] });
    } catch (e: any) {
      console.error('[Commission Rules] update 錯誤:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

// DELETE /api/admin/commission-rules/:id（軟刪）
router.delete(
  '/:id',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    try {
      const result = await pool.query(
        `UPDATE commission_rules SET is_active = false WHERE rule_id = $1 RETURNING rule_id`,
        [req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: '規則不存在' });
      }
      res.json({ success: true, message: '規則已停用' });
    } catch (e: any) {
      console.error('[Commission Rules] delete 錯誤:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

export default router;

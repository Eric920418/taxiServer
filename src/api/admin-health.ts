/**
 * admin-health.ts — 系統健康偵測 + 自動清理
 *
 * 目的：surface 結構性資料異常給 admin，避免 silent failure 累積到客訴爆發。
 *
 * Checks（每個都 schema-level 強制 + application 層 cross-check）：
 *   1. orphan_aliases               軟刪 landmark 但 aliases 殘留（trigger 應防住，舊資料 cleanup）
 *   2. duplicate_landmark_names     同名 active landmark（partial unique 應防住）
 *   3. duplicate_partner_names      同名 active partner（partial unique 應防住）
 *   4. inactive_partner_active_bindings  partner 停用但 driver_partners 還 active（trigger 應防住）
 *   5. stuck_offered_orders         OFFERED 訂單超過 10 分鐘沒派出
 *   6. stuck_queue_entries          ACTIVE queue_entries 超過 1 小時（超過業務上限）
 */

import { Router, Response, Request } from 'express';
import { authenticateAdmin, AdminRole, requireRole } from './admin';
import pool from '../db/connection';

const router = Router();

interface AuthedRequest extends Request {
  admin?: { admin_id: string; username: string; role: AdminRole };
}

router.use(authenticateAdmin);

type Severity = 'high' | 'medium' | 'low';

interface HealthCheck {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  count: number;
  items: any[];
  pages: string[];                       // 哪些 admin 頁面該顯示這條 banner
  auto_fix_endpoint?: string;            // 可一鍵清理時填 URL
}

// ============================================================
// GET /api/admin/health/data-integrity
// ============================================================
router.get('/data-integrity', async (req: AuthedRequest, res: Response) => {
  try {
    const checks: HealthCheck[] = [];

    // 1. orphan_aliases
    const orphanRes = await pool.query(`
      SELECT l.id, l.name, l.deleted_at, count(la.id)::int AS alias_count
      FROM landmarks l
      JOIN landmark_aliases la ON la.landmark_id = l.id
      WHERE l.deleted_at IS NOT NULL
      GROUP BY l.id, l.name, l.deleted_at
      ORDER BY l.deleted_at DESC
      LIMIT 50
    `);
    checks.push({
      id: 'orphan_aliases',
      title: '軟刪 landmark 殘留 aliases',
      description: '軟刪後別名沒清乾淨，會占用 (alias, alias_type) unique key，害新增同 alias silent fail。',
      severity: 'high',
      count: orphanRes.rows.length,
      items: orphanRes.rows,
      pages: ['/admin/landmarks'],
      auto_fix_endpoint: '/api/admin/health/fix/orphan_aliases',
    });

    // 2. duplicate_landmark_names
    const dupLandmarkRes = await pool.query(`
      SELECT name, array_agg(id ORDER BY updated_at DESC) AS ids, count(*)::int AS n
      FROM landmarks WHERE deleted_at IS NULL
      GROUP BY name HAVING count(*) > 1
      LIMIT 50
    `);
    checks.push({
      id: 'duplicate_landmark_names',
      title: '同名 active landmark 重複',
      description: '同名地標應只能存在一個 active；partial unique index 已防新建，這裡是歷史殘留。',
      severity: 'high',
      count: dupLandmarkRes.rows.length,
      items: dupLandmarkRes.rows,
      pages: ['/admin/landmarks'],
    });

    // 3. duplicate_partner_names
    const dupPartnerRes = await pool.query(`
      SELECT name, array_agg(partner_id) AS ids, count(*)::int AS n
      FROM partners WHERE is_active = true
      GROUP BY name HAVING count(*) > 1
      LIMIT 50
    `);
    checks.push({
      id: 'duplicate_partner_names',
      title: '同名 active partner 重複',
      description: '同名 partner 應只能一個 active。',
      severity: 'medium',
      count: dupPartnerRes.rows.length,
      items: dupPartnerRes.rows,
      pages: ['/admin/partners'],
    });

    // 4. inactive_partner_active_bindings
    const inactiveBindRes = await pool.query(`
      SELECT p.partner_id, p.name, count(dp.driver_id)::int AS active_bindings
      FROM partners p
      JOIN driver_partners dp ON dp.partner_id = p.partner_id AND dp.is_active = true
      WHERE p.is_active = false
      GROUP BY p.partner_id, p.name
      LIMIT 50
    `);
    checks.push({
      id: 'inactive_partner_active_bindings',
      title: '停用 partner 但仍有 active driver_partners',
      description: '停用 partner 時應 cascade deactivate driver_partners；trigger 已防新發生，此為舊殘留。',
      severity: 'medium',
      count: inactiveBindRes.rows.length,
      items: inactiveBindRes.rows,
      pages: ['/admin/partners', '/admin/drivers'],
      auto_fix_endpoint: '/api/admin/health/fix/inactive_partner_active_bindings',
    });

    // 5. stuck_offered_orders
    const stuckOrdersRes = await pool.query(`
      SELECT order_id, line_user_id, status, preferred_fleet_partner_id,
             EXTRACT(EPOCH FROM (NOW() - COALESCE(offered_at, created_at)))::int AS stuck_seconds,
             COALESCE(offered_at, created_at) AS since
      FROM orders
      WHERE status = 'OFFERED'
        AND driver_id IS NULL
        AND COALESCE(offered_at, created_at) < NOW() - INTERVAL '10 minutes'
      ORDER BY since ASC
      LIMIT 30
    `);
    checks.push({
      id: 'stuck_offered_orders',
      title: '訂單卡 OFFERED 超過 10 分鐘',
      description: '正常 OFFERED 應在 30 秒內接走或 fallback 派發；卡這麼久代表派單流程或 fallback 出問題。',
      severity: stuckOrdersRes.rows.length > 0 ? 'high' : 'low',
      count: stuckOrdersRes.rows.length,
      items: stuckOrdersRes.rows,
      pages: ['/admin/dashboard', '/admin/orders'],
    });

    // 6. stuck_queue_entries
    const stuckQueueRes = await pool.query(`
      SELECT qe.entry_id, qe.driver_id, d.name AS driver_name, qe.zone_id, qz.name AS zone_name,
             EXTRACT(EPOCH FROM (NOW() - qe.joined_at))::int / 60 AS minutes_in_queue
      FROM queue_entries qe
      LEFT JOIN drivers d ON d.driver_id = qe.driver_id
      LEFT JOIN queue_zones qz ON qz.zone_id = qe.zone_id
      WHERE qe.status = 'ACTIVE'
        AND qe.joined_at < NOW() - INTERVAL '1 hour'
      ORDER BY qe.joined_at ASC
      LIMIT 30
    `);
    checks.push({
      id: 'stuck_queue_entries',
      title: '司機 ACTIVE 排班超過 1 小時',
      description: '應由 fraud-checker cron 在 30 分鐘自動踢出；超過 1 小時表示 cron 沒跑或司機異常。',
      severity: stuckQueueRes.rows.length > 0 ? 'medium' : 'low',
      count: stuckQueueRes.rows.length,
      items: stuckQueueRes.rows,
      pages: ['/admin/queue-zones'],
    });

    res.json({
      success: true,
      scanned_at: new Date().toISOString(),
      checks,
      total_issues: checks.filter(c => c.count > 0).length,
      high_severity_count: checks.filter(c => c.count > 0 && c.severity === 'high').length,
    });
  } catch (e: any) {
    console.error('[Admin Health] data-integrity 失敗:', e);
    res.status(500).json({ success: false, error: e.message, stack: e.stack });
  }
});

// ============================================================
// POST /api/admin/health/fix/:checkId
// ============================================================
router.post(
  '/fix/:checkId',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    const { checkId } = req.params;
    try {
      let fixed = 0;
      let details: any = null;

      if (checkId === 'orphan_aliases') {
        const r = await pool.query(`
          DELETE FROM landmark_aliases
          WHERE landmark_id IN (SELECT id FROM landmarks WHERE deleted_at IS NOT NULL)
          RETURNING landmark_id, alias
        `);
        fixed = r.rowCount || 0;
        details = { sample: r.rows.slice(0, 10) };
      } else if (checkId === 'inactive_partner_active_bindings') {
        const r = await pool.query(`
          UPDATE driver_partners SET is_active = false
          WHERE partner_id IN (SELECT partner_id FROM partners WHERE is_active = false)
            AND is_active = true
          RETURNING driver_id, partner_id
        `);
        fixed = r.rowCount || 0;
        details = { sample: r.rows.slice(0, 10) };
      } else {
        return res.status(400).json({
          success: false,
          error: `不支援自動清理 check_id: ${checkId}（請手動到對應 admin 頁面處理）`,
        });
      }

      console.log(`[Admin Health] auto-fix ${checkId} by ${req.admin?.admin_id}: fixed ${fixed} 筆`);
      res.json({ success: true, check_id: checkId, fixed, details });
    } catch (e: any) {
      console.error(`[Admin Health] fix/${checkId} 失敗:`, e);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

export default router;

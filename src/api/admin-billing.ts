/**
 * admin-billing.ts — 結算對帳報表
 *
 * 3 層報表：
 *   1. GET /admin/billing/partner-monthly?partner_id=X&year=Y&month=M
 *      → 該 partner 當月：總單數、總 partner_share、按司機分組
 *   2. GET /admin/billing/driver-monthly?driver_id=X&year=Y&month=M
 *      → 該司機當月每筆訂單明細
 *   3. GET /admin/billing/platform-monthly?year=Y&month=M
 *      → 平台跨 partner 抽成總覽
 *
 * 對帳檢查：
 *   - Partner 報表：Σ各司機單數 = COUNT(DISTINCT snapshot_id)
 *   - 不對等 → 紅字警示「資料異常」
 */

import { Router, Response, Request } from 'express';
import { authenticateAdmin, AdminRole } from './admin';
import pool from '../db/connection';

const router = Router();

interface AuthedRequest extends Request {
  admin?: { admin_id: string; username: string; role: AdminRole };
}

router.use(authenticateAdmin);

/**
 * 月份起訖：YYYY-MM 字串轉成 [start, endExclusive]
 */
function monthRange(year: number, month: number): [Date, Date] {
  const start = new Date(year, month - 1, 1, 0, 0, 0);
  const end = new Date(year, month, 1, 0, 0, 0);
  return [start, end];
}

function parseYearMonth(req: AuthedRequest): { year: number; month: number } | null {
  const year = parseInt(req.query.year as string);
  const month = parseInt(req.query.month as string);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }
  return { year, month };
}

// ============================================================
// GET /admin/billing/partner-monthly
//   ?partner_id=X&year=2026&month=5
// ============================================================
router.get('/partner-monthly', async (req: AuthedRequest, res: Response) => {
  const partnerId = req.query.partner_id as string;
  const ym = parseYearMonth(req);
  if (!partnerId) return res.status(400).json({ success: false, error: '缺少 partner_id' });
  if (!ym) return res.status(400).json({ success: false, error: '缺少 year/month 或格式錯誤' });

  try {
    const [start, end] = monthRange(ym.year, ym.month);

    // 抓該 partner 該月所有 distribution 對應的 snapshots
    const detailRes = await pool.query(
      `SELECT
         bs.snapshot_id, bs.order_id, bs.driver_id, bs.source, bs.fare,
         bs.discount_amount, bs.dispatch_type, bs.zone_id, bs.completed_at,
         d.name AS driver_name,
         bd.amount AS partner_share,
         bd.rule_id_used
       FROM billing_distributions bd
       JOIN billing_snapshots bs ON bs.snapshot_id = bd.snapshot_id
       LEFT JOIN drivers d ON d.driver_id = bs.driver_id
       WHERE bd.partner_id = $1
         AND bs.completed_at >= $2 AND bs.completed_at < $3
       ORDER BY bs.completed_at DESC`,
      [partnerId, start, end]
    );

    // 按司機 group
    const byDriver = new Map<string, { driver_id: string; driver_name: string; orders: number; revenue: number; partner_share: number }>();
    let totalOrders = 0;
    let totalRevenue = 0;
    let totalPartnerShare = 0;

    for (const r of detailRes.rows) {
      totalOrders++;
      totalRevenue += Number(r.fare);
      totalPartnerShare += Number(r.partner_share);

      const key = r.driver_id;
      const existing = byDriver.get(key);
      if (existing) {
        existing.orders++;
        existing.revenue += Number(r.fare);
        existing.partner_share += Number(r.partner_share);
      } else {
        byDriver.set(key, {
          driver_id: key,
          driver_name: r.driver_name || key,
          orders: 1,
          revenue: Number(r.fare),
          partner_share: Number(r.partner_share),
        });
      }
    }

    // 對帳：Σ司機單數應該等於 totalOrders
    const sumByDriver = Array.from(byDriver.values()).reduce((s, x) => s + x.orders, 0);
    const isReconciled = sumByDriver === totalOrders;

    res.json({
      success: true,
      partner_id: partnerId,
      year: ym.year,
      month: ym.month,
      total_orders: totalOrders,
      total_revenue: totalRevenue,
      total_partner_share: Math.round(totalPartnerShare * 100) / 100,
      by_driver: Array.from(byDriver.values()).sort((a, b) => b.orders - a.orders),
      reconciled: isReconciled,
      sum_by_driver: sumByDriver,
      details: detailRes.rows,
    });
  } catch (e: any) {
    console.error('[Billing] partner-monthly 錯誤:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /admin/billing/driver-monthly
//   ?driver_id=X&year=2026&month=5
// ============================================================
router.get('/driver-monthly', async (req: AuthedRequest, res: Response) => {
  const driverId = req.query.driver_id as string;
  const ym = parseYearMonth(req);
  if (!driverId) return res.status(400).json({ success: false, error: '缺少 driver_id' });
  if (!ym) return res.status(400).json({ success: false, error: '缺少 year/month' });

  try {
    const [start, end] = monthRange(ym.year, ym.month);

    const snapshotRes = await pool.query(
      `SELECT
         bs.snapshot_id, bs.order_id, bs.source, bs.fare,
         bs.discount_amount, bs.total_discount_amount, bs.driver_net,
         bs.dispatch_type, bs.zone_id, bs.completed_at,
         qz.name AS zone_name
       FROM billing_snapshots bs
       LEFT JOIN queue_zones qz ON qz.zone_id = bs.zone_id
       WHERE bs.driver_id = $1
         AND bs.completed_at >= $2 AND bs.completed_at < $3
       ORDER BY bs.completed_at DESC`,
      [driverId, start, end]
    );

    let totalOrders = snapshotRes.rows.length;
    let totalFare = 0;
    let totalCommission = 0;
    let totalDriverNet = 0;
    let queueOrders = 0;

    for (const r of snapshotRes.rows) {
      totalFare += Number(r.fare);
      totalCommission += Number(r.total_discount_amount);
      totalDriverNet += Number(r.driver_net);
      if (r.dispatch_type === 'QUEUE') queueOrders++;
    }

    // 司機綁定的 partners
    const partnersRes = await pool.query(
      `SELECT dp.partner_id, dp.relationship_type, p.name AS partner_name, p.type AS partner_type
       FROM driver_partners dp
       JOIN partners p ON p.partner_id = dp.partner_id
       WHERE dp.driver_id = $1 AND dp.is_active = true`,
      [driverId]
    );

    res.json({
      success: true,
      driver_id: driverId,
      year: ym.year,
      month: ym.month,
      partners: partnersRes.rows,
      total_orders: totalOrders,
      queue_orders: queueOrders,
      regular_orders: totalOrders - queueOrders,
      total_fare: totalFare,
      total_commission: Math.round(totalCommission * 100) / 100,
      total_driver_net: Math.round(totalDriverNet * 100) / 100,
      orders: snapshotRes.rows,
    });
  } catch (e: any) {
    console.error('[Billing] driver-monthly 錯誤:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /admin/billing/platform-monthly
//   ?year=2026&month=5
//   平台跨 partner 抽成總覽
// ============================================================
router.get('/platform-monthly', async (req: AuthedRequest, res: Response) => {
  const ym = parseYearMonth(req);
  if (!ym) return res.status(400).json({ success: false, error: '缺少 year/month' });

  try {
    const [start, end] = monthRange(ym.year, ym.month);

    // 整體統計
    const overallRes = await pool.query(
      `SELECT
         COUNT(*)::int AS total_orders,
         COALESCE(SUM(fare), 0)::int AS total_fare,
         COALESCE(SUM(total_discount_amount), 0)::numeric(12,2) AS total_commission,
         COALESCE(SUM(driver_net), 0)::numeric(12,2) AS total_driver_net,
         COUNT(*) FILTER (WHERE dispatch_type = 'QUEUE')::int AS queue_orders,
         COUNT(*) FILTER (WHERE dispatch_type = 'REGULAR')::int AS regular_orders
       FROM billing_snapshots
       WHERE completed_at >= $1 AND completed_at < $2`,
      [start, end]
    );

    // 按 partner 拆分
    const byPartnerRes = await pool.query(
      `SELECT
         bd.partner_id,
         bd.partner_role,
         p.name AS partner_name,
         p.type AS partner_type,
         COUNT(DISTINCT bd.snapshot_id)::int AS orders,
         COALESCE(SUM(bd.amount), 0)::numeric(12,2) AS total_amount
       FROM billing_distributions bd
       LEFT JOIN partners p ON p.partner_id = bd.partner_id
       JOIN billing_snapshots bs ON bs.snapshot_id = bd.snapshot_id
       WHERE bs.completed_at >= $1 AND bs.completed_at < $2
       GROUP BY bd.partner_id, bd.partner_role, p.name, p.type
       ORDER BY total_amount DESC`,
      [start, end]
    );

    // PLATFORM 抽成（partner_role='PLATFORM'）
    const platformRow = byPartnerRes.rows.find(r => r.partner_role === 'PLATFORM');
    const platformShare = platformRow ? Number(platformRow.total_amount) : 0;

    res.json({
      success: true,
      year: ym.year,
      month: ym.month,
      overall: overallRes.rows[0],
      by_partner: byPartnerRes.rows,
      platform_share: Math.round(platformShare * 100) / 100,
    });
  } catch (e: any) {
    console.error('[Billing] platform-monthly 錯誤:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;

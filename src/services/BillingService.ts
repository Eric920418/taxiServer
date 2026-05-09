/**
 * BillingService - 訂單完成時寫帳務快照 + 拆分到多 partner
 *
 * 設計原則：
 *   - 每訂單 DONE 寫一筆 billing_snapshot（永久保留）
 *   - 同時依司機綁定的 partners + 適用 commission_rules 拆 N 筆 distribution
 *   - 對帳：Σ distribution.amount per snapshot == snapshot.total_commission_amount
 *   - 寫入失敗只 log warn，不卡訂單完成（snapshot 失敗可後補）
 *
 * 拆分演算法：
 *   1. 算 total_commission = fare * commission_pct / 100
 *   2. 對司機所屬每個 partner（PRIMARY_FLEET / BRAND / RECRUITED_BY）找最新 active rule
 *   3. 依 rule 算金額：FIXED_PER_ORDER → 固定值；PERCENTAGE → fare * pct / 100
 *   4. PLATFORM 拿剩餘（total_commission - Σ partner amounts）
 *   5. 若 PLATFORM 算出負數（partner 拿超過抽成）→ log error 但仍寫入（業主應檢查 rule）
 */

import pool from '../db/connection';

interface SnapshotInput {
  orderId: string;
  driverId: string;
  source: string;          // APP / LINE / PHONE
  fare: number;
  commissionPct: number;   // 0-100
  dispatchType: 'QUEUE' | 'REGULAR';
  zoneId?: string | null;
  completedAt: Date;
}

interface PartnerBinding {
  partner_id: string;
  partner_type: 'FLEET' | 'BRAND' | 'RECRUITER';
  relationship_type: 'PRIMARY_FLEET' | 'BRAND' | 'RECRUITED_BY';
}

interface ActiveRule {
  rule_id: number;
  partner_id: string;
  rule_type: 'FIXED_PER_ORDER' | 'PERCENTAGE';
  amount: number;
}

export class BillingService {
  /**
   * 訂單完成時呼叫。寫 snapshot + 多筆 distribution（一個 transaction）。
   * 失敗只 log，不 throw，避免影響訂單流程。
   *
   * @returns snapshot_id 或 null（失敗）
   */
  async writeSnapshotForOrder(orderId: string): Promise<number | null> {
    try {
      // 已存在則跳過（idempotent）
      const exists = await pool.query<{ snapshot_id: number }>(
        'SELECT snapshot_id FROM billing_snapshots WHERE order_id = $1',
        [orderId]
      );
      if (exists.rows.length > 0) {
        console.log(`[Billing] snapshot 已存在，跳過: ${orderId} → snapshot_id=${exists.rows[0].snapshot_id}`);
        return exists.rows[0].snapshot_id;
      }

      // 抓訂單必要欄位
      const order = await pool.query<{
        order_id: string;
        driver_id: string;
        source: string;
        meter_amount: number | null;
        commission_pct: number | null;
        dispatch_type: string | null;
        dispatched_from_zone: string | null;
        completed_at: Date;
      }>(
        `SELECT order_id, driver_id, source, meter_amount, commission_pct,
                dispatch_type, dispatched_from_zone, completed_at
         FROM orders WHERE order_id = $1`,
        [orderId]
      );
      if (order.rows.length === 0) {
        console.warn(`[Billing] 訂單不存在，跳過: ${orderId}`);
        return null;
      }
      const o = order.rows[0];
      if (!o.driver_id) {
        console.warn(`[Billing] 訂單無 driver_id，跳過: ${orderId}`);
        return null;
      }

      const fare = Math.max(0, Math.round(Number(o.meter_amount) || 0));
      const commissionPct = Math.max(0, Math.min(100, Number(o.commission_pct) || 0));
      const totalCommission = Math.round(fare * commissionPct / 100 * 100) / 100;
      const driverNet = fare - totalCommission;
      const dispatchType = (o.dispatch_type === 'QUEUE' ? 'QUEUE' : 'REGULAR') as 'QUEUE' | 'REGULAR';

      // 在 transaction 內：寫 snapshot + 拆 distribution
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const snapshotRes = await client.query<{ snapshot_id: number }>(
          `INSERT INTO billing_snapshots
            (order_id, driver_id, source, fare, commission_pct, total_commission_amount,
             driver_net, dispatch_type, zone_id, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING snapshot_id`,
          [
            orderId,
            o.driver_id,
            o.source || 'APP',
            fare,
            commissionPct,
            totalCommission,
            driverNet,
            dispatchType,
            o.dispatched_from_zone,
            o.completed_at || new Date(),
          ]
        );
        const snapshotId = snapshotRes.rows[0].snapshot_id;

        // 拆分：抓司機的 partner 綁定 + 各自的 active rule
        const distributionAmounts = await this.computeDistribution(client, o.driver_id, fare, totalCommission);

        // 寫每筆 distribution
        let partnerSum = 0;
        for (const d of distributionAmounts) {
          await client.query(
            `INSERT INTO billing_distributions
              (snapshot_id, partner_id, partner_role, amount, rule_id_used)
             VALUES ($1, $2, $3, $4, $5)`,
            [snapshotId, d.partner_id, d.partner_role, d.amount, d.rule_id_used]
          );
          partnerSum += Number(d.amount);
        }

        // PLATFORM 拿剩餘
        const platformAmount = Math.round((totalCommission - partnerSum) * 100) / 100;
        await client.query(
          `INSERT INTO billing_distributions
            (snapshot_id, partner_id, partner_role, amount, rule_id_used)
           VALUES ($1, NULL, 'PLATFORM', $2, NULL)`,
          [snapshotId, platformAmount]
        );

        if (platformAmount < 0) {
          console.warn(`[Billing] ⚠️ 訂單 ${orderId} PLATFORM 拿到負金額 (${platformAmount})，partner 規則合計超過抽成。請檢查 commission_rules`);
        }

        await client.query('COMMIT');
        console.log(`[Billing] ✓ snapshot ${snapshotId} for order ${orderId}: fare=${fare}, commission=${totalCommission}, partners=${distributionAmounts.length}, platform=${platformAmount}`);
        return snapshotId;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (e: any) {
      console.error(`[Billing] writeSnapshotForOrder 失敗 (${orderId}):`, e.message || e);
      return null;
    }
  }

  /**
   * 算司機綁定的 partners 各自應拿多少。
   * 不寫 PLATFORM（呼叫端拿剩餘）。
   */
  private async computeDistribution(
    client: any,
    driverId: string,
    fare: number,
    totalCommission: number,
  ): Promise<Array<{ partner_id: string; partner_role: 'FLEET' | 'BRAND' | 'RECRUITER'; amount: number; rule_id_used: number | null }>> {
    // 抓司機的 partner 綁定
    const bindings = await client.query(
      `SELECT dp.partner_id, p.type AS partner_type, dp.relationship_type
       FROM driver_partners dp
       JOIN partners p ON p.partner_id = dp.partner_id
       WHERE dp.driver_id = $1 AND dp.is_active = true AND p.is_active = true`,
      [driverId]
    );

    const result: Array<{ partner_id: string; partner_role: 'FLEET' | 'BRAND' | 'RECRUITER'; amount: number; rule_id_used: number | null }> = [];

    for (const b of bindings.rows as PartnerBinding[]) {
      // 抓該 partner 當前 active rule（取最新生效的一筆）
      const ruleRes = await client.query(
        `SELECT rule_id, partner_id, rule_type, amount
         FROM commission_rules
         WHERE partner_id = $1
           AND is_active = true
           AND effective_from <= CURRENT_TIMESTAMP
           AND (effective_to IS NULL OR effective_to > CURRENT_TIMESTAMP)
         ORDER BY effective_from DESC
         LIMIT 1`,
        [b.partner_id]
      );
      if (ruleRes.rows.length === 0) continue;
      const rule = ruleRes.rows[0] as ActiveRule;

      let amount = 0;
      if (rule.rule_type === 'FIXED_PER_ORDER') {
        amount = Number(rule.amount);
      } else if (rule.rule_type === 'PERCENTAGE') {
        amount = Math.round(fare * Number(rule.amount) / 100 * 100) / 100;
      }

      // partner_role 來自 partner type（不是 relationship_type，因為一個招募人可能其實是個品牌）
      result.push({
        partner_id: b.partner_id,
        partner_role: b.partner_type,
        amount,
        rule_id_used: rule.rule_id,
      });
    }

    return result;
  }
}

let billingServiceInstance: BillingService | null = null;
export function getBillingService(): BillingService {
  if (!billingServiceInstance) {
    billingServiceInstance = new BillingService();
  }
  return billingServiceInstance;
}

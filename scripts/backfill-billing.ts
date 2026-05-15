/**
 * backfill-billing.ts
 *
 * 一次性：補寫 P1 部署前 (或任何遺漏) DONE 訂單的 billing_snapshots
 *
 * 用法：
 *   pnpm ts-node scripts/backfill-billing.ts                # dry-run
 *   pnpm ts-node scripts/backfill-billing.ts --apply        # 真寫
 *
 * 邏輯：
 *   1. 找所有 status='DONE' 但 billing_snapshots 沒紀錄的訂單
 *   2. 對每筆呼叫 BillingService.writeSnapshotForOrder（已 idempotent）
 */

import dotenv from 'dotenv';
import pool from '../src/db/connection';
import { getBillingService } from '../src/services/BillingService';

dotenv.config();

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`=== Backfill Billing Snapshots ===`);
  console.log(`模式: ${apply ? '✅ APPLY (寫 DB)' : '🔍 DRY-RUN'}\n`);

  const result = await pool.query<{ order_id: string }>(
    `SELECT o.order_id
     FROM orders o
     LEFT JOIN billing_snapshots bs ON bs.order_id = o.order_id
     WHERE o.status = 'DONE'
       AND o.driver_id IS NOT NULL
       AND bs.snapshot_id IS NULL
     ORDER BY o.completed_at`
  );

  console.log(`待補寫訂單數：${result.rows.length}\n`);
  if (result.rows.length === 0) {
    console.log('🎉 沒有遺漏的訂單');
    await pool.end();
    return;
  }

  if (!apply) {
    console.log('要實際寫入請加 --apply');
    console.log('前 5 筆預覽：');
    result.rows.slice(0, 5).forEach(r => console.log(`  - ${r.order_id}`));
    await pool.end();
    return;
  }

  const billing = getBillingService();
  let success = 0;
  let failed = 0;

  for (const r of result.rows) {
    const snapshotId = await billing.writeSnapshotForOrder(r.order_id);
    if (snapshotId !== null) {
      success++;
    } else {
      failed++;
    }
  }

  console.log(`\n=== 結果 ===`);
  console.log(`成功：${success}`);
  console.log(`失敗：${failed}`);

  await pool.end();
}

main().catch(err => {
  console.error('腳本失敗:', err);
  process.exit(1);
});

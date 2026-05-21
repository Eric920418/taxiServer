/**
 * OrderCleanupService — 殭屍訂單清理 cron
 *
 * 動機：SmartDispatcherV2 的 ALL_REJECTED 分支故意把 DB status 留在 'OFFERED'
 * 「等待人工手動接單」，但實務上沒人手動接 → 訂單永久卡 OFFERED 變殭屍。
 * pm2 restart 時 in-memory dispatcher state 清空，仍在 OFFERED 的訂單也變孤兒。
 *
 * 修法：每 2 分鐘掃一次，把 OFFERED 超過 10 分鐘的訂單自動 CANCEL，
 * 並推 cancel 通知給乘客（避免他們以為還在派車）。
 *
 * 10 分鐘閾值給營運人員留時間手動處理 ALL_REJECTED 的 case，
 * 超過就視為「沒人接單」自動取消。
 */

import { Pool } from 'pg';
import { getSocketIO, passengerSockets } from '../socket';

const SCAN_INTERVAL_MS = 2 * 60 * 1000;     // 2 分鐘掃一次
const STALE_THRESHOLD_MIN = 10;             // OFFERED 超過 10 分鐘視為殭屍

export class OrderCleanupService {
  private timer: NodeJS.Timeout | null = null;
  constructor(private pool: Pool) {}

  start(): void {
    if (this.timer) return;
    // 啟動時先跑一次（清掉前次 pm2 restart 遺留的孤兒）
    this.scan().catch(e => console.error('[OrderCleanup] 首次掃描失敗:', e.message));
    this.timer = setInterval(
      () => this.scan().catch(e => console.error('[OrderCleanup] 定時掃描失敗:', e.message)),
      SCAN_INTERVAL_MS,
    );
    console.log(`[OrderCleanup] ✅ 已啟動（每 ${SCAN_INTERVAL_MS / 1000}s 掃一次、閾值 ${STALE_THRESHOLD_MIN} 分鐘）`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async scan(): Promise<void> {
    const result = await this.pool.query<{ order_id: string; passenger_id: string; source: string }>(
      `UPDATE orders
       SET status = 'CANCELLED',
           cancelled_at = CURRENT_TIMESTAMP,
           cancel_reason = '系統超時自動取消（無司機接單）'
       WHERE status = 'OFFERED'
         AND created_at < NOW() - INTERVAL '${STALE_THRESHOLD_MIN} minutes'
       RETURNING order_id, passenger_id, source`
    );

    if (result.rows.length === 0) return;
    console.log(`[OrderCleanup] 🧹 取消 ${result.rows.length} 筆殭屍訂單（OFFERED > ${STALE_THRESHOLD_MIN} min）`);

    // 通知乘客（如果還在線）
    const io = getSocketIO();
    for (const row of result.rows) {
      console.log(`  - ${row.order_id} (passenger=${row.passenger_id}, source=${row.source})`);
      const socketId = passengerSockets.get(row.passenger_id);
      if (socketId) {
        io.to(socketId).emit('order:cancelled', {
          orderId: row.order_id,
          reason: '系統超時自動取消（無司機接單），請重新叫車',
        });
      }
    }
  }
}

let instance: OrderCleanupService | null = null;
export function initOrderCleanupService(pool: Pool): OrderCleanupService {
  if (!instance) instance = new OrderCleanupService(pool);
  return instance;
}
export function getOrderCleanupService(): OrderCleanupService | null {
  return instance;
}

/**
 * OrderFallbackService
 *
 * 訂單 30 秒沒人接 + 有 preferred_fleet → 推 LINE flex prompt 給客人 3 選 1
 *  - 加碼折扣（提升 discount_amount，重新派單）
 *  - 改派排班司機（清 preferred_fleet_partner_id，允許外調）
 *  - 取消叫車
 *
 * 每 10 秒掃一次 OFFERED 訂單，用 orders.fallback_prompted_at 標記避免重推。
 * postback 由 LineMessageProcessor 接收（action=FALLBACK_RAISE/ALLOW_DISPATCH/CANCEL）。
 */

import { Pool } from 'pg';
import { messagingApi } from '@line/bot-sdk';
import * as templates from './LineFlexTemplates';

const FALLBACK_TIMEOUT_MS = 30 * 1000;
const SCAN_INTERVAL_MS = 10 * 1000;

export class OrderFallbackService {
  private pool: Pool;
  private lineClient: messagingApi.MessagingApiClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(pool: Pool) {
    this.pool = pool;
    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (channelAccessToken) {
      this.lineClient = new messagingApi.MessagingApiClient({ channelAccessToken });
    } else {
      console.warn('[OrderFallback] 無 LINE_CHANNEL_ACCESS_TOKEN，fallback prompt 無法推送');
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scan().catch(e =>
      console.error('[OrderFallback] scan 失敗:', e.message)
    ), SCAN_INTERVAL_MS);
    console.log('[OrderFallback] 已啟動 (每 10 秒掃一次)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async scan(): Promise<void> {
    if (this.running) return;  // 避免重入
    this.running = true;
    try {
      const result = await this.pool.query(
        `SELECT o.order_id, o.line_user_id, o.discount_amount, o.preferred_fleet_partner_id,
                COALESCE(o.offered_at, o.created_at) AS dispatched_at,
                p.name AS fleet_name
         FROM orders o
         LEFT JOIN partners p ON p.partner_id = o.preferred_fleet_partner_id
         WHERE o.status = 'OFFERED'
           AND o.driver_id IS NULL
           AND o.preferred_fleet_partner_id IS NOT NULL
           AND o.fallback_prompted_at IS NULL
           AND o.line_user_id IS NOT NULL
           AND COALESCE(o.offered_at, o.created_at) < NOW() - INTERVAL '30 seconds'
         LIMIT 20`
      );

      for (const row of result.rows) {
        await this.sendPrompt(row.order_id, row.line_user_id, Number(row.discount_amount) || 0, row.fleet_name || '指定車隊');
      }
    } finally {
      this.running = false;
    }
  }

  private async sendPrompt(orderId: string, lineUserId: string, discount: number, fleetName: string): Promise<void> {
    if (!this.lineClient) return;
    try {
      const msg = templates.fallbackPromptCarousel(orderId, discount, fleetName);
      await this.lineClient.pushMessage({
        to: lineUserId,
        messages: [msg],
      });
      // mark 已推
      await this.pool.query(
        'UPDATE orders SET fallback_prompted_at = CURRENT_TIMESTAMP WHERE order_id = $1',
        [orderId]
      );
      console.log(`[OrderFallback] ✓ 推送 ${orderId} (${fleetName}, 折扣 ${discount} 元)`);
    } catch (e: any) {
      console.error(`[OrderFallback] 推送失敗 ${orderId}:`, e.message);
    }
  }
}

let instance: OrderFallbackService | null = null;
export function initOrderFallbackService(pool: Pool): OrderFallbackService {
  if (!instance) {
    instance = new OrderFallbackService(pool);
    instance.start();
  }
  return instance;
}
export function getOrderFallbackService(): OrderFallbackService | null {
  return instance;
}

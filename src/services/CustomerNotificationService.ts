/**
 * CustomerNotificationService — 客人反向通知分派層
 *
 * 統一處理訂單狀態變化時的客人通知：
 *   - LINE 優先（line_user_id 存在時）
 *   - SMS 備援（customer_phone 存在時，走三竹 Mitake）
 *   - 去重（同 order × 同 event 的 SENT 紀錄只發一次）
 *   - 記錄 customer_notifications 表（供 admin 後台追蹤）
 *   - Feature flag：CUSTOMER_NOTIFICATION_ENABLED=true 才生效
 *
 * PR2 範圍：DRIVER_ACCEPTED / DRIVER_ARRIVED / DISPATCH_FAILED
 * PR2.5 規劃：PASSENGER_NO_SHOW 補 SMS 降級
 * 保留 LineNotifier shortcut：TRIP_COMPLETED (DONE) / DRIVER_WAITING (no-show 倒數)
 */

import { Pool } from 'pg';
import { LineNotifier } from './LineNotifier';
import { SmsNotifier, SmsSendResult } from './SmsNotifier';

export type NotificationEvent =
  | 'DRIVER_ACCEPTED'
  | 'DRIVER_ARRIVED'
  | 'DISPATCH_FAILED';

export type NotificationChannel = 'LINE' | 'SMS';

export interface NotifyContext {
  driverName?: string;
  plate?: string;
  etaMinutes?: number;
  pickupAddress?: string;
  reason?: string;
}

interface OrderContact {
  line_user_id: string | null;
  customer_phone: string | null;
}

export class CustomerNotificationService {
  constructor(
    private pool: Pool,
    private line: LineNotifier,
    private sms: SmsNotifier,
  ) {}

  // ========== Public API ==========

  async notifyDriverAccepted(orderId: string, ctx: NotifyContext): Promise<void> {
    await this.dispatch(
      orderId,
      'DRIVER_ACCEPTED',
      () => this.line.notifyOrderStatusChange(orderId, 'ACCEPTED', {
        driverName: ctx.driverName,
        plate: ctx.plate,
        etaMinutes: ctx.etaMinutes,
      }),
      this.smsTemplate('DRIVER_ACCEPTED', ctx),
    );
  }

  async notifyDriverArrived(orderId: string, ctx: NotifyContext): Promise<void> {
    await this.dispatch(
      orderId,
      'DRIVER_ARRIVED',
      () => this.line.notifyOrderStatusChange(orderId, 'ARRIVED', {
        driverName: ctx.driverName,
        plate: ctx.plate,
      }),
      this.smsTemplate('DRIVER_ARRIVED', ctx),
    );
  }

  async notifyDispatchFailed(orderId: string, reason: string): Promise<void> {
    await this.dispatch(
      orderId,
      'DISPATCH_FAILED',
      () => this.line.notifyNoDriverAvailable(orderId),
      this.smsTemplate('DISPATCH_FAILED', { reason }),
    );
  }

  // ========== 分派核心 ==========

  private async dispatch(
    orderId: string,
    event: NotificationEvent,
    sendViaLine: () => Promise<void>,
    smsMessage: string,
  ): Promise<void> {
    // 1. Feature flag：秒級關閉所有對外通知
    if (process.env.CUSTOMER_NOTIFICATION_ENABLED !== 'true') {
      return;
    }

    // 2. 去重查詢：同一訂單 × 同一事件的 SENT 紀錄只發一次
    //    防禦場景：司機誤按兩次接單、WebSocket 重連、狀態機幕等
    try {
      const dedupe = await this.pool.query(
        `SELECT 1 FROM customer_notifications
         WHERE order_id = $1 AND event = $2 AND status = 'SENT' LIMIT 1`,
        [orderId, event]
      );
      if (dedupe.rowCount && dedupe.rowCount > 0) {
        console.log(`[CustomerNotify] 已發送過 ${event} for ${orderId}，跳過重送`);
        return;
      }
    } catch (err) {
      // 查詢失敗不中斷發送流程，但要 log — 遵守「錯誤完整顯示」
      console.error(`[CustomerNotify] 去重查詢失敗 ${orderId}/${event}:`, err);
    }

    // 3. 查訂單通訊資訊
    const contact = await this.getOrderContact(orderId);
    if (!contact) {
      console.warn(`[CustomerNotify] 訂單 ${orderId} 不存在或無通訊資訊`);
      return;
    }

    // 4. LINE 優先
    if (contact.line_user_id) {
      try {
        await sendViaLine();
        await this.recordSuccess(orderId, event, 'LINE', contact.line_user_id);
        return;
      } catch (err: any) {
        // ★ 決策點 B：LINE 失敗降級策略 ★
        // ---------------------------------------------------------------
        // TODO 由你實作：
        //   - 若 err 指向 5xx / network timeout → 降級到 SMS（可靠度優先）
        //   - 若 err 指向 400 / bot blocked (客人封鎖) → 降級到 SMS（唯一能送達的管道）
        //   - 其他類型錯誤 → 記 log 不降級
        //
        // 提示：@line/bot-sdk 的 error 物件有 statusCode 屬性
        //       blocked 通常是 403 或 400 with specific message
        //
        // 目前預設：記 log 但不降級（最保守）— 請依你的可靠度 vs 成本判斷調整
        // ---------------------------------------------------------------
        console.error(`[CustomerNotify] LINE 推播失敗 ${orderId}/${event}:`, err?.message || err);
        await this.recordFailure(
          orderId,
          event,
          'LINE',
          contact.line_user_id,
          String(err?.statusCode ?? 'LINE_ERROR'),
          err?.message || String(err),
        );

        const shouldFallbackToSms = this.shouldFallbackToSms(err);
        if (!shouldFallbackToSms) return;
        // fallthrough 到 SMS
      }
    }

    // 5. SMS 備援
    if (contact.customer_phone) {
      // clientid 讓三竹做第二層去重（12 小時內同 orderId+event 不會重發、不扣點）
      // 加 timestamp 滿足 PDF 規範「必須維持唯一性，而非只在 12 小時內唯一」
      const clientid = `${orderId}:${event}:${Date.now()}`.slice(0, 36);
      const result = await this.sms.send(contact.customer_phone, smsMessage, { clientid });
      if (result.success) {
        await this.recordSuccess(
          orderId,
          event,
          'SMS',
          contact.customer_phone,
          result.messageId,
        );
      } else {
        await this.recordFailure(
          orderId,
          event,
          'SMS',
          contact.customer_phone,
          result.errorCode || 'SMS_FAILED',
          result.errorMessage || '三竹 SMS 發送失敗',
        );
      }
      return;
    }

    // 6. 兩個管道都無 — App 叫車客人走 WebSocket，本 service 不處理
    console.log(`[CustomerNotify] ${orderId}/${event} 無 line_user_id 也無 customer_phone（推測為 App 叫車）— 跳過`);
  }

  // ========== Helpers ==========

  private async getOrderContact(orderId: string): Promise<OrderContact | null> {
    const result = await this.pool.query<OrderContact>(
      'SELECT line_user_id, customer_phone FROM orders WHERE order_id = $1',
      [orderId]
    );
    return result.rows[0] ?? null;
  }

  private async recordSuccess(
    orderId: string,
    event: NotificationEvent,
    channel: NotificationChannel,
    target: string,
    providerMessageId?: string,
  ): Promise<void> {
    try {
      // 記錄通知歷史
      await this.pool.query(
        `INSERT INTO customer_notifications
         (order_id, channel, event, message, phone_or_line_id, status, provider_message_id)
         VALUES ($1, $2, $3, $4, $5, 'SENT', $6)`,
        [orderId, channel, event, this.redactedMessage(event, channel), target, providerMessageId ?? null]
      );

      // 更新訂單上的通知渠道旗標（司機 App 顯示徽章用）
      const channelField = channel === 'LINE' ? 'line_notification_sent_at' : 'sms_sent_at';
      await this.pool.query(
        `UPDATE orders
         SET notification_channel = $1, ${channelField} = CURRENT_TIMESTAMP
         WHERE order_id = $2`,
        [channel, orderId]
      );

      console.log(`[CustomerNotify] ✅ ${orderId}/${event} via ${channel}`);
    } catch (err) {
      // DB 寫入失敗不能吞掉，但已發送成功所以不丟錯
      console.error(`[CustomerNotify] 寫入 customer_notifications 失敗 ${orderId}/${event}:`, err);
    }
  }

  private async recordFailure(
    orderId: string,
    event: NotificationEvent,
    channel: NotificationChannel,
    target: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO customer_notifications
         (order_id, channel, event, message, phone_or_line_id, status, error_code, error_message)
         VALUES ($1, $2, $3, $4, $5, 'FAILED', $6, $7)`,
        [orderId, channel, event, this.redactedMessage(event, channel), target, errorCode, errorMessage]
      );
      console.warn(`[CustomerNotify] ❌ ${orderId}/${event} via ${channel} failed: ${errorCode} - ${errorMessage}`);
    } catch (err) {
      console.error(`[CustomerNotify] 寫入失敗紀錄也失敗 ${orderId}/${event}:`, err);
    }
  }

  /**
   * 減 message 存檔用（DB 欄位 NOT NULL 所以要填值）
   * 不存完整訊息避免長期佔 DB 空間，只標識事件類型
   */
  private redactedMessage(event: NotificationEvent, channel: NotificationChannel): string {
    return `[${channel}] ${event}`;
  }

  /**
   * ★ 決策點 B 輔助 ★ — LINE 失敗後是否要降級 SMS？
   *
   * 目前預設實作：不降級（保守策略）
   * TODO 由你擴充判斷邏輯（見 dispatch() 內的 TODO 註解）
   */
  private shouldFallbackToSms(err: any): boolean {
    // TODO: 依 err.statusCode 判斷是否降級
    //   const code = err?.statusCode;
    //   if (code >= 500 || code === undefined) return true;  // 5xx 或 network
    //   if (code === 403 || code === 400) return true;        // blocked / bad request
    //   return false;
    return false; // 預設不降級，由你決定打開
  }

  /**
   * ★ 決策點 A — SMS 三個事件的文案模板 ★
   *
   * 由你填寫文案 — 限制：
   *   - ≤ 70 個中文字（避免三竹拆兩則計費）
   *   - 開頭建議帶【大豐計程車】防詐騙辨識
   *   - 可用變數：ctx.driverName / ctx.plate / ctx.etaMinutes / ctx.pickupAddress / ctx.reason
   *   - 可從 process.env.CUSTOMER_SERVICE_PHONE 取客服電話
   */
  private smsTemplate(event: NotificationEvent, ctx: NotifyContext): string {
    const cs = process.env.CUSTOMER_SERVICE_PHONE || '';

    switch (event) {
      case 'DRIVER_ACCEPTED':
        // TODO 你的文案：司機姓名 + 車牌 + 預計 N 分鐘到達
        return `【大豐計程車】司機${ctx.driverName ?? ''}已接單，車牌${ctx.plate ?? ''}，預計${ctx.etaMinutes ?? '?'}分鐘到達。客服${cs}`;

      case 'DRIVER_ARRIVED':
        // TODO 你的文案：司機已到達上車點
        return `【大豐計程車】司機${ctx.driverName ?? ''}(${ctx.plate ?? ''})已到達${ctx.pickupAddress ?? '上車點'}，請準備上車`;

      case 'DISPATCH_FAILED':
        // TODO 你的文案：無司機可接
        return `【大豐計程車】很抱歉目前無司機可接單（${ctx.reason ?? ''}），請稍後再試或致電客服${cs}`;
    }
  }
}

// ========== 單例管理（與 LineNotifier / SmsNotifier 風格一致） ==========

let instance: CustomerNotificationService | null = null;

export function initCustomerNotificationService(
  pool: Pool,
  line: LineNotifier,
  sms: SmsNotifier,
): void {
  instance = new CustomerNotificationService(pool, line, sms);
}

export function getCustomerNotificationService(): CustomerNotificationService | null {
  return instance;
}

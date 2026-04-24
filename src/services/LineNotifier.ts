/**
 * LineNotifier - LINE 訂單狀態推播服務
 *
 * 當訂單狀態變更時，主動推送 LINE Push Message 給使用者
 * 只推播關鍵狀態（ACCEPTED、DONE、CANCELLED、無司機），節省 Push Message 費用
 */

import { Pool } from 'pg';
import { messagingApi } from '@line/bot-sdk';
import * as templates from './LineFlexTemplates';

export class LineNotifier {
  private pool: Pool;
  private lineClient: messagingApi.MessagingApiClient;

  constructor(pool: Pool) {
    this.pool = pool;

    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!channelAccessToken) {
      throw new Error('LINE_CHANNEL_ACCESS_TOKEN is required for LineNotifier');
    }

    this.lineClient = new messagingApi.MessagingApiClient({ channelAccessToken });
  }

  /**
   * 訂單狀態變更通知
   * 只在訂單有 line_user_id 時才推播
   */
  async notifyOrderStatusChange(
    orderId: string,
    newStatus: string,
    extraData?: { fare?: number; driverName?: string; plate?: string; etaMinutes?: number; reason?: string }
  ): Promise<void> {
    try {
      // 查詢訂單的 line_user_id
      const result = await this.pool.query(
        'SELECT line_user_id, driver_id FROM orders WHERE order_id = $1',
        [orderId]
      );

      if (result.rows.length === 0) return;

      const { line_user_id, driver_id } = result.rows[0];
      if (!line_user_id) return; // 非 LINE 訂單，跳過

      let message: messagingApi.Message | null = null;

      switch (newStatus) {
        case 'ACCEPTED': {
          // 查詢司機資訊
          let driverName = extraData?.driverName || '司機';
          let plate = extraData?.plate || '';
          const etaMinutes = extraData?.etaMinutes || null;

          if (!extraData?.driverName && driver_id) {
            const driverResult = await this.pool.query(
              'SELECT name, plate FROM drivers WHERE driver_id = $1',
              [driver_id]
            );
            if (driverResult.rows[0]) {
              driverName = driverResult.rows[0].name;
              plate = driverResult.rows[0].plate;
            }
          }

          message = templates.driverAcceptedCard(orderId, driverName, plate, etaMinutes);
          break;
        }

        case 'ARRIVED': {
          // 司機到達上車點 — 通知客人出來上車
          let driverName = extraData?.driverName || '司機';
          let plate = extraData?.plate || '';
          let pickupAddress = '';

          // 查詢訂單詳細資料（司機資訊 + 上車地址）
          const detail = await this.pool.query(
            `SELECT d.name AS driver_name, d.plate AS driver_plate, o.pickup_address
             FROM orders o
             LEFT JOIN drivers d ON o.driver_id = d.driver_id
             WHERE o.order_id = $1`,
            [orderId]
          );
          if (detail.rows[0]) {
            driverName = extraData?.driverName || detail.rows[0].driver_name || driverName;
            plate = extraData?.plate || detail.rows[0].driver_plate || plate;
            pickupAddress = detail.rows[0].pickup_address || '';
          }

          message = templates.driverArrivedCard(driverName, plate, pickupAddress);
          break;
        }

        case 'DONE':
        case 'SETTLING': {
          const fare = extraData?.fare || 0;
          if (fare > 0) {
            message = templates.tripCompletedCard(orderId, fare);
          }
          break;
        }

        case 'CANCELLED': {
          const reason = extraData?.reason || '訂單已取消';
          message = templates.orderCancelledCard(orderId, reason);
          break;
        }
      }

      if (message) {
        await this.lineClient.pushMessage({
          to: line_user_id,
          messages: [message],
        });
        console.log(`[LineNotifier] 已推播 ${newStatus} 通知給 ${line_user_id} (訂單 ${orderId})`);
      }

    } catch (error: any) {
      // Push 失敗不影響主流程（使用者可能已封鎖）
      console.error(`[LineNotifier] 推播失敗 (${orderId}):`, error.message || error);
    }
  }

  /**
   * 司機等候中提醒 — 司機按「客人未到」後推送，告訴客人還有多少分鐘就自動取消
   *
   * @param orderId 訂單 ID
   * @param remainingMinutes 距離自動取消還有幾分鐘（0 表即將取消）
   */
  async notifyDriverWaitingForPassenger(orderId: string, remainingMinutes: number): Promise<void> {
    try {
      const result = await this.pool.query(
        'SELECT line_user_id FROM orders WHERE order_id = $1',
        [orderId]
      );
      if (result.rows.length === 0) return;

      const { line_user_id } = result.rows[0];
      if (!line_user_id) return;

      await this.lineClient.pushMessage({
        to: line_user_id,
        messages: [templates.waitingForPassengerCard(remainingMinutes)],
      });
      console.log(`[LineNotifier] 已推播等候中提醒 (訂單 ${orderId}, 剩 ${remainingMinutes} 分鐘)`);
    } catch (error: any) {
      console.error(`[LineNotifier] 等候提醒推播失敗 (${orderId}):`, error.message || error);
    }
  }

  /**
   * 訂單已建立通知（叫車成功，正在媒合司機）
   * 目的：讓使用者從 LIFF 回到聊天室後，看到系統正在運作
   */
  async notifyOrderCreated(orderId: string): Promise<void> {
    try {
      const result = await this.pool.query(
        'SELECT line_user_id, pickup_address FROM orders WHERE order_id = $1',
        [orderId]
      );
      if (result.rows.length === 0) return;

      const { line_user_id, pickup_address } = result.rows[0];
      if (!line_user_id) return;

      await this.lineClient.pushMessage({
        to: line_user_id,
        messages: [templates.orderCreatedCard(orderId, pickup_address || '已定位')],
      });
      console.log(`[LineNotifier] 已推播訂單建立通知給 ${line_user_id} (訂單 ${orderId})`);
    } catch (error: any) {
      console.error(`[LineNotifier] 訂單建立推播失敗 (${orderId}):`, error.message || error);
    }
  }

  /**
   * 無可用司機通知
   */
  async notifyNoDriverAvailable(orderId: string): Promise<void> {
    try {
      const result = await this.pool.query(
        'SELECT line_user_id FROM orders WHERE order_id = $1',
        [orderId]
      );

      if (result.rows.length === 0) return;

      const { line_user_id } = result.rows[0];
      if (!line_user_id) return;

      await this.lineClient.pushMessage({
        to: line_user_id,
        messages: [templates.noDriverCard()],
      });
      console.log(`[LineNotifier] 已推播無司機通知給 ${line_user_id} (訂單 ${orderId})`);

    } catch (error: any) {
      console.error(`[LineNotifier] 無司機推播失敗 (${orderId}):`, error.message || error);
    }
  }

  /**
   * 預約提醒
   */
  async notifyScheduledOrderReminder(orderId: string): Promise<void> {
    try {
      const result = await this.pool.query(
        'SELECT line_user_id, scheduled_at, pickup_address FROM orders WHERE order_id = $1',
        [orderId]
      );

      if (result.rows.length === 0) return;

      const { line_user_id, scheduled_at, pickup_address } = result.rows[0];
      if (!line_user_id) return;

      const scheduledTime = this.formatDateTime(new Date(scheduled_at));
      const message = templates.scheduleReminderCard(orderId, scheduledTime, pickup_address);

      await this.lineClient.pushMessage({
        to: line_user_id,
        messages: [message],
      });
      console.log(`[LineNotifier] 已推播預約提醒給 ${line_user_id} (訂單 ${orderId})`);

    } catch (error: any) {
      console.error(`[LineNotifier] 預約提醒推播失敗 (${orderId}):`, error.message || error);
    }
  }

  private formatDateTime(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}/${m}/${d} ${h}:${min}`;
  }
}

// ========== 單例管理 ==========

let lineNotifier: LineNotifier | null = null;

export function initLineNotifier(pool: Pool): void {
  lineNotifier = new LineNotifier(pool);
}

export function getLineNotifier(): LineNotifier | null {
  return lineNotifier;
}

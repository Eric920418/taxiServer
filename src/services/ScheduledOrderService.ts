/**
 * ScheduledOrderService - 預約訂單排程服務
 *
 * 使用 BullMQ (via IQueueAdapter) 排程預約訂單：
 * - 提前 15 分鐘推送 LINE 提醒
 * - 提前 5 分鐘觸發 SmartDispatcherV2 派單
 *
 * 2026-04-23 Phase 1：從 Bull v4 遷移到 BullMQ（消除 floating promise rejection 噪音）
 */

import { Pool } from 'pg';
import { BullMQAdapter } from './queue/BullMQAdapter';
import { IQueueAdapter } from './queue/IQueueAdapter';
import { getSmartDispatcherV2, OrderData } from './SmartDispatcherV2';
import { getLineNotifier } from './LineNotifier';

// ========== 類型定義 ==========

interface ScheduledJobData {
  orderId: string;
  type: 'DISPATCH' | 'REMINDER';
}

// ========== 服務類 ==========

export class ScheduledOrderService {
  private pool: Pool;
  private queue: IQueueAdapter<ScheduledJobData>;

  constructor(pool: Pool) {
    this.pool = pool;

    this.queue = new BullMQAdapter<ScheduledJobData>('scheduled-orders', {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
    });

    // Job 失敗 log（retry 全失敗才觸發）
    this.queue.onFailed((jobId, err) => {
      console.error(`[ScheduledOrderService] Job ${jobId} 失敗: ${err.message}`);
    });

    this.setupProcessor();
    // restorePendingSchedules 失敗不擋啟動（DB 沒建好、Redis 沒接好都會失敗）
    this.restorePendingSchedules().catch((err) => {
      console.warn('[ScheduledOrderService] 恢復預約排程失敗（startup 不阻擋）:', err.message);
    });

    console.log('[ScheduledOrderService] 預約排程服務已初始化（BullMQ）');
  }

  /**
   * 加入預約排程
   * jobId 去重：同 orderId 重複 add 會被 BullMQ 自動忽略（throw "already exists"）
   */
  async scheduleOrder(orderId: string, scheduledAt: Date): Promise<void> {
    const now = Date.now();
    const scheduledTime = scheduledAt.getTime();

    // 提前 5 分鐘派單
    const dispatchDelay = Math.max(0, scheduledTime - now - 5 * 60 * 1000);
    await this.tryAddJob(
      { orderId, type: 'DISPATCH' },
      { delay: dispatchDelay, jobId: `dispatch-${orderId}`, removeOnComplete: true },
      'DISPATCH'
    );

    // 提前 15 分鐘提醒
    const reminderDelay = scheduledTime - now - 15 * 60 * 1000;
    if (reminderDelay > 0) {
      await this.tryAddJob(
        { orderId, type: 'REMINDER' },
        { delay: reminderDelay, jobId: `reminder-${orderId}`, removeOnComplete: true },
        'REMINDER'
      );
    }

    console.log(`[ScheduledOrderService] 訂單 ${orderId} 已排程: 派單延遲 ${Math.round(dispatchDelay / 60000)}分鐘, 提醒延遲 ${Math.round(reminderDelay / 60000)}分鐘`);
  }

  /**
   * add job + catch「已存在」(重複 schedule 或 restore 已有 job 時會發生)
   * 其他錯誤照常 throw 讓 caller 處理
   */
  private async tryAddJob(
    data: ScheduledJobData,
    opts: { delay: number; jobId: string; removeOnComplete: boolean },
    jobName: string
  ): Promise<void> {
    try {
      await this.queue.add(data, opts, jobName);
    } catch (err: any) {
      const msg = String(err?.message ?? '');
      if (msg.includes('already exists') || msg.includes('Duplicate')) {
        // jobId 已存在 — restore / 重複 schedule，silently skip
        return;
      }
      throw err;
    }
  }

  /**
   * 取消預約
   */
  async cancelScheduled(orderId: string): Promise<void> {
    await this.queue.cancel(`dispatch-${orderId}`);
    await this.queue.cancel(`reminder-${orderId}`);
    console.log(`[ScheduledOrderService] 訂單 ${orderId} 排程已取消`);
  }

  /**
   * 設定 Queue 處理器
   */
  private setupProcessor(): void {
    this.queue.registerProcessor(async (job) => {
      const { orderId, type } = job.data;
      console.log(`[ScheduledOrderService] 處理排程任務: ${type} - ${orderId}`);

      if (type === 'DISPATCH') {
        await this.dispatchScheduledOrder(orderId);
      } else if (type === 'REMINDER') {
        await this.sendReminder(orderId);
      }
    });
  }

  /**
   * 觸發預約訂單派單
   */
  private async dispatchScheduledOrder(orderId: string): Promise<void> {
    // 查詢訂單
    const result = await this.pool.query(
      `SELECT o.*, p.name as passenger_name, p.phone as passenger_phone
       FROM orders o
       LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
       WHERE o.order_id = $1`,
      [orderId]
    );

    if (result.rows.length === 0) {
      console.log(`[ScheduledOrderService] 訂單 ${orderId} 不存在，跳過`);
      return;
    }

    const order = result.rows[0];

    // 檢查訂單是否還在等待狀態
    if (order.status === 'CANCELLED') {
      console.log(`[ScheduledOrderService] 訂單 ${orderId} 已取消，跳過派單`);
      return;
    }

    // 更新狀態為 OFFERED
    await this.pool.query(
      `UPDATE orders SET status = 'OFFERED', offered_at = CURRENT_TIMESTAMP WHERE order_id = $1`,
      [orderId]
    );

    // 觸發 SmartDispatcherV2 派單
    const dispatcher = getSmartDispatcherV2();
    const orderData: OrderData = {
      orderId,
      passengerId: order.passenger_id,
      passengerName: order.passenger_name || 'LINE 用戶',
      passengerPhone: order.passenger_phone || '',
      pickup: {
        lat: parseFloat(order.pickup_lat),
        lng: parseFloat(order.pickup_lng),
        address: order.pickup_address || '',
      },
      destination: order.dest_lat ? {
        lat: parseFloat(order.dest_lat),
        lng: parseFloat(order.dest_lng),
        address: order.dest_address || '',
      } : null,
      paymentType: order.payment_type || 'CASH',
      createdAt: Date.now(),
      source: 'LINE',
    };

    await dispatcher.startDispatch(orderData);
    console.log(`[ScheduledOrderService] 預約訂單 ${orderId} 已觸發派單`);
  }

  /**
   * 發送提前提醒
   */
  private async sendReminder(orderId: string): Promise<void> {
    const lineNotifier = getLineNotifier();
    if (lineNotifier) {
      await lineNotifier.notifyScheduledOrderReminder(orderId);
    }
  }

  /**
   * 伺服器重啟時恢復待處理的預約
   *
   * 之前 Bull 版用 getJob() 檢查 job 是否存在避免重複 add。改 BullMQ 後簡化：
   * scheduleOrder() 內部 tryAddJob 會 catch「already exists」error，直接呼叫即可。
   */
  private async restorePendingSchedules(): Promise<void> {
    const result = await this.pool.query(`
      SELECT order_id, scheduled_at FROM orders
      WHERE scheduled_at IS NOT NULL
        AND status IN ('WAITING', 'OFFERED')
        AND scheduled_at > NOW()
      ORDER BY scheduled_at ASC
    `);

    for (const row of result.rows) {
      const scheduledAt = new Date(row.scheduled_at);
      await this.scheduleOrder(row.order_id, scheduledAt);
      console.log(`[ScheduledOrderService] 恢復排程: ${row.order_id} → ${scheduledAt.toISOString()}`);
    }

    if (result.rows.length > 0) {
      console.log(`[ScheduledOrderService] 共恢復 ${result.rows.length} 個預約排程`);
    }
  }

  /**
   * Graceful shutdown — SIGTERM 時呼叫
   */
  async shutdown(): Promise<void> {
    await this.queue.close();
  }
}

// ========== 單例管理 ==========

let scheduledOrderService: ScheduledOrderService | null = null;

export function initScheduledOrderService(pool: Pool): void {
  scheduledOrderService = new ScheduledOrderService(pool);
}

export function getScheduledOrderService(): ScheduledOrderService | null {
  return scheduledOrderService;
}

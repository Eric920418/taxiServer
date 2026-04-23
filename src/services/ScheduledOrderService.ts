/**
 * ScheduledOrderService - 預約訂單排程服務
 *
 * 使用 Bull Queue (Redis) 排程預約訂單：
 * - 提前 15 分鐘推送 LINE 提醒
 * - 提前 5 分鐘觸發 SmartDispatcherV2 派單
 */

import { Pool } from 'pg';
import Bull from 'bull';
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
  private queue: Bull.Queue<ScheduledJobData>;

  constructor(pool: Pool) {
    this.pool = pool;

    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379');

    this.queue = new Bull<ScheduledJobData>('scheduled-orders', {
      redis: { host: redisHost, port: redisPort },
    });

    // Layer 2 防護：Bull connect/job error 消音，避免 unhandledRejection 噪音
    this.queue.on('error', (err) => {
      console.warn(`[ScheduledOrderService] Redis 連線錯誤（預約排程功能 degraded）: ${err.message}`);
    });
    this.queue.on('failed', (job, err) => {
      console.error(`[ScheduledOrderService] Job ${job.id} 失敗: ${err.message}`);
    });

    this.setupProcessor();
    // restorePendingSchedules 失敗不擋啟動（DB 沒建好、Redis 沒接好都會失敗）
    this.restorePendingSchedules().catch((err) => {
      console.warn('[ScheduledOrderService] 恢復預約排程失敗（startup 不阻擋）:', err.message);
    });

    console.log('[ScheduledOrderService] 預約排程服務已初始化');
  }

  /**
   * 加入預約排程
   */
  async scheduleOrder(orderId: string, scheduledAt: Date): Promise<void> {
    const now = Date.now();
    const scheduledTime = scheduledAt.getTime();

    // 提前 5 分鐘派單
    const dispatchDelay = Math.max(0, scheduledTime - now - 5 * 60 * 1000);
    await this.queue.add(
      { orderId, type: 'DISPATCH' },
      { delay: dispatchDelay, jobId: `dispatch-${orderId}`, removeOnComplete: true }
    );

    // 提前 15 分鐘提醒
    const reminderDelay = scheduledTime - now - 15 * 60 * 1000;
    if (reminderDelay > 0) {
      await this.queue.add(
        { orderId, type: 'REMINDER' },
        { delay: reminderDelay, jobId: `reminder-${orderId}`, removeOnComplete: true }
      );
    }

    console.log(`[ScheduledOrderService] 訂單 ${orderId} 已排程: 派單延遲 ${Math.round(dispatchDelay / 60000)}分鐘, 提醒延遲 ${Math.round(reminderDelay / 60000)}分鐘`);
  }

  /**
   * 取消預約
   */
  async cancelScheduled(orderId: string): Promise<void> {
    try {
      const dispatchJob = await this.queue.getJob(`dispatch-${orderId}`);
      if (dispatchJob) await dispatchJob.remove();

      const reminderJob = await this.queue.getJob(`reminder-${orderId}`);
      if (reminderJob) await reminderJob.remove();

      console.log(`[ScheduledOrderService] 訂單 ${orderId} 排程已取消`);
    } catch (error) {
      console.error(`[ScheduledOrderService] 取消排程失敗 (${orderId}):`, error);
    }
  }

  /**
   * 設定 Queue 處理器
   */
  private setupProcessor(): void {
    this.queue.process(async (job) => {
      const { orderId, type } = job.data;
      console.log(`[ScheduledOrderService] 處理排程任務: ${type} - ${orderId}`);

      try {
        if (type === 'DISPATCH') {
          await this.dispatchScheduledOrder(orderId);
        } else if (type === 'REMINDER') {
          await this.sendReminder(orderId);
        }
      } catch (error) {
        console.error(`[ScheduledOrderService] 排程任務失敗 (${type} - ${orderId}):`, error);
        throw error; // Bull 會自動重試
      }
    });

    this.queue.on('failed', (job, err) => {
      console.error(`[ScheduledOrderService] Job 失敗 (${job.id}):`, err.message);
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
   */
  private async restorePendingSchedules(): Promise<void> {
    try {
      const result = await this.pool.query(`
        SELECT order_id, scheduled_at FROM orders
        WHERE scheduled_at IS NOT NULL
          AND status IN ('WAITING', 'OFFERED')
          AND scheduled_at > NOW()
        ORDER BY scheduled_at ASC
      `);

      for (const row of result.rows) {
        const scheduledAt = new Date(row.scheduled_at);

        // 檢查 job 是否已存在
        const existingJob = await this.queue.getJob(`dispatch-${row.order_id}`);
        if (!existingJob) {
          await this.scheduleOrder(row.order_id, scheduledAt);
          console.log(`[ScheduledOrderService] 恢復排程: ${row.order_id} → ${scheduledAt.toISOString()}`);
        }
      }

      if (result.rows.length > 0) {
        console.log(`[ScheduledOrderService] 共恢復 ${result.rows.length} 個預約排程`);
      }
    } catch (error) {
      console.error('[ScheduledOrderService] 恢復排程失敗:', error);
    }
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

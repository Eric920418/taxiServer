/**
 * BullMQAdapter — 用 BullMQ (v4 重寫版) 實作 IQueueAdapter
 *
 * BullMQ vs Bull 關鍵差異：
 * - Queue / Worker / QueueEvents 三個獨立物件（Bull 把它們全塞 Queue 內）
 * - 全 async/await，消除 Bull 的 floating promise rejection 噪音（本次升級主因）
 * - 原生 TypeScript support
 *
 * Queue：producer 端，負責 add job
 * Worker：consumer 端，負責 process job
 * QueueEvents：事件流（completed/failed），獨立 Redis 連線 subscribe
 */

import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { IQueueAdapter, QueueJob, AddJobOptions, QueueConnectionConfig } from './IQueueAdapter';

export class BullMQAdapter<T = unknown> implements IQueueAdapter<T> {
  public readonly name: string;
  private readonly connection: QueueConnectionConfig;
  // BullMQ Queue 泛型 3 個：data, returnValue, jobName。我們統一 jobName 為 string
  private readonly queue: Queue<T, any, string>;
  private worker?: Worker<T, any, string>;
  private events?: QueueEvents;
  private _isHealthy: boolean = true;
  private readonly defaultJobName: string;

  constructor(name: string, connection: QueueConnectionConfig) {
    this.name = name;
    this.connection = connection;
    this.defaultJobName = `${name}-job`;

    this.queue = new Queue<T, any, string>(name, {
      connection: {
        host: connection.host,
        port: connection.port,
        password: connection.password,
        db: connection.db,
      },
    });

    this.queue.on('error', (err) => {
      this._isHealthy = false;
      console.warn(`[BullMQAdapter:${name}] Queue error: ${err.message}`);
    });
  }

  get isHealthy(): boolean {
    return this._isHealthy;
  }

  async add(data: T, options?: AddJobOptions, jobName?: string): Promise<string> {
    const name = jobName || this.defaultJobName;
    const bullMQOpts = {
      jobId: options?.jobId,
      delay: options?.delay,
      attempts: options?.attempts,
      removeOnComplete: options?.removeOnComplete,
      removeOnFail: options?.removeOnFail,
      repeat: options?.repeat ? { pattern: options.repeat.cron, tz: options.repeat.tz } : undefined,
    };
    // BullMQ Queue.add() 用 ExtractNameType<T,N> 條件式泛型嚴格化，TS 無法 narrow string。
    // 我們設計是「同 queue 所有 job 用同一 string name」，runtime 安全，as unknown as any 繞過。
    const job = await (this.queue as unknown as { add: (n: string, d: T, o: unknown) => Promise<Job<T, any, string>> })
      .add(name, data, bullMQOpts);
    return String(job.id);
  }

  async cancel(jobId: string): Promise<boolean> {
    try {
      const job = await this.queue.getJob(jobId);
      if (!job) return false;
      await job.remove();
      return true;
    } catch (err: any) {
      console.warn(`[BullMQAdapter:${this.name}] cancel ${jobId} 失敗: ${err?.message}`);
      return false;
    }
  }

  registerProcessor(handler: (job: QueueJob<T>) => Promise<void>): void {
    if (this.worker) {
      throw new Error(`[BullMQAdapter:${this.name}] worker 已存在，不可重複註冊 processor`);
    }
    this.worker = new Worker<T, any, string>(
      this.name,
      async (job: Job<T, any, string>) => {
        await handler({ id: String(job.id), name: job.name, data: job.data });
      },
      {
        connection: {
          host: this.connection.host,
          port: this.connection.port,
          password: this.connection.password,
          db: this.connection.db,
        },
      }
    );
    this.worker.on('error', (err) => {
      console.warn(`[BullMQAdapter:${this.name}] Worker error: ${err.message}`);
    });
  }

  onFailed(listener: (jobId: string, error: Error) => void): void {
    // BullMQ: 事件要走獨立 QueueEvents（避免污染 Worker / Queue 的 Redis 連線）
    if (!this.events) {
      this.events = new QueueEvents(this.name, {
        connection: {
          host: this.connection.host,
          port: this.connection.port,
          password: this.connection.password,
          db: this.connection.db,
        },
      });
      this.events.on('error', (err) => {
        console.warn(`[BullMQAdapter:${this.name}] QueueEvents error: ${err.message}`);
      });
    }
    this.events.on('failed', ({ jobId, failedReason }) => {
      listener(jobId, new Error(failedReason));
    });
  }

  /**
   * Graceful shutdown — 關閉 Queue / Worker / QueueEvents 三物件
   *
   * TODO: 請你貢獻這段實作。設計選擇（5-10 行）：
   *
   * 【選擇 1：Worker 先、Queue 再、Events 最後（序列）】
   *   worker.close() 會等正在跑的 job 完成才 resolve（BullMQ 內建 graceful wait）
   *   優點：最安全，job 不會被中斷
   *   缺點：若有 long-running job (>30s)，SIGTERM 到 process kill 的時間可能不夠
   *
   * 【選擇 2：Queue 先、Worker 再、Events 最後（序列）】
   *   先停止接新 job → 再等 Worker 做完現有 → 最後關 Events
   *   優點：更乾淨的「停止接新任務」語意
   *   缺點：close Queue 不會阻塞 Worker，意義跟選擇 1 幾乎一樣
   *
   * 【選擇 3：Promise.allSettled 平行】
   *   所有物件同時 close
   *   優點：快（省 100-500ms）
   *   缺點：Worker 若在處理 job，可能被強制中斷（看 BullMQ 版本行為）
   *
   * 推薦：選擇 1。理由：pm2 graceful shutdown timeout 預設 1.6 秒 → 若 job > 1.6s
   * 本來就會被 SIGKILL，我們只能盡量；選擇 1 語意最清楚。
   *
   * 實作位置：下方 TODO，大概 5-8 行。沒有 worker / events 時要跳過（用 ?. ）。
   */
  async close(): Promise<void> {
    // 序列 graceful shutdown：Worker 先（等 jobs 跑完）→ Queue（停接新 job）→ Events（關 subscribe）
    // 任一物件 close 失敗不擋其他，用 .catch 吸收 — 避免 SIGTERM 時 process 卡死
    await this.worker?.close().catch((err) => {
      console.warn(`[BullMQAdapter:${this.name}] Worker close 失敗: ${err.message}`);
    });
    await this.queue.close().catch((err) => {
      console.warn(`[BullMQAdapter:${this.name}] Queue close 失敗: ${err.message}`);
    });
    await this.events?.close().catch((err) => {
      console.warn(`[BullMQAdapter:${this.name}] QueueEvents close 失敗: ${err.message}`);
    });
  }
}

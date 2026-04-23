/**
 * BullAdapter — 包裝現有 Bull (v4) API 到 IQueueAdapter 介面
 *
 * 作用：Option B 並行共存策略中，已經用 Bull 的 queue（queue.ts 5 queue）
 *       透過這個 adapter 對外暴露，caller 改成用 adapter 後就可以隨時切換到 BullMQAdapter
 *       而不用改 caller 端。
 *
 * 注意：這個 adapter 繼承 Bull 的所有限制（包括 floating promise rejection 噪音），
 *       但 Layer 1/2 防護網會接住。升級到 BullMQAdapter 才真正解。
 */

import Bull from 'bull';
import { IQueueAdapter, QueueJob, AddJobOptions, QueueConnectionConfig } from './IQueueAdapter';

export class BullAdapter<T = unknown> implements IQueueAdapter<T> {
  public readonly name: string;
  private readonly queue: Bull.Queue<T>;
  private _isHealthy: boolean = true;
  private processorRegistered = false;

  constructor(name: string, connection: QueueConnectionConfig) {
    this.name = name;
    this.queue = new Bull<T>(name, {
      redis: {
        host: connection.host,
        port: connection.port,
        password: connection.password,
        db: connection.db,
      },
    });

    // Layer 2 防護：消音 Redis connect 錯誤
    this.queue.on('error', (err) => {
      this._isHealthy = false;
      console.warn(`[BullAdapter:${name}] Redis error: ${err.message}`);
    });
    this.queue.on('ready', () => {
      if (!this._isHealthy) console.info(`[BullAdapter:${name}] Redis 恢復`);
      this._isHealthy = true;
    });
  }

  get isHealthy(): boolean {
    return this._isHealthy;
  }

  async add(data: T, options?: AddJobOptions, _jobName?: string): Promise<string> {
    // Bull 沒有 jobName 概念，忽略該參數（BullMQAdapter 才會用）
    const bullOpts: Bull.JobOptions = {
      jobId: options?.jobId,
      delay: options?.delay,
      attempts: options?.attempts,
      removeOnComplete: options?.removeOnComplete,
      removeOnFail: options?.removeOnFail,
      repeat: options?.repeat ? { cron: options.repeat.cron, tz: options.repeat.tz } : undefined,
    };
    const job = await this.queue.add(data, bullOpts);
    return String(job.id);
  }

  async cancel(jobId: string): Promise<boolean> {
    try {
      const job = await this.queue.getJob(jobId);
      if (!job) return false;
      await job.remove();
      return true;
    } catch (err: any) {
      console.warn(`[BullAdapter:${this.name}] cancel ${jobId} 失敗: ${err?.message}`);
      return false;
    }
  }

  registerProcessor(handler: (job: QueueJob<T>) => Promise<void>): void {
    if (this.processorRegistered) {
      throw new Error(`[BullAdapter:${this.name}] processor 已註冊過，不可重複`);
    }
    this.processorRegistered = true;
    this.queue.process(async (job) => {
      await handler({ id: String(job.id), name: job.name || this.name, data: job.data });
    });
  }

  onFailed(listener: (jobId: string, error: Error) => void): void {
    this.queue.on('failed', (job, err) => {
      listener(String(job.id), err);
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

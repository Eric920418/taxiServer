/**
 * IQueueAdapter — Bull / BullMQ 雙實作的抽象介面
 *
 * 目的：讓業務邏輯（ScheduledOrderService / queue.ts 等）不直接依賴 Bull 或 BullMQ 套件，
 *       可以透過 factory 切換 implementation，分階段遷移不影響 caller。
 *
 * 設計原則：
 * - 只暴露業務真正需要的 method，不把 Bull/BullMQ 所有 API 都翻譯（over-engineering）
 * - 簽名朝 BullMQ 風格靠齊（async、明確 job name）— 為 Bull 移除後的終局做準備
 * - 錯誤處理由 adapter 內部吸收（不 throw connect/subscribe 噪音），業務面對的是乾淨 promise
 */

export interface QueueJob<T> {
  id: string;
  name: string;
  data: T;
}

export interface AddJobOptions {
  /** Job 唯一 ID（同 ID 重複 add 會 dedupe） */
  jobId?: string;
  /** 延遲多少毫秒後才執行（用於預約訂單） */
  delay?: number;
  /** 重試次數 */
  attempts?: number;
  /** 完成後保留幾個（避免 Redis 爆炸） */
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
  /** Cron 排程（repeatable job） */
  repeat?: { cron: string; tz?: string };
}

/**
 * Queue adapter — 每個 service 持有一個 instance，綁定到一個具名 queue。
 */
export interface IQueueAdapter<T = unknown> {
  readonly name: string;

  /**
   * 加入 job（立即執行或 delayed，依 options.delay 決定）
   * 回傳 job ID（BullMQ 需要 jobName 參數，若未提供用 queue name）
   */
  add(data: T, options?: AddJobOptions, jobName?: string): Promise<string>;

  /**
   * 取消某 job（by ID）— 不存在不 throw
   */
  cancel(jobId: string): Promise<boolean>;

  /**
   * 註冊處理器。每個 queue 只能 register 一次（多次會 throw）。
   * handler 若 throw，由 adapter 依 attempts 策略重試。
   */
  registerProcessor(handler: (job: QueueJob<T>) => Promise<void>): void;

  /**
   * 監聽 job 失敗事件（retry 全失敗才觸發）— 主要給監控 / log 用
   *
   * 注意：BullMQ 的 failed event payload 沒有 attemptsMade，只有 jobId / failedReason。
   * 若需要 attempts 數，caller 需自行 getJob(jobId).attemptsMade —— 但通常 log 夠用。
   */
  onFailed(listener: (jobId: string, error: Error) => void): void;

  /**
   * Graceful shutdown — 停止接收新 job，等正在處理的 job 完成
   */
  close(): Promise<void>;

  /**
   * 健康狀態（Redis 是否可用）— false 時 caller 可決定跳過 add job
   */
  readonly isHealthy: boolean;
}

/**
 * Queue 連線配置
 */
export interface QueueConnectionConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

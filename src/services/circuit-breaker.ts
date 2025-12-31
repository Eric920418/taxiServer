/**
 * 斷路器模式實現
 * 防止級聯故障，提高系統韌性
 */

import logger from './logger';
import { updateHealthMetrics } from './metrics';

export enum CircuitState {
  CLOSED = 'CLOSED',      // 正常狀態
  OPEN = 'OPEN',          // 斷路狀態
  HALF_OPEN = 'HALF_OPEN' // 半開狀態（測試恢復）
}

export interface CircuitBreakerOptions {
  name: string;
  timeout?: number;           // 請求超時時間（毫秒）
  errorThreshold?: number;    // 錯誤閾值（百分比）
  volumeThreshold?: number;   // 最小請求數量
  sleepWindow?: number;       // 斷路後等待時間（毫秒）
  requestTimeout?: number;    // 單個請求超時（毫秒）
  resetTimeout?: number;      // 統計重置時間（毫秒）
  fallback?: () => any;      // 降級處理函數
  onStateChange?: (oldState: CircuitState, newState: CircuitState) => void;
}

export class CircuitBreaker {
  private name: string;
  private state: CircuitState = CircuitState.CLOSED;
  private timeout: number;
  private errorThreshold: number;
  private volumeThreshold: number;
  private sleepWindow: number;
  private requestTimeout: number;
  private resetTimeout: number;
  private fallback?: () => any;
  private onStateChange?: (oldState: CircuitState, newState: CircuitState) => void;

  // 統計數據
  private requests = 0;
  private failures = 0;
  private successes = 0;
  private lastFailureTime?: Date;
  private nextAttempt?: Date;
  private buckets: Map<number, { requests: number; failures: number }> = new Map();

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.timeout = options.timeout || 3000;
    this.errorThreshold = options.errorThreshold || 50;
    this.volumeThreshold = options.volumeThreshold || 10;
    this.sleepWindow = options.sleepWindow || 60000;
    this.requestTimeout = options.requestTimeout || 3000;
    this.resetTimeout = options.resetTimeout || 60000;
    this.fallback = options.fallback;
    this.onStateChange = options.onStateChange;

    // 定期重置統計
    setInterval(() => this.resetStats(), this.resetTimeout);
  }

  /**
   * 執行受保護的函數
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // 檢查斷路器狀態
    if (this.state === CircuitState.OPEN) {
      return this.handleOpenState();
    }

    // 半開狀態：嘗試一個請求
    if (this.state === CircuitState.HALF_OPEN) {
      return this.handleHalfOpenState(fn);
    }

    // 關閉狀態：正常執行
    return this.handleClosedState(fn);
  }

  /**
   * 處理關閉狀態
   */
  private async handleClosedState<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await this.callWithTimeout(fn);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  /**
   * 處理開啟狀態
   */
  private async handleOpenState<T>(): Promise<T> {
    const now = new Date();

    // 檢查是否可以進入半開狀態
    if (this.nextAttempt && now >= this.nextAttempt) {
      this.setState(CircuitState.HALF_OPEN);
      return this.execute(arguments[0]);
    }

    // 執行降級處理
    if (this.fallback) {
      logger.info(`[CircuitBreaker ${this.name}] Executing fallback`);
      return this.fallback();
    }

    throw new Error(`Circuit breaker ${this.name} is OPEN`);
  }

  /**
   * 處理半開狀態
   */
  private async handleHalfOpenState<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await this.callWithTimeout(fn);
      this.onSuccess();

      // 如果成功，關閉斷路器
      this.setState(CircuitState.CLOSED);
      this.resetStats();

      return result;
    } catch (error) {
      this.onFailure(error);

      // 如果失敗，重新開啟斷路器
      this.setState(CircuitState.OPEN);
      this.nextAttempt = new Date(Date.now() + this.sleepWindow);

      throw error;
    }
  }

  /**
   * 帶超時的函數調用
   */
  private async callWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Request timeout after ${this.requestTimeout}ms`));
      }, this.requestTimeout);

      fn()
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * 記錄成功
   */
  private onSuccess() {
    this.requests++;
    this.successes++;
    this.recordInBucket(false);

    logger.debug(`[CircuitBreaker ${this.name}] Success`, {
      state: this.state,
      stats: this.getStats()
    });
  }

  /**
   * 記錄失敗
   */
  private onFailure(error: any) {
    this.requests++;
    this.failures++;
    this.lastFailureTime = new Date();
    this.recordInBucket(true);

    logger.warn(`[CircuitBreaker ${this.name}] Failure`, {
      state: this.state,
      error: error.message,
      stats: this.getStats()
    });

    // 檢查是否需要開啟斷路器
    if (this.shouldTrip()) {
      this.setState(CircuitState.OPEN);
      this.nextAttempt = new Date(Date.now() + this.sleepWindow);
    }
  }

  /**
   * 記錄到時間桶
   */
  private recordInBucket(isFailure: boolean) {
    const bucketKey = Math.floor(Date.now() / 1000);
    const bucket = this.buckets.get(bucketKey) || { requests: 0, failures: 0 };

    bucket.requests++;
    if (isFailure) {
      bucket.failures++;
    }

    this.buckets.set(bucketKey, bucket);

    // 清理舊桶
    const cutoff = bucketKey - 60;
    for (const [key] of this.buckets) {
      if (key < cutoff) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * 判斷是否應該觸發斷路
   */
  private shouldTrip(): boolean {
    if (this.requests < this.volumeThreshold) {
      return false;
    }

    const errorRate = (this.failures / this.requests) * 100;
    return errorRate >= this.errorThreshold;
  }

  /**
   * 設置狀態
   */
  private setState(newState: CircuitState) {
    const oldState = this.state;

    if (oldState !== newState) {
      this.state = newState;

      logger.info(`[CircuitBreaker ${this.name}] State changed`, {
        from: oldState,
        to: newState
      });

      // 更新健康指標
      updateHealthMetrics(`circuit_${this.name}`, newState === CircuitState.CLOSED);

      if (this.onStateChange) {
        this.onStateChange(oldState, newState);
      }
    }
  }

  /**
   * 重置統計
   */
  private resetStats() {
    const now = Date.now();
    const cutoff = now - this.resetTimeout;

    // 計算時間窗口內的統計
    let requests = 0;
    let failures = 0;

    for (const [key, bucket] of this.buckets) {
      if (key * 1000 >= cutoff) {
        requests += bucket.requests;
        failures += bucket.failures;
      }
    }

    this.requests = requests;
    this.failures = failures;
    this.successes = requests - failures;
  }

  /**
   * 獲取統計信息
   */
  getStats() {
    const errorRate = this.requests > 0 ? (this.failures / this.requests) * 100 : 0;

    return {
      name: this.name,
      state: this.state,
      requests: this.requests,
      failures: this.failures,
      successes: this.successes,
      errorRate: errorRate.toFixed(2) + '%',
      lastFailure: this.lastFailureTime?.toISOString(),
      nextAttempt: this.nextAttempt?.toISOString()
    };
  }

  /**
   * 手動重置斷路器
   */
  reset() {
    this.setState(CircuitState.CLOSED);
    this.requests = 0;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = undefined;
    this.nextAttempt = undefined;
    this.buckets.clear();

    logger.info(`[CircuitBreaker ${this.name}] Manually reset`);
  }

  /**
   * 手動開啟斷路器
   */
  open() {
    this.setState(CircuitState.OPEN);
    this.nextAttempt = new Date(Date.now() + this.sleepWindow);
  }

  /**
   * 手動進入半開狀態
   */
  halfOpen() {
    this.setState(CircuitState.HALF_OPEN);
  }
}

// ============================================
// 預設斷路器實例
// ============================================

/**
 * 資料庫斷路器
 */
export const dbCircuitBreaker = new CircuitBreaker({
  name: 'database',
  errorThreshold: 50,
  volumeThreshold: 10,
  sleepWindow: 30000,
  requestTimeout: 5000,
  fallback: () => {
    throw new Error('Database service temporarily unavailable');
  },
  onStateChange: (oldState, newState) => {
    if (newState === CircuitState.OPEN) {
      logger.error('Database circuit breaker opened - service degraded');
    } else if (newState === CircuitState.CLOSED) {
      logger.info('Database circuit breaker closed - service recovered');
    }
  }
});

/**
 * Redis 斷路器
 */
export const redisCircuitBreaker = new CircuitBreaker({
  name: 'redis',
  errorThreshold: 60,
  volumeThreshold: 5,
  sleepWindow: 20000,
  requestTimeout: 2000,
  fallback: () => {
    // Redis 失敗時返回 null（跳過快取）
    return null;
  }
});

/**
 * 外部 API 斷路器
 */
export const apiCircuitBreaker = new CircuitBreaker({
  name: 'external_api',
  errorThreshold: 70,
  volumeThreshold: 10,
  sleepWindow: 60000,
  requestTimeout: 10000,
  fallback: () => {
    return { error: 'External service unavailable', cached: true };
  }
});

/**
 * 派單服務斷路器
 */
export const dispatchCircuitBreaker = new CircuitBreaker({
  name: 'dispatch',
  errorThreshold: 40,
  volumeThreshold: 5,
  sleepWindow: 15000,
  requestTimeout: 3000,
  fallback: () => {
    // 降級到簡單的就近派單
    return { fallback: true, driver: 'nearest' };
  }
});

// ============================================
// 斷路器管理
// ============================================

const circuitBreakers = new Map<string, CircuitBreaker>([
  ['database', dbCircuitBreaker],
  ['redis', redisCircuitBreaker],
  ['external_api', apiCircuitBreaker],
  ['dispatch', dispatchCircuitBreaker]
]);

/**
 * 獲取斷路器
 */
export function getCircuitBreaker(name: string): CircuitBreaker | undefined {
  return circuitBreakers.get(name);
}

/**
 * 創建新的斷路器
 */
export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  const breaker = new CircuitBreaker(options);
  circuitBreakers.set(options.name, breaker);
  return breaker;
}

/**
 * 獲取所有斷路器狀態
 */
export function getAllCircuitBreakerStats() {
  const stats: any = {};

  for (const [name, breaker] of circuitBreakers) {
    stats[name] = breaker.getStats();
  }

  return stats;
}

/**
 * 重置所有斷路器
 */
export function resetAllCircuitBreakers() {
  for (const breaker of circuitBreakers.values()) {
    breaker.reset();
  }
}

// ============================================
// 裝飾器模式（用於類方法）
// ============================================

/**
 * 斷路器裝飾器
 */
export function WithCircuitBreaker(options: CircuitBreakerOptions) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const breaker = createCircuitBreaker({
      ...options,
      name: `${target.constructor.name}.${propertyKey}`
    });

    descriptor.value = async function (...args: any[]) {
      return breaker.execute(() => originalMethod.apply(this, args));
    };

    return descriptor;
  };
}

export default {
  CircuitBreaker,
  CircuitState,
  dbCircuitBreaker,
  redisCircuitBreaker,
  apiCircuitBreaker,
  dispatchCircuitBreaker,
  getCircuitBreaker,
  createCircuitBreaker,
  getAllCircuitBreakerStats,
  resetAllCircuitBreakers,
  WithCircuitBreaker
};
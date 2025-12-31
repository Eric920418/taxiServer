/**
 * Prometheus 監控指標
 * 收集和暴露系統效能指標
 */

import { register, collectDefaultMetrics, Counter, Histogram, Gauge, Summary } from 'prom-client';
import { Request, Response } from 'express';

// 收集預設指標（CPU、記憶體等）
collectDefaultMetrics({
  prefix: 'taxi_server_',
  register,
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5]
});

// ============================================
// 自定義指標
// ============================================

/**
 * HTTP 請求計數器
 */
export const httpRequestCounter = new Counter({
  name: 'taxi_server_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status']
});

/**
 * HTTP 請求持續時間
 */
export const httpRequestDuration = new Histogram({
  name: 'taxi_server_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});

/**
 * WebSocket 連線計數
 */
export const websocketConnections = new Gauge({
  name: 'taxi_server_websocket_connections',
  help: 'Number of active WebSocket connections',
  labelNames: ['type'] // driver, passenger
});

/**
 * 訂單指標
 */
export const orderMetrics = {
  created: new Counter({
    name: 'taxi_server_orders_created_total',
    help: 'Total number of orders created'
  }),
  completed: new Counter({
    name: 'taxi_server_orders_completed_total',
    help: 'Total number of orders completed'
  }),
  cancelled: new Counter({
    name: 'taxi_server_orders_cancelled_total',
    help: 'Total number of orders cancelled'
  }),
  revenue: new Counter({
    name: 'taxi_server_revenue_total',
    help: 'Total revenue in cents'
  }),
  duration: new Histogram({
    name: 'taxi_server_order_duration_minutes',
    help: 'Order completion time in minutes',
    buckets: [5, 10, 15, 20, 30, 45, 60, 90, 120]
  }),
  distance: new Histogram({
    name: 'taxi_server_order_distance_km',
    help: 'Order distance in kilometers',
    buckets: [1, 2, 5, 10, 15, 20, 30, 50]
  })
};

/**
 * 司機指標
 */
export const driverMetrics = {
  online: new Gauge({
    name: 'taxi_server_drivers_online',
    help: 'Number of online drivers'
  }),
  available: new Gauge({
    name: 'taxi_server_drivers_available',
    help: 'Number of available drivers'
  }),
  onTrip: new Gauge({
    name: 'taxi_server_drivers_on_trip',
    help: 'Number of drivers on trip'
  }),
  locationUpdates: new Counter({
    name: 'taxi_server_driver_location_updates_total',
    help: 'Total number of driver location updates'
  })
};

/**
 * 資料庫指標
 */
export const databaseMetrics = {
  queryDuration: new Histogram({
    name: 'taxi_server_database_query_duration_seconds',
    help: 'Database query duration in seconds',
    labelNames: ['operation', 'table'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2]
  }),
  connectionPool: new Gauge({
    name: 'taxi_server_database_connections',
    help: 'Number of database connections',
    labelNames: ['state'] // idle, active, waiting
  }),
  errors: new Counter({
    name: 'taxi_server_database_errors_total',
    help: 'Total number of database errors',
    labelNames: ['operation']
  })
};

/**
 * 快取指標
 */
export const cacheMetrics = {
  hits: new Counter({
    name: 'taxi_server_cache_hits_total',
    help: 'Total number of cache hits',
    labelNames: ['cache_type']
  }),
  misses: new Counter({
    name: 'taxi_server_cache_misses_total',
    help: 'Total number of cache misses',
    labelNames: ['cache_type']
  }),
  sets: new Counter({
    name: 'taxi_server_cache_sets_total',
    help: 'Total number of cache sets',
    labelNames: ['cache_type']
  }),
  deletes: new Counter({
    name: 'taxi_server_cache_deletes_total',
    help: 'Total number of cache deletes',
    labelNames: ['cache_type']
  }),
  memoryUsage: new Gauge({
    name: 'taxi_server_cache_memory_bytes',
    help: 'Cache memory usage in bytes'
  })
};

/**
 * 佇列指標
 */
export const queueMetrics = {
  jobsProcessed: new Counter({
    name: 'taxi_server_queue_jobs_processed_total',
    help: 'Total number of queue jobs processed',
    labelNames: ['queue', 'status'] // success, failed
  }),
  jobDuration: new Histogram({
    name: 'taxi_server_queue_job_duration_seconds',
    help: 'Queue job processing duration',
    labelNames: ['queue', 'job_type'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
  }),
  queueSize: new Gauge({
    name: 'taxi_server_queue_size',
    help: 'Number of jobs in queue',
    labelNames: ['queue', 'status'] // waiting, active, delayed, failed
  })
};

/**
 * API Rate Limiting 指標
 */
export const rateLimitMetrics = {
  blocked: new Counter({
    name: 'taxi_server_rate_limit_blocked_total',
    help: 'Total number of requests blocked by rate limiting',
    labelNames: ['endpoint']
  }),
  remaining: new Gauge({
    name: 'taxi_server_rate_limit_remaining',
    help: 'Remaining requests in rate limit window',
    labelNames: ['ip', 'endpoint']
  })
};

/**
 * 系統健康指標
 */
export const healthMetrics = {
  status: new Gauge({
    name: 'taxi_server_health_status',
    help: 'System health status (1 = healthy, 0 = unhealthy)',
    labelNames: ['component']
  }),
  lastCheck: new Gauge({
    name: 'taxi_server_health_last_check_timestamp',
    help: 'Timestamp of last health check',
    labelNames: ['component']
  })
};

/**
 * 派單效率指標
 */
export const dispatchMetrics = {
  attempts: new Counter({
    name: 'taxi_server_dispatch_attempts_total',
    help: 'Total number of dispatch attempts'
  }),
  success: new Counter({
    name: 'taxi_server_dispatch_success_total',
    help: 'Total number of successful dispatches'
  }),
  failed: new Counter({
    name: 'taxi_server_dispatch_failed_total',
    help: 'Total number of failed dispatches',
    labelNames: ['reason']
  }),
  responseTime: new Histogram({
    name: 'taxi_server_dispatch_response_time_seconds',
    help: 'Time to assign driver to order',
    buckets: [1, 5, 10, 30, 60, 120, 300]
  }),
  accuracy: new Gauge({
    name: 'taxi_server_dispatch_accuracy_rate',
    help: 'Dispatch accuracy rate (successful assignments)'
  })
};

// ============================================
// 中間件
// ============================================

/**
 * HTTP 指標收集中間件
 */
export const metricsMiddleware = (req: Request, res: Response, next: Function) => {
  const start = Date.now();

  // 攔截回應
  const originalSend = res.send;
  res.send = function(data: any) {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path || 'unknown';
    const method = req.method;
    const status = res.statusCode.toString();

    // 記錄指標
    httpRequestCounter.inc({ method, route, status });
    httpRequestDuration.observe({ method, route, status }, duration);

    return originalSend.call(this, data);
  };

  next();
};

// ============================================
// 指標更新函數
// ============================================

/**
 * 更新 WebSocket 連線指標
 */
export function updateWebSocketMetrics(driverCount: number, passengerCount: number) {
  websocketConnections.set({ type: 'driver' }, driverCount);
  websocketConnections.set({ type: 'passenger' }, passengerCount);
}

/**
 * 更新司機狀態指標
 */
export function updateDriverMetrics(online: number, available: number, onTrip: number) {
  driverMetrics.online.set(online);
  driverMetrics.available.set(available);
  driverMetrics.onTrip.set(onTrip);
}

/**
 * 記錄訂單指標
 */
export function recordOrderMetrics(order: any) {
  if (order.status === 'CREATED') {
    orderMetrics.created.inc();
  } else if (order.status === 'COMPLETED') {
    orderMetrics.completed.inc();

    if (order.total_amount) {
      orderMetrics.revenue.inc(order.total_amount * 100); // 轉換為分
    }

    if (order.actual_duration_min) {
      orderMetrics.duration.observe(order.actual_duration_min);
    }

    if (order.actual_distance_km) {
      orderMetrics.distance.observe(order.actual_distance_km);
    }
  } else if (order.status === 'CANCELLED') {
    orderMetrics.cancelled.inc();
  }
}

/**
 * 記錄資料庫指標
 */
export function recordDatabaseMetrics(operation: string, table: string, duration: number, error?: boolean) {
  databaseMetrics.queryDuration.observe({ operation, table }, duration / 1000);

  if (error) {
    databaseMetrics.errors.inc({ operation });
  }
}

/**
 * 更新連線池指標
 */
export function updateConnectionPoolMetrics(idle: number, active: number, waiting: number) {
  databaseMetrics.connectionPool.set({ state: 'idle' }, idle);
  databaseMetrics.connectionPool.set({ state: 'active' }, active);
  databaseMetrics.connectionPool.set({ state: 'waiting' }, waiting);
}

/**
 * 記錄快取指標
 */
export function recordCacheMetrics(operation: 'hit' | 'miss' | 'set' | 'delete', cacheType: string) {
  switch (operation) {
    case 'hit':
      cacheMetrics.hits.inc({ cache_type: cacheType });
      break;
    case 'miss':
      cacheMetrics.misses.inc({ cache_type: cacheType });
      break;
    case 'set':
      cacheMetrics.sets.inc({ cache_type: cacheType });
      break;
    case 'delete':
      cacheMetrics.deletes.inc({ cache_type: cacheType });
      break;
  }
}

/**
 * 記錄佇列指標
 */
export function recordQueueMetrics(queue: string, jobType: string, duration: number, success: boolean) {
  const status = success ? 'success' : 'failed';
  queueMetrics.jobsProcessed.inc({ queue, status });
  queueMetrics.jobDuration.observe({ queue, job_type: jobType }, duration / 1000);
}

/**
 * 更新佇列大小指標
 */
export function updateQueueSizeMetrics(queue: string, waiting: number, active: number, delayed: number, failed: number) {
  queueMetrics.queueSize.set({ queue, status: 'waiting' }, waiting);
  queueMetrics.queueSize.set({ queue, status: 'active' }, active);
  queueMetrics.queueSize.set({ queue, status: 'delayed' }, delayed);
  queueMetrics.queueSize.set({ queue, status: 'failed' }, failed);
}

/**
 * 記錄 Rate Limiting 指標
 */
export function recordRateLimitMetrics(endpoint: string, blocked: boolean, remaining?: number, ip?: string) {
  if (blocked) {
    rateLimitMetrics.blocked.inc({ endpoint });
  }

  if (remaining !== undefined && ip) {
    rateLimitMetrics.remaining.set({ ip, endpoint }, remaining);
  }
}

/**
 * 更新系統健康指標
 */
export function updateHealthMetrics(component: string, healthy: boolean) {
  healthMetrics.status.set({ component }, healthy ? 1 : 0);
  healthMetrics.lastCheck.set({ component }, Date.now() / 1000);
}

/**
 * 記錄派單指標
 */
export async function recordDispatchMetrics(success: boolean, responseTime?: number, reason?: string) {
  dispatchMetrics.attempts.inc();

  if (success) {
    dispatchMetrics.success.inc();
    if (responseTime) {
      dispatchMetrics.responseTime.observe(responseTime);
    }
  } else {
    dispatchMetrics.failed.inc({ reason: reason || 'unknown' });
  }

  // 更新準確率
  const attemptsMetric = await dispatchMetrics.attempts.get();
  const successMetric = await dispatchMetrics.success.get();
  const total = attemptsMetric.values[0]?.value || 1;
  const successful = successMetric.values[0]?.value || 0;
  dispatchMetrics.accuracy.set(successful / total);
}

// ============================================
// 指標端點
// ============================================

/**
 * Prometheus 指標端點處理器
 */
export async function metricsHandler(req: Request, res: Response) {
  try {
    res.set('Content-Type', register.contentType);
    const metrics = await register.metrics();
    res.end(metrics);
  } catch (error) {
    res.status(500).end();
  }
}

/**
 * 重置所有指標
 */
export function resetMetrics() {
  register.clear();
}

export default {
  metricsMiddleware,
  metricsHandler,
  updateWebSocketMetrics,
  updateDriverMetrics,
  recordOrderMetrics,
  recordDatabaseMetrics,
  updateConnectionPoolMetrics,
  recordCacheMetrics,
  recordQueueMetrics,
  updateQueueSizeMetrics,
  recordRateLimitMetrics,
  updateHealthMetrics,
  recordDispatchMetrics,
  resetMetrics
};
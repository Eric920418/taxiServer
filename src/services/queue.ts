/**
 * 訊息佇列服務
 * 使用 Bull 處理非同步任務
 */

import Bull from 'bull';
import dotenv from 'dotenv';
import logger, { performanceLogger } from './logger';
import { query } from '../db/connection';
import * as cache from './cache';

dotenv.config();

// Redis 連線設定
const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379')
};

// ============================================
// 佇列定義
// ============================================

/**
 * 訂單處理佇列
 */
export const orderQueue = new Bull('order-processing', {
  redis: REDIS_CONFIG,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    }
  }
});

/**
 * 通知佇列
 */
export const notificationQueue = new Bull('notifications', {
  redis: REDIS_CONFIG,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 5,
    backoff: {
      type: 'fixed',
      delay: 5000
    }
  }
});

/**
 * 統計計算佇列
 */
export const analyticsQueue = new Bull('analytics', {
  redis: REDIS_CONFIG,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 1
  }
});

/**
 * 批次更新佇列
 */
export const batchUpdateQueue = new Bull('batch-updates', {
  redis: REDIS_CONFIG,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 2
  }
});

/**
 * 位置追蹤佇列
 */
export const locationTrackingQueue = new Bull('location-tracking', {
  redis: REDIS_CONFIG,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 1
  }
});

// ============================================
// 工作處理器
// ============================================

/**
 * 訂單處理工作
 */
orderQueue.process('process-order', async (job) => {
  const { orderId, action } = job.data;
  const timer = performanceLogger.startTimer(`order-${action}`);

  try {
    switch (action) {
      case 'dispatch':
        // 智能派單
        await processOrderDispatch(orderId);
        break;

      case 'timeout':
        // 處理超時訂單
        await processOrderTimeout(orderId);
        break;

      case 'complete':
        // 完成訂單
        await processOrderCompletion(orderId);
        break;

      case 'cancel':
        // 取消訂單
        await processOrderCancellation(orderId);
        break;
    }

    timer.end({ status: 'success' });
    return { success: true, orderId, action };
  } catch (error) {
    timer.end({ status: 'error' });
    logger.error(`Order processing failed: ${action}`, { orderId, error });
    throw error;
  }
});

/**
 * 通知處理工作
 */
notificationQueue.process('send-notification', async (job) => {
  const { type, recipient, message, data } = job.data;

  try {
    switch (type) {
      case 'sms':
        await sendSMSNotification(recipient, message);
        break;

      case 'push':
        await sendPushNotification(recipient, message, data);
        break;

      case 'email':
        await sendEmailNotification(recipient, message, data);
        break;

      case 'socket':
        await sendSocketNotification(recipient, message, data);
        break;
    }

    logger.info('Notification sent', { type, recipient });
    return { success: true, type, recipient };
  } catch (error) {
    logger.error('Notification failed', { type, recipient, error });
    throw error;
  }
});

/**
 * 統計計算工作
 */
analyticsQueue.process('calculate-stats', async (job) => {
  const { type, period, driverId } = job.data;
  const timer = performanceLogger.startTimer(`analytics-${type}`);

  try {
    let result;

    switch (type) {
      case 'driver-daily':
        result = await calculateDriverDailyStats(driverId);
        break;

      case 'system-hourly':
        result = await calculateSystemHourlyStats();
        break;

      case 'hotzone-analysis':
        result = await analyzeHotZones();
        break;

      case 'revenue-report':
        result = await generateRevenueReport(period);
        break;
    }

    // 儲存到快取
    if (result) {
      await cache.cacheApiResponse(`stats:${type}:${period || 'latest'}`, result, 3600);
    }

    timer.end({ status: 'success' });
    return result;
  } catch (error) {
    timer.end({ status: 'error' });
    logger.error(`Analytics calculation failed: ${type}`, error);
    throw error;
  }
});

/**
 * 批次更新工作
 */
batchUpdateQueue.process('batch-update', async (job) => {
  const { table, updates } = job.data;
  const timer = performanceLogger.startTimer(`batch-update-${table}`);

  try {
    // 建構批次更新 SQL
    const results = await processBatchUpdate(table, updates);

    timer.end({ status: 'success', count: results });
    return { success: true, updated: results };
  } catch (error) {
    timer.end({ status: 'error' });
    logger.error(`Batch update failed: ${table}`, error);
    throw error;
  }
});

/**
 * 位置追蹤工作
 */
locationTrackingQueue.process('track-location', async (job) => {
  const { driverId, locations } = job.data;

  try {
    // 儲存位置歷史
    await saveLocationHistory(driverId, locations);

    // 更新快取
    const latestLocation = locations[locations.length - 1];
    await cache.cacheDriverLocation(driverId, latestLocation);

    return { success: true, driverId, count: locations.length };
  } catch (error) {
    logger.error('Location tracking failed', { driverId, error });
    throw error;
  }
});

// ============================================
// 輔助函數
// ============================================

async function processOrderDispatch(orderId: string) {
  // 實作智能派單邏輯
  const result = await query(
    'UPDATE orders SET status = $1 WHERE order_id = $2',
    ['DISPATCHING', orderId]
  );
  return result;
}

async function processOrderTimeout(orderId: string) {
  // 處理超時訂單
  const result = await query(
    'UPDATE orders SET status = $1 WHERE order_id = $2 AND status = $3',
    ['TIMEOUT', orderId, 'OFFERED']
  );
  return result;
}

async function processOrderCompletion(orderId: string) {
  // 完成訂單並計算費用
  const result = await query(
    `UPDATE orders
     SET status = 'COMPLETED',
         completed_at = CURRENT_TIMESTAMP
     WHERE order_id = $1`,
    [orderId]
  );
  return result;
}

async function processOrderCancellation(orderId: string) {
  // 取消訂單
  const result = await query(
    `UPDATE orders
     SET status = 'CANCELLED',
         cancelled_at = CURRENT_TIMESTAMP
     WHERE order_id = $1`,
    [orderId]
  );
  return result;
}

async function sendSMSNotification(recipient: string, message: string) {
  // 實作 SMS 發送邏輯
  logger.info('SMS notification', { recipient, message });
  // 這裡可以整合 Twilio 或其他 SMS 服務
}

async function sendPushNotification(recipient: string, message: string, data: any) {
  // 實作推送通知邏輯
  logger.info('Push notification', { recipient, message, data });
  // 這裡可以整合 Firebase Cloud Messaging
}

async function sendEmailNotification(recipient: string, message: string, data: any) {
  // 實作郵件發送邏輯
  logger.info('Email notification', { recipient, message });
  // 這裡可以整合 SendGrid 或其他郵件服務
}

async function sendSocketNotification(recipient: string, message: string, data: any) {
  // 透過 Socket.io 發送即時通知
  const io = require('../socket').getIO();
  io.to(recipient).emit('notification', { message, data });
}

async function calculateDriverDailyStats(driverId: string) {
  const result = await query(
    `SELECT
      COUNT(*) as total_trips,
      SUM(total_amount) as total_revenue,
      AVG(rating) as avg_rating,
      SUM(actual_distance_km) as total_distance
     FROM orders
     WHERE driver_id = $1
       AND DATE(completed_at) = CURRENT_DATE
       AND status = 'COMPLETED'`,
    [driverId]
  );
  return result.rows[0];
}

async function calculateSystemHourlyStats() {
  const result = await query(
    `SELECT
      EXTRACT(HOUR FROM created_at) as hour,
      COUNT(*) as order_count,
      AVG(total_amount) as avg_amount,
      COUNT(DISTINCT driver_id) as active_drivers
     FROM orders
     WHERE created_at > NOW() - INTERVAL '24 hours'
     GROUP BY EXTRACT(HOUR FROM created_at)
     ORDER BY hour`
  );
  return result.rows;
}

async function analyzeHotZones() {
  const result = await query(
    `SELECT
      ROUND(pickup_lat::numeric, 2) as lat,
      ROUND(pickup_lng::numeric, 2) as lng,
      COUNT(*) as order_count,
      AVG(total_amount) as avg_revenue
     FROM orders
     WHERE status = 'COMPLETED'
       AND completed_at > NOW() - INTERVAL '7 days'
     GROUP BY ROUND(pickup_lat::numeric, 2), ROUND(pickup_lng::numeric, 2)
     HAVING COUNT(*) > 5
     ORDER BY order_count DESC
     LIMIT 20`
  );
  return result.rows;
}

async function generateRevenueReport(period: string) {
  const interval = period === 'daily' ? '1 day' :
                   period === 'weekly' ? '7 days' : '30 days';

  const result = await query(
    `SELECT
      DATE(completed_at) as date,
      COUNT(*) as total_orders,
      SUM(total_amount) as total_revenue,
      AVG(total_amount) as avg_order_value,
      COUNT(DISTINCT driver_id) as active_drivers
     FROM orders
     WHERE status = 'COMPLETED'
       AND completed_at > NOW() - INTERVAL '${interval}'
     GROUP BY DATE(completed_at)
     ORDER BY date DESC`
  );
  return result.rows;
}

async function processBatchUpdate(table: string, updates: any[]) {
  // 實作批次更新邏輯
  let updatedCount = 0;

  for (const update of updates) {
    const { id, data } = update;
    const fields = Object.keys(data);
    const values = Object.values(data);

    const setClause = fields.map((field, i) => `${field} = $${i + 2}`).join(', ');
    const sql = `UPDATE ${table} SET ${setClause} WHERE id = $1`;

    const result = await query(sql, [id, ...values]);
    updatedCount += result.rowCount || 0;
  }

  return updatedCount;
}

async function saveLocationHistory(driverId: string, locations: any[]) {
  // 儲存位置歷史到資料庫
  const values = locations.map(loc =>
    `('${driverId}', ${loc.lat}, ${loc.lng}, ${loc.speed || 0}, ${loc.bearing || 0}, to_timestamp(${loc.timestamp / 1000}))`
  ).join(',');

  const sql = `
    INSERT INTO location_history (driver_id, lat, lng, speed, bearing, recorded_at)
    VALUES ${values}
  `;

  await query(sql);
}

// ============================================
// 佇列事件處理
// ============================================

orderQueue.on('completed', (job, result) => {
  logger.info('Order job completed', { jobId: job.id, result });
});

orderQueue.on('failed', (job, err) => {
  logger.error('Order job failed', { jobId: job.id, error: err.message });
});

notificationQueue.on('completed', (job, result) => {
  logger.debug('Notification sent', { jobId: job.id, result });
});

analyticsQueue.on('completed', (job, result) => {
  logger.info('Analytics calculated', { jobId: job.id, type: job.data.type });
});

// ============================================
// 排程任務
// ============================================

/**
 * 設定定期任務
 */
export function setupScheduledJobs() {
  // 每小時計算系統統計
  analyticsQueue.add(
    'calculate-stats',
    { type: 'system-hourly' },
    { repeat: { cron: '0 * * * *' } }
  );

  // 每日凌晨 2 點分析熱區
  analyticsQueue.add(
    'calculate-stats',
    { type: 'hotzone-analysis' },
    { repeat: { cron: '0 2 * * *' } }
  );

  // 每日凌晨 3 點生成營收報告
  analyticsQueue.add(
    'calculate-stats',
    { type: 'revenue-report', period: 'daily' },
    { repeat: { cron: '0 3 * * *' } }
  );

  logger.info('Scheduled jobs configured');
}

// ============================================
// 佇列管理
// ============================================

/**
 * 取得佇列狀態
 */
export async function getQueueStats() {
  const stats = await Promise.all([
    orderQueue.getJobCounts(),
    notificationQueue.getJobCounts(),
    analyticsQueue.getJobCounts(),
    batchUpdateQueue.getJobCounts(),
    locationTrackingQueue.getJobCounts()
  ]);

  return {
    orderQueue: stats[0],
    notificationQueue: stats[1],
    analyticsQueue: stats[2],
    batchUpdateQueue: stats[3],
    locationTrackingQueue: stats[4]
  };
}

/**
 * 清理佇列
 */
export async function cleanQueues() {
  await Promise.all([
    orderQueue.clean(3600000, 'completed'),
    orderQueue.clean(3600000, 'failed'),
    notificationQueue.clean(3600000, 'completed'),
    analyticsQueue.clean(86400000, 'completed'),
    batchUpdateQueue.clean(3600000, 'completed'),
    locationTrackingQueue.clean(3600000, 'completed')
  ]);

  logger.info('Queues cleaned');
}

/**
 * 優雅關閉佇列
 */
export async function closeQueues() {
  await Promise.all([
    orderQueue.close(),
    notificationQueue.close(),
    analyticsQueue.close(),
    batchUpdateQueue.close(),
    locationTrackingQueue.close()
  ]);

  logger.info('All queues closed');
}

export default {
  orderQueue,
  notificationQueue,
  analyticsQueue,
  batchUpdateQueue,
  locationTrackingQueue,
  setupScheduledJobs,
  getQueueStats,
  cleanQueues,
  closeQueues
};
/**
 * 批次更新服務
 * 用於優化資料庫寫入操作，減少查詢次數
 */

import { query } from '../db/connection';
import * as cache from './cache';

// 更新佇列
const locationUpdateQueue = new Map<string, any>();
const statusUpdateQueue = new Map<string, string>();
const heartbeatUpdateQueue = new Set<string>();

// 批次更新設定
const BATCH_INTERVAL = 5000; // 5秒批次更新一次
const MAX_BATCH_SIZE = 100; // 最大批次大小

/**
 * 加入位置更新佇列
 */
export function queueLocationUpdate(driverId: string, location: {
  lat: number;
  lng: number;
  speed?: number;
  bearing?: number;
}) {
  locationUpdateQueue.set(driverId, {
    ...location,
    timestamp: Date.now()
  });

  // 同時更新快取
  cache.cacheDriverLocation(driverId, location);
}

/**
 * 加入狀態更新佇列
 */
export function queueStatusUpdate(driverId: string, status: string) {
  statusUpdateQueue.set(driverId, status);
  heartbeatUpdateQueue.add(driverId);

  // 同時更新快取
  cache.cacheDriverStatus(driverId, status);
}

/**
 * 加入心跳更新佇列
 */
export function queueHeartbeatUpdate(driverId: string) {
  heartbeatUpdateQueue.add(driverId);
}

/**
 * 批次處理位置更新
 */
async function processBatchLocationUpdates() {
  if (locationUpdateQueue.size === 0) return;

  const updates = Array.from(locationUpdateQueue.entries());
  locationUpdateQueue.clear();

  // 限制批次大小
  const batches = [];
  for (let i = 0; i < updates.length; i += MAX_BATCH_SIZE) {
    batches.push(updates.slice(i, i + MAX_BATCH_SIZE));
  }

  for (const batch of batches) {
    try {
      // 建構批次更新 SQL
      const values = batch.map(([ driverId, location ]) => ({
        driverId,
        lat: location.lat,
        lng: location.lng
      }));

      if (values.length === 1) {
        // 單筆更新
        await query(`
          UPDATE drivers
          SET current_lat = $1,
              current_lng = $2,
              last_heartbeat = CURRENT_TIMESTAMP
          WHERE driver_id = $3
        `, [values[0].lat, values[0].lng, values[0].driverId]);
      } else {
        // 批次更新（使用 PostgreSQL 的 VALUES 語法）
        const valueStrings = values.map(
          (v, i) => `($${i * 3 + 1}::text, $${i * 3 + 2}::numeric, $${i * 3 + 3}::numeric)`
        ).join(',');

        const params = values.flatMap(v => [v.driverId, v.lat, v.lng]);

        await query(`
          UPDATE drivers AS d SET
            current_lat = v.lat,
            current_lng = v.lng,
            last_heartbeat = CURRENT_TIMESTAMP
          FROM (VALUES ${valueStrings}) AS v(driver_id, lat, lng)
          WHERE d.driver_id = v.driver_id
        `, params);
      }

      console.log(`[Batch] 批次更新 ${batch.length} 筆司機位置`);
    } catch (error) {
      console.error('[Batch] 批次位置更新失敗:', error);

      // 失敗時嘗試逐筆更新
      for (const [driverId, location] of batch) {
        try {
          await query(`
            UPDATE drivers
            SET current_lat = $1,
                current_lng = $2,
                last_heartbeat = CURRENT_TIMESTAMP
            WHERE driver_id = $3
          `, [location.lat, location.lng, driverId]);
        } catch (singleError) {
          console.error(`[Batch] 單筆位置更新失敗 ${driverId}:`, singleError);
        }
      }
    }
  }
}

/**
 * 批次處理狀態更新
 */
async function processBatchStatusUpdates() {
  if (statusUpdateQueue.size === 0) return;

  const updates = Array.from(statusUpdateQueue.entries());
  statusUpdateQueue.clear();

  // 按狀態分組
  const statusGroups = new Map<string, string[]>();
  updates.forEach(([driverId, status]) => {
    if (!statusGroups.has(status)) {
      statusGroups.set(status, []);
    }
    statusGroups.get(status)!.push(driverId);
  });

  // 批次更新每個狀態組
  for (const [status, driverIds] of statusGroups) {
    try {
      await query(`
        UPDATE drivers
        SET availability = $1,
            last_heartbeat = CURRENT_TIMESTAMP
        WHERE driver_id = ANY($2)
      `, [status, driverIds]);

      console.log(`[Batch] 批次更新 ${driverIds.length} 筆司機狀態為 ${status}`);
    } catch (error) {
      console.error(`[Batch] 批次狀態更新失敗 (${status}):`, error);
    }
  }
}

/**
 * 批次處理心跳更新
 */
async function processBatchHeartbeatUpdates() {
  if (heartbeatUpdateQueue.size === 0) return;

  const driverIds = Array.from(heartbeatUpdateQueue);
  heartbeatUpdateQueue.clear();

  // 限制批次大小
  for (let i = 0; i < driverIds.length; i += MAX_BATCH_SIZE) {
    const batch = driverIds.slice(i, i + MAX_BATCH_SIZE);

    try {
      await query(`
        UPDATE drivers
        SET last_heartbeat = CURRENT_TIMESTAMP
        WHERE driver_id = ANY($1)
      `, [batch]);

      console.log(`[Batch] 批次更新 ${batch.length} 筆心跳`);
    } catch (error) {
      console.error('[Batch] 批次心跳更新失敗:', error);
    }
  }
}

/**
 * 批次更新訂單統計
 */
export async function batchUpdateOrderStats(driverIds: string[]) {
  if (driverIds.length === 0) return;

  try {
    // 批次更新司機訂單統計
    await query(`
      UPDATE drivers d
      SET total_trips = subquery.trip_count,
          total_earnings = subquery.earnings_sum,
          acceptance_rate = CASE
            WHEN subquery.offered_count > 0
            THEN (subquery.accepted_count::float / subquery.offered_count::float) * 100
            ELSE 100
          END
      FROM (
        SELECT
          driver_id,
          COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as trip_count,
          COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN total_amount END), 0) as earnings_sum,
          COUNT(CASE WHEN status IN ('ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') THEN 1 END) as accepted_count,
          COUNT(*) as offered_count
        FROM orders
        WHERE driver_id = ANY($1)
        GROUP BY driver_id
      ) AS subquery
      WHERE d.driver_id = subquery.driver_id
    `, [driverIds]);

    // 更新快取
    const result = await query(`
      SELECT driver_id,
             SUM(total_amount) as today_earnings
      FROM orders
      WHERE driver_id = ANY($1)
        AND DATE(completed_at) = CURRENT_DATE
        AND status = 'COMPLETED'
      GROUP BY driver_id
    `, [driverIds]);

    for (const row of result.rows) {
      await cache.cacheDriverEarnings(row.driver_id, row.today_earnings || 0);
    }

    console.log(`[Batch] 更新 ${driverIds.length} 位司機統計`);
  } catch (error) {
    console.error('[Batch] 批次統計更新失敗:', error);
  }
}

/**
 * 執行所有批次更新
 */
async function processAllBatchUpdates() {
  const promises = [
    processBatchLocationUpdates(),
    processBatchStatusUpdates(),
    processBatchHeartbeatUpdates()
  ];

  await Promise.allSettled(promises);
}

/**
 * 啟動批次更新定時器
 */
let batchUpdateInterval: NodeJS.Timeout | null = null;

export function startBatchUpdater() {
  if (batchUpdateInterval) {
    console.log('[Batch] 批次更新已在執行中');
    return;
  }

  batchUpdateInterval = setInterval(processAllBatchUpdates, BATCH_INTERVAL);
  console.log('[Batch] 批次更新服務已啟動');
}

/**
 * 停止批次更新定時器
 */
export async function stopBatchUpdater() {
  if (batchUpdateInterval) {
    clearInterval(batchUpdateInterval);
    batchUpdateInterval = null;

    // 處理剩餘的更新
    await processAllBatchUpdates();

    console.log('[Batch] 批次更新服務已停止');
  }
}

/**
 * 立即執行批次更新（用於關閉前）
 */
export async function flushBatchUpdates() {
  await processAllBatchUpdates();
  console.log('[Batch] 已執行所有待處理的批次更新');
}

// 優雅關閉處理
process.on('SIGINT', async () => {
  console.log('[Batch] 收到關閉信號，正在處理剩餘更新...');
  await stopBatchUpdater();
});

process.on('SIGTERM', async () => {
  console.log('[Batch] 收到終止信號，正在處理剩餘更新...');
  await stopBatchUpdater();
});

export default {
  queueLocationUpdate,
  queueStatusUpdate,
  queueHeartbeatUpdate,
  batchUpdateOrderStats,
  startBatchUpdater,
  stopBatchUpdater,
  flushBatchUpdates
};
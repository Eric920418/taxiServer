/**
 * 進階資料庫連線管理
 * 支援讀寫分離、連線池優化、自動故障轉移
 */

import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
import logger from '../services/logger';
import { recordDatabaseMetrics, updateConnectionPoolMetrics } from '../services/metrics';

dotenv.config();

// ============================================
// 連線池配置
// ============================================

interface PoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max: number;
  min: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
  query_timeout: number;
}

const baseConfig: Partial<PoolConfig> = {
  database: process.env.DB_NAME || 'hualien_taxi',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: parseInt(process.env.DB_POOL_MAX || '50'),
  min: parseInt(process.env.DB_POOL_MIN || '10'),
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
  query_timeout: 30000,
};

// 主庫（寫入）連線池
const masterPool = new Pool({
  ...baseConfig,
  host: process.env.DB_MASTER_HOST || process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_MASTER_PORT || process.env.DB_PORT || '5432'),
  application_name: 'taxi_server_master'
});

// 從庫（讀取）連線池陣列
const readReplicas: Pool[] = [];

// 初始化讀取副本
const replicaHosts = process.env.DB_REPLICA_HOSTS?.split(',') || [];
const replicaPorts = process.env.DB_REPLICA_PORTS?.split(',') || [];

replicaHosts.forEach((host, index) => {
  const port = parseInt(replicaPorts[index] || '5432');
  const replicaPool = new Pool({
    ...baseConfig,
    host,
    port,
    application_name: `taxi_server_replica_${index + 1}`
  });

  readReplicas.push(replicaPool);
  logger.info(`Read replica ${index + 1} configured: ${host}:${port}`);
});

// 如果沒有配置從庫，使用主庫進行讀取
if (readReplicas.length === 0) {
  readReplicas.push(masterPool);
  logger.info('No read replicas configured, using master for reads');
}

// ============================================
// 連線池管理
// ============================================

let currentReplicaIndex = 0;

/**
 * 取得讀取連線池（輪詢負載均衡）
 */
function getReadPool(): Pool {
  const pool = readReplicas[currentReplicaIndex];
  currentReplicaIndex = (currentReplicaIndex + 1) % readReplicas.length;
  return pool;
}

/**
 * 取得寫入連線池
 */
function getWritePool(): Pool {
  return masterPool;
}

// ============================================
// 查詢執行器
// ============================================

export interface QueryOptions {
  useReplica?: boolean;
  timeout?: number;
  retryOnFailure?: boolean;
  maxRetries?: number;
  cache?: {
    key: string;
    ttl: number;
  };
}

/**
 * 智能查詢執行（自動判斷使用主庫或從庫）
 */
export async function query(
  text: string,
  params?: any[],
  options: QueryOptions = {}
): Promise<any> {
  const isReadQuery = isReadOnlyQuery(text);
  const pool = (options.useReplica !== false && isReadQuery)
    ? getReadPool()
    : getWritePool();

  const start = Date.now();
  let retries = 0;
  const maxRetries = options.maxRetries || 3;

  while (retries < maxRetries) {
    try {
      // 檢查快取
      if (options.cache && isReadQuery) {
        const { getCachedApiResponse, cacheApiResponse } = await import('../services/cache');
        const cached = await getCachedApiResponse(options.cache.key);
        if (cached) {
          recordDatabaseMetrics('cache_hit', extractTableName(text), 0);
          return { rows: cached, rowCount: cached.length };
        }
      }

      // 執行查詢
      const result = await executeQuery(pool, text, params, options.timeout);

      const duration = Date.now() - start;
      const table = extractTableName(text);
      const operation = extractOperation(text);

      recordDatabaseMetrics(operation, table, duration);
      logger.debug(`[DB ${isReadQuery ? 'Read' : 'Write'}]`, {
        duration: `${duration}ms`,
        rows: result.rowCount,
        pool: pool === masterPool ? 'master' : 'replica'
      });

      // 儲存到快取
      if (options.cache && isReadQuery && result.rows.length > 0) {
        const { cacheApiResponse } = await import('../services/cache');
        await cacheApiResponse(options.cache.key, result.rows, options.cache.ttl);
      }

      return result;
    } catch (error: any) {
      retries++;

      if (retries >= maxRetries || !options.retryOnFailure) {
        const duration = Date.now() - start;
        recordDatabaseMetrics('error', extractTableName(text), duration, true);
        logger.error('[DB Error]', { text, error: error.message, retries });
        throw error;
      }

      // 如果從庫失敗，嘗試主庫
      if (pool !== masterPool && isReadQuery) {
        logger.warn('Read replica failed, falling back to master', { error: error.message });
        return query(text, params, { ...options, useReplica: false });
      }

      // 指數退避重試
      const delay = Math.min(1000 * Math.pow(2, retries), 5000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Max retries exceeded');
}

/**
 * 執行查詢（內部函數）
 */
async function executeQuery(
  pool: Pool,
  text: string,
  params?: any[],
  timeout?: number
): Promise<any> {
  let client: PoolClient | null = null;

  try {
    client = await pool.connect();

    if (timeout) {
      await client.query(`SET statement_timeout = ${timeout}`);
    }

    const result = await client.query(text, params);
    return result;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * 判斷是否為唯讀查詢
 */
function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  return trimmed.startsWith('SELECT') ||
         trimmed.startsWith('WITH') ||
         trimmed.startsWith('SHOW') ||
         trimmed.startsWith('DESCRIBE') ||
         trimmed.startsWith('EXPLAIN');
}

/**
 * 提取表名
 */
function extractTableName(sql: string): string {
  const match = sql.match(/(?:FROM|INTO|UPDATE|DELETE FROM)\s+(\w+)/i);
  return match ? match[1] : 'unknown';
}

/**
 * 提取操作類型
 */
function extractOperation(sql: string): string {
  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith('SELECT')) return 'select';
  if (trimmed.startsWith('INSERT')) return 'insert';
  if (trimmed.startsWith('UPDATE')) return 'update';
  if (trimmed.startsWith('DELETE')) return 'delete';
  return 'other';
}

// ============================================
// 交易處理
// ============================================

export interface Transaction {
  query: (text: string, params?: any[]) => Promise<any>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

/**
 * 開始交易
 */
export async function beginTransaction(): Promise<Transaction> {
  const client = await masterPool.connect();

  try {
    await client.query('BEGIN');

    return {
      query: async (text: string, params?: any[]) => {
        const start = Date.now();
        try {
          const result = await client.query(text, params);
          const duration = Date.now() - start;
          recordDatabaseMetrics('transaction', extractTableName(text), duration);
          return result;
        } catch (error) {
          const duration = Date.now() - start;
          recordDatabaseMetrics('transaction_error', extractTableName(text), duration, true);
          throw error;
        }
      },
      commit: async () => {
        await client.query('COMMIT');
        client.release();
        logger.debug('Transaction committed');
      },
      rollback: async () => {
        await client.query('ROLLBACK');
        client.release();
        logger.debug('Transaction rolled back');
      }
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

/**
 * 執行交易（自動管理）
 */
export async function withTransaction<T>(
  callback: (trx: Transaction) => Promise<T>
): Promise<T> {
  const trx = await beginTransaction();

  try {
    const result = await callback(trx);
    await trx.commit();
    return result;
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

// ============================================
// 批次操作
// ============================================

/**
 * 批次插入（優化版）
 */
export async function batchInsert(
  table: string,
  records: any[],
  options: { returning?: string[]; onConflict?: string } = {}
): Promise<any[]> {
  if (records.length === 0) return [];

  const fields = Object.keys(records[0]);
  const values: any[] = [];
  const placeholders: string[] = [];

  records.forEach((record, recordIndex) => {
    const recordPlaceholders = fields.map((field, fieldIndex) => {
      const paramIndex = recordIndex * fields.length + fieldIndex + 1;
      values.push(record[field]);
      return `$${paramIndex}`;
    });
    placeholders.push(`(${recordPlaceholders.join(', ')})`);
  });

  let sql = `
    INSERT INTO ${table} (${fields.join(', ')})
    VALUES ${placeholders.join(', ')}
  `;

  if (options.onConflict) {
    sql += ` ON CONFLICT ${options.onConflict}`;
  }

  if (options.returning) {
    sql += ` RETURNING ${options.returning.join(', ')}`;
  }

  const result = await query(sql, values, { useReplica: false });
  return result.rows;
}

/**
 * 批次更新（優化版）
 */
export async function batchUpdate(
  table: string,
  updates: Array<{ id: any; data: any }>,
  idField: string = 'id'
): Promise<number> {
  if (updates.length === 0) return 0;

  const updatePromises = updates.map(({ id, data }) => {
    const fields = Object.keys(data);
    const values = Object.values(data);
    const setClause = fields.map((field, i) => `${field} = $${i + 2}`).join(', ');
    const sql = `UPDATE ${table} SET ${setClause} WHERE ${idField} = $1`;

    return query(sql, [id, ...values], { useReplica: false });
  });

  const results = await Promise.all(updatePromises);
  return results.reduce((sum, result) => sum + (result.rowCount || 0), 0);
}

// ============================================
// 連線池健康檢查
// ============================================

/**
 * 檢查所有連線池健康狀態
 */
export async function checkAllPoolsHealth() {
  const results = {
    master: await checkPoolHealth(masterPool, 'master'),
    replicas: await Promise.all(
      readReplicas.map((pool, i) =>
        checkPoolHealth(pool, `replica_${i + 1}`)
      )
    )
  };

  // 更新指標
  updateConnectionPoolMetrics(
    masterPool.idleCount,
    masterPool.totalCount - masterPool.idleCount,
    masterPool.waitingCount
  );

  return results;
}

/**
 * 檢查單個連線池健康狀態
 */
async function checkPoolHealth(pool: Pool, name: string) {
  try {
    const start = Date.now();
    const result = await pool.query('SELECT 1');
    const latency = Date.now() - start;

    return {
      name,
      healthy: result.rowCount === 1,
      latency,
      stats: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
      }
    };
  } catch (error: any) {
    return {
      name,
      healthy: false,
      error: error.message,
      stats: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
      }
    };
  }
}

// ============================================
// 連線池管理
// ============================================

/**
 * 關閉所有連線池
 */
export async function closeAllPools() {
  await Promise.all([
    masterPool.end(),
    ...readReplicas.map(pool => pool.end())
  ]);
  logger.info('All database pools closed');
}

/**
 * 取得連線池統計
 */
export function getPoolStats() {
  return {
    master: {
      total: masterPool.totalCount,
      idle: masterPool.idleCount,
      waiting: masterPool.waitingCount
    },
    replicas: readReplicas.map((pool, i) => ({
      name: `replica_${i + 1}`,
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount
    }))
  };
}

// 匯出輔助函數
export const queryOne = async (text: string, params?: any[], options?: QueryOptions) => {
  const res = await query(text, params, options);
  return res.rows[0] || null;
};

export const queryMany = async (text: string, params?: any[], options?: QueryOptions) => {
  const res = await query(text, params, options);
  return res.rows;
};

// 監聽連線池事件
masterPool.on('error', (err) => {
  logger.error('[Master Pool] Error:', err);
});

readReplicas.forEach((pool, i) => {
  pool.on('error', (err) => {
    logger.error(`[Replica ${i + 1} Pool] Error:`, err);
  });
});

// 定期健康檢查
setInterval(async () => {
  const health = await checkAllPoolsHealth();

  if (!health.master.healthy) {
    logger.error('Master database unhealthy', health.master);
  }

  health.replicas.forEach(replica => {
    if (!replica.healthy) {
      logger.error(`Replica ${replica.name} unhealthy`, replica);
    }
  });
}, 30000);

export default {
  query,
  queryOne,
  queryMany,
  beginTransaction,
  withTransaction,
  batchInsert,
  batchUpdate,
  checkAllPoolsHealth,
  closeAllPools,
  getPoolStats
};
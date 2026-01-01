import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// PostgreSQL 連接池（優化版）
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'hualien_taxi',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  // 連線池優化設定
  max: parseInt(process.env.DB_POOL_MAX || '50'), // 增加最大連接數
  min: parseInt(process.env.DB_POOL_MIN || '10'), // 設定最小連接數
  idleTimeoutMillis: 60000, // 增加到 60 秒
  connectionTimeoutMillis: 5000, // 增加連線超時
  statement_timeout: 30000, // SQL 語句超時
  query_timeout: 30000, // 查詢超時
  application_name: 'hualien_taxi_server', // 應用程式名稱（用於監控）
});

// 測試連接
pool.on('connect', () => {
  console.log('[DB] PostgreSQL 連接成功');
});

pool.on('error', (err) => {
  console.error('[DB] PostgreSQL 連接錯誤:', err);
});

// 查詢輔助函數
export const query = async (text: string, params?: any[]) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('[DB Query]', { text, duration: `${duration}ms`, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('[DB Error]', { text, error });
    throw error;
  }
};

// 單行查詢
export const queryOne = async (text: string, params?: any[]) => {
  const res = await query(text, params);
  return res.rows[0] || null;
};

// 多行查詢
export const queryMany = async (text: string, params?: any[]) => {
  const res = await query(text, params);
  return res.rows;
};

// 關閉連接池（通常在應用關閉時使用）
export const closePool = async () => {
  await pool.end();
  console.log('[DB] PostgreSQL 連接池已關閉');
};

// 獲取連接池實例（給需要直接使用 Pool 的服務使用）
export const getPool = (): Pool => pool;

// 連線池健康檢查
export const checkPoolHealth = async () => {
  try {
    const result = await pool.query('SELECT 1');
    const stats = {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      healthy: result.rowCount === 1
    };
    return stats;
  } catch (error) {
    console.error('[DB] 健康檢查失敗:', error);
    return {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      healthy: false,
      error: error
    };
  }
};

// 定期健康檢查（每30秒）
setInterval(async () => {
  const health = await checkPoolHealth();
  if (!health.healthy) {
    console.error('[DB Pool] 健康檢查失敗，嘗試重新連線');
  } else if (health.waitingCount > 5) {
    console.warn(`[DB Pool] 等待連線數過高: ${health.waitingCount}`);
  }
}, 30000);

export default pool;

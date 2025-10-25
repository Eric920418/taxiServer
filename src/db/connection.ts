import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// PostgreSQL 連接池
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'hualien_taxi',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 20, // 最大連接數
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
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

export default pool;

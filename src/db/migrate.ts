import fs from 'fs';
import path from 'path';
import pool from './connection';

/**
 * 執行資料庫 Migration
 */
async function runMigration() {
  try {
    console.log('[Migration] 開始執行資料庫遷移...');

    // 讀取 migration SQL
    const migrationPath = path.join(__dirname, 'migrations/add-firebase-uid.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf-8');

    // 執行 SQL
    const result = await pool.query(migrationSQL);

    console.log('[Migration] ✓ 遷移完成');
    console.log(result.rows);

    process.exit(0);
  } catch (error) {
    console.error('[Migration] ✗ 遷移失敗:', error);
    process.exit(1);
  }
}

// 執行 migration
runMigration();

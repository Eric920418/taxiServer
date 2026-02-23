import fs from 'fs';
import path from 'path';
import pool from './connection';

/**
 * 可用的 Migration 列表
 */
const MIGRATIONS = {
  'firebase-uid': 'add-firebase-uid.sql',
  'ratings': 'add-ratings-table.sql',
  'fcm-token': 'add-fcm-token-columns.sql',
  'smart-dispatch': '001-smart-dispatch-tables.sql',  // 智能派單系統 V2
  'phone-order': '004-phone-order-tables.sql',        // 電話叫車系統
};

/**
 * 執行資料庫 Migration
 */
async function runMigration(migrationName?: string) {
  try {
    // 解析命令列參數
    const targetMigration = migrationName || process.argv[2];

    if (!targetMigration) {
      console.log('[Migration] 可用的 migrations:');
      Object.entries(MIGRATIONS).forEach(([name, file]) => {
        console.log(`  - ${name}: ${file}`);
      });
      console.log('\n用法: npx ts-node src/db/migrate.ts <migration-name>');
      console.log('範例: npx ts-node src/db/migrate.ts smart-dispatch');
      process.exit(0);
    }

    const migrationFile = MIGRATIONS[targetMigration as keyof typeof MIGRATIONS];
    if (!migrationFile) {
      console.error(`[Migration] ✗ 找不到 migration: ${targetMigration}`);
      console.log('可用的 migrations:', Object.keys(MIGRATIONS).join(', '));
      process.exit(1);
    }

    console.log(`[Migration] 開始執行: ${targetMigration} (${migrationFile})`);

    // 讀取 migration SQL
    const migrationPath = path.join(__dirname, 'migrations', migrationFile);
    const migrationSQL = fs.readFileSync(migrationPath, 'utf-8');

    // 執行 SQL
    const result = await pool.query(migrationSQL);

    console.log('[Migration] ✓ 遷移完成');
    if (result.rows && result.rows.length > 0) {
      console.log(result.rows);
    }

    process.exit(0);
  } catch (error) {
    console.error('[Migration] ✗ 遷移失敗:', error);
    process.exit(1);
  }
}

// 執行 migration
runMigration();

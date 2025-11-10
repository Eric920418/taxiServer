import fs from 'fs';
import path from 'path';
import pool, { query } from './connection';

/**
 * 初始化資料庫 Schema
 */
export async function initDatabase() {
  try {
    console.log('[DB Init] 開始初始化資料庫...');

    // 讀取 schema.sql
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');

    // 執行 SQL
    await pool.query(schema);

    console.log('[DB Init] ✓ 資料表建立成功');

    // 插入測試資料
    await seedTestData();

    console.log('[DB Init] ✓ 資料庫初始化完成');
  } catch (error) {
    console.error('[DB Init] ✗ 初始化失敗:', error);
    throw error;
  }
}

/**
 * 插入測試資料
 */
async function seedTestData() {
  console.log('[DB Seed] 插入測試資料...');

  // 檢查是否已有測試司機
  const existingDriver = await query(
    'SELECT driver_id FROM drivers WHERE driver_id = $1',
    ['D001']
  );

  if (existingDriver.rows.length > 0) {
    console.log('[DB Seed] 測試資料已存在，跳過');
    return;
  }

  // 插入測試司機（已移除 password，改用 Firebase Phone Auth）
  await query(`
    INSERT INTO drivers (driver_id, phone, name, plate, availability)
    VALUES
      ('D001', '0912345678', '王大明', 'ABC-1234', 'OFFLINE'),
      ('D002', '0987654321', '李小華', 'XYZ-5678', 'OFFLINE'),
      ('D003', '0965432100', '陳建國', 'DEF-9012', 'OFFLINE')
  `);

  console.log('[DB Seed] ✓ 測試司機已建立');

  // 插入測試乘客
  await query(`
    INSERT INTO passengers (passenger_id, phone, name)
    VALUES
      ('PASS001', '0911111111', '測試乘客A'),
      ('PASS002', '0922222222', '測試乘客B')
  `);

  console.log('[DB Seed] ✓ 測試乘客已建立');
}

/**
 * 清空所有資料表（危險！僅用於開發）
 */
export async function resetDatabase() {
  console.warn('[DB Reset] ⚠️  即將清空所有資料表...');

  await query('TRUNCATE TABLE driver_locations, daily_earnings, orders, passengers, drivers RESTART IDENTITY CASCADE');

  console.log('[DB Reset] ✓ 資料表已清空');

  // 重新插入測試資料
  await seedTestData();
}

// 如果直接執行此檔案，則初始化資料庫
if (require.main === module) {
  initDatabase()
    .then(() => {
      console.log('資料庫初始化完成！');
      process.exit(0);
    })
    .catch((error) => {
      console.error('資料庫初始化失敗:', error);
      process.exit(1);
    });
}

/**
 * seed_landmarks.ts
 *
 * 把原本 hardcoded 在 HualienAddressDB.ts 的 98 筆地標資料匯入 DB。
 * 採 ON CONFLICT DO NOTHING，重複執行安全。
 *
 * 執行：pnpm tsx src/db/seed_landmarks.ts
 */

import pool from './connection';
import { LANDMARKS_SEED } from './landmarks_seed_data';

async function seedLandmarks() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let insertedLandmarks = 0;
    let insertedAliases = 0;
    let skippedLandmarks = 0;

    for (const entry of LANDMARKS_SEED) {
      // 跳過座標為 null 的項目（原始資料中極少數鄉鎮類別沒有精確座標）
      if (entry.lat === null || entry.lng === null) {
        console.log(`[Seed] 跳過無座標地標: ${entry.name}`);
        skippedLandmarks++;
        continue;
      }

      const insertLandmark = await client.query(
        `INSERT INTO landmarks
           (name, lat, lng, address, category, district, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (name) DO NOTHING
         RETURNING id`,
        [
          entry.name,
          entry.lat,
          entry.lng,
          entry.address,
          entry.category,
          entry.district,
          entry.priority,
        ]
      );

      if (insertLandmark.rows.length === 0) {
        // 已存在，略過
        continue;
      }

      const landmarkId = insertLandmark.rows[0].id;
      insertedLandmarks++;

      for (const alias of entry.aliases || []) {
        const result = await client.query(
          `INSERT INTO landmark_aliases (landmark_id, alias, alias_type)
           VALUES ($1, $2, 'ALIAS')
           ON CONFLICT (alias, alias_type) DO NOTHING`,
          [landmarkId, alias]
        );
        insertedAliases += result.rowCount || 0;
      }

      for (const taigi of entry.taigiAliases || []) {
        const result = await client.query(
          `INSERT INTO landmark_aliases (landmark_id, alias, alias_type)
           VALUES ($1, $2, 'TAIGI')
           ON CONFLICT (alias, alias_type) DO NOTHING`,
          [landmarkId, taigi]
        );
        insertedAliases += result.rowCount || 0;
      }
    }

    await client.query('COMMIT');

    console.log(`[Seed] 完成：`);
    console.log(`  新增地標：${insertedLandmarks} 筆`);
    console.log(`  新增別名：${insertedAliases} 筆`);
    console.log(`  跳過（無座標）：${skippedLandmarks} 筆`);

    const total = await pool.query(
      'SELECT COUNT(*) AS count FROM landmarks WHERE deleted_at IS NULL'
    );
    console.log(`  DB 內地標總數：${total.rows[0].count} 筆`);

    process.exit(0);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Seed] 失敗:', error);
    process.exit(1);
  } finally {
    client.release();
  }
}

seedLandmarks();

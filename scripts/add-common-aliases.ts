/**
 * add-common-aliases.ts
 *
 * 一次性腳本：補上常用查詢但 DB 沒對應 alias 的地標。
 *
 * 起因：客人傳「民國路 7-11 超商」找不到任何 landmark，因為 id=196「民國路7-ELEVEn 愛民門市」
 * 沒設「民國路7-11」「民國路超商」這類自然講法的別名。
 *
 * 用法：
 *   pnpm ts-node scripts/add-common-aliases.ts
 *
 * 冪等：UNIQUE 衝突跳過。
 */

import dotenv from 'dotenv';
import pool from '../src/db/connection';

dotenv.config();

interface AliasSpec {
  landmarkId: number;
  landmarkName: string; // 只給 log 用
  aliases: string[];
}

// 想到再加進來，每跑一次補一次
const SPECS: AliasSpec[] = [
  {
    landmarkId: 196,
    landmarkName: '民國路7-ELEVEn 愛民門市',
    aliases: ['民國路7-11', '民國路超商', '民國路7-11超商', '愛民7-11', '愛民門市', '民國7-11'],
  },
  // 順手補幾個慈濟相關自然講法（避免 SUBSTRING 多筆平手命中錯的）
  {
    landmarkId: 234, // 花蓮慈濟醫院急診
    landmarkName: '花蓮慈濟醫院急診',
    aliases: ['慈濟急診', '慈濟醫院急診室', '慈院急診'],
  },
  {
    landmarkId: 236, // 花蓮慈濟門診
    landmarkName: '花蓮慈濟門診',
    aliases: ['慈濟門診', '慈院門診', '慈濟門診大樓', '慈濟輪椅出入口'],
  },
];

async function main(): Promise<void> {
  console.log('=== 補常用 alias ===\n');

  let added = 0;
  let skipped = 0;

  for (const spec of SPECS) {
    // 確認 landmark 存在
    const exists = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM landmarks WHERE id = $1 AND deleted_at IS NULL`,
      [spec.landmarkId]
    );
    if (exists.rows.length === 0) {
      console.log(`⚠ landmark id=${spec.landmarkId} (${spec.landmarkName}) 不存在或已刪除，跳過全部別名`);
      continue;
    }

    console.log(`\n[${spec.landmarkId}] ${exists.rows[0].name}`);

    for (const alias of spec.aliases) {
      try {
        await pool.query(
          `INSERT INTO landmark_aliases (landmark_id, alias, alias_type) VALUES ($1, $2, 'ALIAS')`,
          [spec.landmarkId, alias]
        );
        console.log(`  + 「${alias}」`);
        added++;
      } catch (e: any) {
        if (e?.code === '23505') {
          // unique 衝突
          console.log(`  ⚠ 「${alias}」已存在於其他地標，跳過`);
          skipped++;
        } else {
          throw e;
        }
      }
    }
  }

  console.log(`\n=== 統計 ===`);
  console.log(`  新增: ${added}`);
  console.log(`  跳過 (UNIQUE 衝突): ${skipped}`);
  console.log(`\n注意：Server 重啟後 hualienAddressDB.rebuildIndex() 會自動載入新 alias`);

  await pool.end();
}

main().catch((err) => {
  console.error('腳本失敗:', err);
  process.exit(1);
});

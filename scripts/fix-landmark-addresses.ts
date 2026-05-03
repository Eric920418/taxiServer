/**
 * fix-landmark-addresses.ts
 *
 * 一次性腳本：用 Google Reverse Geocoding API 重抓指定 landmarks 的 address 欄位。
 *
 * 起因：admin 編輯時把備註/地名/特殊符號塞進 address 欄位，造成 LINE 客人看到
 * 「到放輪椅的地方等 中央路三段707號」這類亂七八糟內容。
 *
 * 用法：
 *   pnpm ts-node scripts/fix-landmark-addresses.ts          # dry-run，只印對比
 *   pnpm ts-node scripts/fix-landmark-addresses.ts --apply  # 真寫 DB
 *
 * 預設修這 7 筆（2026-05-03 從 DB 撈出來的爛資料）：
 *   23, 164, 165, 166, 167, 168, 236
 * 若要修不同 landmark：用 --ids=1,2,3 覆蓋預設清單
 */

import dotenv from 'dotenv';
import pool from '../src/db/connection';
import { isWithinHualienBounds } from '../src/services/HualienAddressDB';

dotenv.config();

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const DEFAULT_IDS = [23, 164, 165, 166, 167, 168, 236];

interface Landmark {
  id: number;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY 未設定');
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=zh-TW&region=tw&result_type=street_address|premise|point_of_interest|establishment&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json() as any;

  if (!data.results || data.results.length === 0) {
    // fallback: 不限 result_type
    const url2 = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=zh-TW&region=tw&key=${GOOGLE_MAPS_API_KEY}`;
    const res2 = await fetch(url2);
    const data2 = await res2.json() as any;
    if (!data2.results || data2.results.length === 0) return null;
    return data2.results[0].formatted_address || null;
  }

  return data.results[0].formatted_address || null;
}

/**
 * 清理 Google 回的 address 字串：去郵遞區號、去「台灣」前綴
 */
function cleanupAddress(addr: string): string {
  return addr
    .replace(/^\s*\d{3,6}\s*[,，]?\s*/, '')
    .replace(/^\s*(台灣|Taiwan)\s*[,，]?\s*/i, '')
    .trim();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const idsArg = args.find(a => a.startsWith('--ids='));
  const ids = idsArg
    ? idsArg.replace('--ids=', '').split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite)
    : DEFAULT_IDS;

  console.log(`=== 修復 landmark address 欄位 ===`);
  console.log(`模式: ${apply ? '✅ APPLY (寫 DB)' : '🔍 DRY-RUN (只印對比)'}`);
  console.log(`目標 IDs: [${ids.join(', ')}]`);
  console.log('');

  const result = await pool.query<Landmark>(
    `SELECT id, name, address, lat, lng FROM landmarks WHERE id = ANY($1::int[]) ORDER BY id`,
    [ids]
  );

  if (result.rows.length === 0) {
    console.log('❌ 找不到任何指定 ID 的 landmark');
    await pool.end();
    return;
  }

  let updateCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const lm of result.rows) {
    console.log(`\n[${lm.id}] ${lm.name}`);
    console.log(`   舊 address: "${lm.address}"`);

    if (!isWithinHualienBounds(lm.lat, lm.lng)) {
      console.log(`   ⚠ 座標不在花蓮縣範圍 (${lm.lat}, ${lm.lng})，跳過`);
      skipCount++;
      continue;
    }

    let newAddr: string | null = null;
    try {
      newAddr = await reverseGeocode(lm.lat, lm.lng);
    } catch (e: any) {
      console.log(`   ❌ Google API 失敗: ${e.message}`);
      errorCount++;
      continue;
    }

    if (!newAddr) {
      console.log(`   ⚠ Google 沒回 address，跳過`);
      skipCount++;
      continue;
    }

    const cleaned = cleanupAddress(newAddr);
    console.log(`   新 address: "${cleaned}"`);

    if (cleaned === lm.address) {
      console.log(`   ✓ 一樣，無需更新`);
      skipCount++;
      continue;
    }

    if (apply) {
      await pool.query(
        `UPDATE landmarks SET address = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [cleaned, lm.id]
      );
      console.log(`   ✅ 已更新`);
      updateCount++;
    } else {
      console.log(`   📝 (dry-run) 將更新`);
      updateCount++;
    }

    // 避免 Google API rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n=== 統計 ===`);
  console.log(`  將更新: ${updateCount}`);
  console.log(`  跳過: ${skipCount}`);
  console.log(`  錯誤: ${errorCount}`);

  if (!apply && updateCount > 0) {
    console.log(`\n⚠ 這是 dry-run。確認 OK 後執行：`);
    console.log(`  pnpm ts-node scripts/fix-landmark-addresses.ts --apply`);
  }

  if (apply) {
    console.log(`\n注意：Server 重啟後 hualienAddressDB.rebuildIndex() 會自動載入新 address`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('腳本失敗:', err);
  process.exit(1);
});

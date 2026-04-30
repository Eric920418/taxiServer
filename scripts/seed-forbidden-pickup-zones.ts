/**
 * seed-forbidden-pickup-zones.ts
 *
 * 一次性 seed：
 * 1. 用 Google Geocoding API 抓 3 個替代上車點座標（轉運7-11、回瀾青年旅館、阿美麻糬）
 * 2. INSERT 到 landmarks 表（含別名）
 * 3. 設定花蓮火車站 is_forbidden_pickup=true + alternative_pickup_landmark_ids
 *    （含已存在的「花蓮轉運站」+ 新加的 3 個）
 *
 * 用法：
 *   pnpm ts-node scripts/seed-forbidden-pickup-zones.ts
 *
 * 冪等：每筆都 ON CONFLICT DO NOTHING；UPDATE 只動 forbidden 旗標
 */

import dotenv from 'dotenv';
import pool from '../src/db/connection';
import { isWithinHualienBounds } from '../src/services/HualienAddressDB';

dotenv.config();

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

interface NewLandmarkSpec {
  searchQuery: string;
  name: string;
  category: 'TRANSPORT' | 'COMMERCIAL' | 'HOTEL';
  district: string;
  priority: number;
  aliases: string[];
}

const NEW_LANDMARKS: NewLandmarkSpec[] = [
  {
    searchQuery: '花蓮轉運站7-11',
    name: '花蓮轉運站7-11',
    category: 'COMMERCIAL',
    district: '花蓮市',
    priority: 7,
    aliases: ['轉運站7-11', '轉運7-11', '7-11轉運', '轉運站711', '7-11轉運站'],
  },
  {
    searchQuery: '回瀾青年旅館 花蓮',
    name: '回瀾青年旅館',
    category: 'HOTEL',
    district: '花蓮市',
    priority: 6,
    aliases: ['回瀾', '回瀾旅館', '回瀾旅店', '回瀾青旅'],
  },
  {
    searchQuery: '阿美麻糬 花蓮',
    name: '阿美麻糬',
    category: 'COMMERCIAL',
    district: '花蓮市',
    priority: 6,
    aliases: ['阿美', '阿美麻糬本店', '麻糬店'],
  },
];

const FORBIDDEN_LANDMARK_NAME = '花蓮火車站';
const EXISTING_ALTERNATIVE_NAME = '花蓮轉運站'; // 已存在 DB

async function geocode(query: string): Promise<{ lat: number; lng: number; address: string } | null> {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY 未設定');
  }

  const url =
    'https://maps.googleapis.com/maps/api/geocode/json' +
    `?address=${encodeURIComponent(query)}` +
    '&language=zh-TW&region=tw' +
    '&bounds=23.20,121.30|24.16,121.66' +
    '&components=country:TW' +
    `&key=${GOOGLE_MAPS_API_KEY}`;

  // 先試 Geocoding API
  const geoRes = await fetch(url);
  const geoData = await geoRes.json() as any;
  if (geoData.results?.[0]) {
    const r = geoData.results[0];
    const lat = r.geometry.location.lat;
    const lng = r.geometry.location.lng;
    if (isWithinHualienBounds(lat, lng)) {
      return { lat, lng, address: r.formatted_address };
    }
  }

  // Fallback：Places Text Search
  const placesUrl =
    'https://maps.googleapis.com/maps/api/place/textsearch/json' +
    `?query=${encodeURIComponent(query)}` +
    '&location=23.9871,121.6015&radius=50000' +
    '&language=zh-TW&region=tw' +
    `&key=${GOOGLE_MAPS_API_KEY}`;

  const placesRes = await fetch(placesUrl);
  const placesData = await placesRes.json() as any;
  if (placesData.results?.[0]) {
    const r = placesData.results[0];
    const lat = r.geometry.location.lat;
    const lng = r.geometry.location.lng;
    if (isWithinHualienBounds(lat, lng)) {
      return { lat, lng, address: r.formatted_address || query };
    }
  }

  return null;
}

async function upsertLandmark(spec: NewLandmarkSpec): Promise<number | null> {
  // 已存在？
  const existing = await pool.query<{ id: number }>(
    'SELECT id FROM landmarks WHERE name = $1 AND deleted_at IS NULL',
    [spec.name]
  );
  if (existing.rows[0]) {
    console.log(`  ✓ ${spec.name} 已存在 (id=${existing.rows[0].id})，跳過建立`);
    return existing.rows[0].id;
  }

  // Geocoding
  console.log(`  🔍 Geocoding: ${spec.searchQuery}`);
  const geo = await geocode(spec.searchQuery);
  if (!geo) {
    console.warn(`  ✗ 找不到座標：${spec.searchQuery}`);
    return null;
  }
  console.log(`    → lat=${geo.lat}, lng=${geo.lng}, addr=${geo.address.substring(0, 40)}...`);

  // INSERT landmarks（無 admin_id，靠 created_by NULL）
  const insertRes = await pool.query<{ id: number }>(
    `INSERT INTO landmarks (name, lat, lng, address, category, district, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [spec.name, geo.lat, geo.lng, geo.address, spec.category, spec.district, spec.priority]
  );
  const newId = insertRes.rows[0].id;
  console.log(`    + 新增 landmarks id=${newId}`);

  // INSERT 別名（unique 衝突跳過）
  for (const alias of spec.aliases) {
    try {
      await pool.query(
        `INSERT INTO landmark_aliases (landmark_id, alias, alias_type) VALUES ($1, $2, 'ALIAS')`,
        [newId, alias]
      );
    } catch (e: any) {
      if (e?.code === '23505') {
        // unique 衝突 — 別名已被其他地標用
        console.log(`    ⚠ 別名「${alias}」已存在於其他地標，跳過`);
      } else {
        throw e;
      }
    }
  }

  return newId;
}

async function main(): Promise<void> {
  console.log('=== 禁止上車區 seed 開始 ===\n');

  // 1. 抓 3 個新替代點
  console.log('Step 1: 用 Google API 抓 3 個替代上車點');
  const newAlternativeIds: number[] = [];
  for (const spec of NEW_LANDMARKS) {
    const id = await upsertLandmark(spec);
    if (id) newAlternativeIds.push(id);
  }

  // 2. 找已存在的「花蓮轉運站」
  console.log(`\nStep 2: 查詢已存在的「${EXISTING_ALTERNATIVE_NAME}」`);
  const existingAlt = await pool.query<{ id: number }>(
    'SELECT id FROM landmarks WHERE name = $1 AND deleted_at IS NULL',
    [EXISTING_ALTERNATIVE_NAME]
  );
  if (!existingAlt.rows[0]) {
    console.error(`  ✗ 找不到「${EXISTING_ALTERNATIVE_NAME}」，請先檢查 landmarks 表`);
    process.exit(1);
  }
  const existingAltId = existingAlt.rows[0].id;
  console.log(`  ✓ 找到 id=${existingAltId}`);

  // 3. 組合所有 alternative IDs（轉運站在最前面 — 最近）
  const allAlternativeIds = [existingAltId, ...newAlternativeIds];

  // 4. 找花蓮火車站
  console.log(`\nStep 3: 設定「${FORBIDDEN_LANDMARK_NAME}」為禁止上車區`);
  const forbidden = await pool.query<{ id: number }>(
    'SELECT id FROM landmarks WHERE name = $1 AND deleted_at IS NULL',
    [FORBIDDEN_LANDMARK_NAME]
  );
  if (!forbidden.rows[0]) {
    console.error(`  ✗ 找不到「${FORBIDDEN_LANDMARK_NAME}」`);
    process.exit(1);
  }
  const forbiddenId = forbidden.rows[0].id;

  await pool.query(
    `UPDATE landmarks
     SET is_forbidden_pickup = true,
         alternative_pickup_landmark_ids = $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [allAlternativeIds, forbiddenId]
  );
  console.log(`  ✓ ${FORBIDDEN_LANDMARK_NAME} (id=${forbiddenId}) 已設禁止上車`);
  console.log(`  ✓ 替代點 IDs: [${allAlternativeIds.join(', ')}]`);

  // 5. 摘要
  console.log('\n=== 完成 ===');
  console.log(`禁止上車地點：${FORBIDDEN_LANDMARK_NAME} (id=${forbiddenId})`);
  console.log(`替代上車點 (${allAlternativeIds.length} 個):`);
  const alts = await pool.query<{ id: number; name: string; lat: number; lng: number }>(
    `SELECT id, name, lat, lng FROM landmarks WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)`,
    [allAlternativeIds]
  );
  for (const a of alts.rows) {
    console.log(`  • [${a.id}] ${a.name} (${a.lat}, ${a.lng})`);
  }

  console.log('\n注意：Server 重啟後 hualienAddressDB.rebuildIndex() 會自動載入新欄位');

  await pool.end();
}

main().catch((err) => {
  console.error('Seed 失敗:', err);
  process.exit(1);
});

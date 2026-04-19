/**
 * HualienAddressDB - 花蓮在地地址資料庫
 *
 * 作為 Google Geocoding / Places API 之前的第一層快速比對，節省 API 配額。
 * 支援台語腔調別名（Whisper STT 容錯）。
 *
 * 2026-04 改版：地標資料從 DB 表 `landmarks` / `landmark_aliases` 載入（原 hardcoded
 * 98 筆資料已搬到 src/db/landmarks_seed_data.ts 作為 seed 來源）。
 * Admin Panel 新增/修改地標後呼叫 rebuildIndex() 原子替換記憶體索引。
 */

import pool from '../db/connection';

// ========== 類型定義 ==========

export interface LandmarkEntry {
  name: string;             // 正式全名
  lat: number | null;       // 精確緯度（人工驗證）
  lng: number | null;       // 精確經度
  address: string;          // 完整地址
  category: 'TRANSPORT' | 'MEDICAL' | 'SCHOOL' | 'COMMERCIAL' |
            'GOVERNMENT' | 'ATTRACTION' | 'HOTEL' | 'TOWNSHIP';
  aliases: string[];        // 簡稱/俗稱
  taigiAliases: string[];   // Whisper 台語腔調可能轉出的同音字
  priority: number;         // 0-10，越高越優先
  district: string;         // 所屬行政區（給 Geocoding 補前綴用）
}

export interface LookupResult {
  entry: LandmarkEntry;
  matchedAlias: string;
  matchType: 'EXACT' | 'ALIAS' | 'TAIGI' | 'SUBSTRING';
  confidence: number;
}

// ========== 花蓮縣地理範圍驗證 ==========

const HUALIEN_BOUNDS = {
  south: 23.20, north: 24.16,
  west: 121.30, east: 121.66,
};

/**
 * 驗證座標是否在花蓮縣範圍內
 * 用於攔截 Google Geocoding 回傳的離譜結果（如打錯字跑到玉里或台東）
 */
export function isWithinHualienBounds(lat: number, lng: number): boolean {
  return lat >= HUALIEN_BOUNDS.south && lat <= HUALIEN_BOUNDS.north &&
         lng >= HUALIEN_BOUNDS.west && lng <= HUALIEN_BOUNDS.east;
}

// ========== Google Places 結果智慧挑選 ==========

/**
 * 判斷 Google Geocoding/Places 結果是否為「行政區級別」（粗糙結果）
 * 行政區級結果代表 API 找不到精確地址，只能回傳縣市鄉鎮中心點，應視為失敗
 *
 * 精確結果的 types 會含：street_address / premise / establishment / point_of_interest
 * 粗糙結果的 types 只有：administrative_area_level_X / political / locality
 */
export function isAdministrativeAreaResult(types: string[] | undefined): boolean {
  if (!types || types.length === 0) return false;
  const preciseTypes = ['street_address', 'premise', 'establishment', 'point_of_interest', 'subpremise'];
  const hasPrecise = types.some(t => preciseTypes.includes(t));
  if (hasPrecise) return false;
  const adminTypes = ['administrative_area_level_1', 'administrative_area_level_2', 'administrative_area_level_3', 'locality', 'political'];
  return types.every(t => adminTypes.includes(t));
}

/**
 * 從 Places Search 結果陣列中智慧挑選最符合 query 的那筆
 *
 * 策略：
 * 1. 過濾：query 含「銀行/分行/郵局」但不含「ATM」→ 排除 types 含 'atm' 的結果
 * 2. 優先：name 完整包含 query 關鍵詞 + types 含 establishment/bank/post_office
 * 3. Fallback：保留順序的第一筆
 */
export function pickBestPlaceResult(results: any[], query: string): any | null {
  if (!results || results.length === 0) return null;

  const queryHasBank = /銀行|分行|郵局/.test(query);
  const queryHasAtm = /ATM|atm/i.test(query);

  const filtered = (queryHasBank && !queryHasAtm)
    ? results.filter(r => !(r.types || []).includes('atm'))
    : results;

  if (filtered.length === 0) return results[0];

  const preferredTypes = ['bank', 'post_office', 'establishment', 'point_of_interest'];
  const preferred = filtered.find(r => {
    const name = r.name || '';
    const types = r.types || [];
    const nameMatches = queryHasBank
      ? /分行|分公司|支行/.test(name) || types.includes('bank') || types.includes('post_office')
      : types.some((t: string) => preferredTypes.includes(t));
    return nameMatches;
  });

  return preferred || filtered[0];
}

// ========== 地址段數正規化（阿拉伯數字 → 國字） ==========

const SEGMENT_DIGIT_TO_HANZI: Record<string, string> = {
  '1': '一', '2': '二', '3': '三', '4': '四', '5': '五',
  '6': '六', '7': '七', '8': '八', '9': '九',
};

/**
 * 將「路/街/道/線/大道」後面的單位數字段數轉成國字段數
 *
 * 範例：
 *   吉興路1段     → 吉興路一段
 *   中央路3段56號 → 中央路三段56號（門牌號保留）
 *   中山路10段    → 中山路10段（雙位數不轉，避免「一〇」）
 *
 * 只處理 1-9 單位數，避免破壞門牌號碼。
 */
export function normalizeSegmentDigits(input: string): string {
  if (!input) return input;
  return input.replace(
    /([路街道線]|大道)\s*([1-9])\s*段/g,
    (_match, road: string, digit: string) => `${road}${SEGMENT_DIGIT_TO_HANZI[digit]}段`
  );
}

// ========== HualienAddressDB Class ==========

class HualienAddressDB {
  // 預建索引：key → LandmarkEntry（O(1) 查詢）
  // 使用「整個 Map 原子替換」策略：rebuild 時先建新 Map，最後一次性指派，
  // 因為 Node.js 單執行緒，lookup 永遠看到完整狀態（非 partial）。
  private exactIndex: Map<string, LandmarkEntry> = new Map();
  private aliasIndex: Map<string, LandmarkEntry> = new Map();
  private taigiIndex: Map<string, LandmarkEntry> = new Map();
  private allLandmarks: LandmarkEntry[] = [];
  private lastBuiltAt: Date | null = null;

  /**
   * 從 DB 載入地標並重建記憶體索引。
   * 啟動時由 index.ts 呼叫；Admin 寫入後由 admin-landmarks.ts 呼叫。
   */
  async rebuildIndex(): Promise<void> {
    const result = await pool.query(`
      SELECT
        l.id, l.name, l.lat, l.lng, l.address, l.category, l.district, l.priority,
        COALESCE(
          json_agg(
            json_build_object('alias', la.alias, 'type', la.alias_type)
          ) FILTER (WHERE la.id IS NOT NULL),
          '[]'::json
        ) AS aliases_json
      FROM landmarks l
      LEFT JOIN landmark_aliases la ON la.landmark_id = l.id
      WHERE l.deleted_at IS NULL
      GROUP BY l.id
      ORDER BY l.priority DESC, l.id ASC
    `);

    const newExact = new Map<string, LandmarkEntry>();
    const newAlias = new Map<string, LandmarkEntry>();
    const newTaigi = new Map<string, LandmarkEntry>();
    const newAll: LandmarkEntry[] = [];

    for (const row of result.rows) {
      const aliasList: string[] = [];
      const taigiList: string[] = [];
      for (const a of row.aliases_json as Array<{ alias: string; type: string }>) {
        if (a.type === 'TAIGI') taigiList.push(a.alias);
        else aliasList.push(a.alias);
      }

      const entry: LandmarkEntry = {
        name: row.name,
        lat: row.lat !== null ? parseFloat(row.lat) : null,
        lng: row.lng !== null ? parseFloat(row.lng) : null,
        address: row.address,
        category: row.category,
        aliases: aliasList,
        taigiAliases: taigiList,
        priority: row.priority,
        district: row.district,
      };

      newAll.push(entry);
      newExact.set(entry.name, entry);

      for (const alias of aliasList) {
        const existing = newAlias.get(alias);
        if (!existing || entry.priority > existing.priority) {
          newAlias.set(alias, entry);
        }
      }
      for (const taigi of taigiList) {
        if (!newTaigi.has(taigi)) {
          newTaigi.set(taigi, entry);
        }
      }
    }

    // 原子替換：lookup() 永遠看到完整狀態
    this.exactIndex = newExact;
    this.aliasIndex = newAlias;
    this.taigiIndex = newTaigi;
    this.allLandmarks = newAll;
    this.lastBuiltAt = new Date();

    console.log(
      `[HualienAddressDB] 重建索引完成：${newAll.length} 筆地標，` +
      `${newAlias.size} 個別名，${newTaigi.size} 個台語別名`
    );
  }

  /**
   * 索引最後重建時間（給 Admin Panel 顯示 / 監控用）
   */
  getLastBuiltAt(): Date | null {
    return this.lastBuiltAt;
  }

  /**
   * 對外暴露的段數正規化方法
   */
  normalizeSegment(input: string): string {
    return normalizeSegmentDigits(input);
  }

  /**
   * 驗證座標是否在花蓮縣服務範圍內
   */
  isWithinBounds(lat: number, lng: number): boolean {
    return isWithinHualienBounds(lat, lng);
  }

  /**
   * 主查詢：精確名稱 → 別名 → 台語別名 → 子字串包含
   */
  lookup(input: string): LookupResult | null {
    if (!input) return null;
    const normalized = normalizeSegmentDigits(input.trim());

    const exact = this.exactIndex.get(normalized);
    if (exact) {
      return { entry: exact, matchedAlias: normalized, matchType: 'EXACT', confidence: 1.0 };
    }

    const alias = this.aliasIndex.get(normalized);
    if (alias) {
      return { entry: alias, matchedAlias: normalized, matchType: 'ALIAS', confidence: 0.95 };
    }

    const taigi = this.taigiIndex.get(normalized);
    if (taigi) {
      console.log(`[HualienAddressDB] 台語命中: ${normalized} → ${taigi.name}`);
      return { entry: taigi, matchedAlias: normalized, matchType: 'TAIGI', confidence: 0.85 };
    }

    let bestMatch: LookupResult | null = null;
    let bestPriority = -1;

    for (const [key, entry] of this.exactIndex) {
      if (normalized.includes(key) || key.includes(normalized)) {
        if (entry.priority > bestPriority) {
          bestPriority = entry.priority;
          bestMatch = { entry, matchedAlias: key, matchType: 'SUBSTRING', confidence: 0.75 };
        }
      }
    }
    for (const [key, entry] of this.aliasIndex) {
      if (normalized.includes(key) || key.includes(normalized)) {
        if (entry.priority > bestPriority) {
          bestPriority = entry.priority;
          bestMatch = { entry, matchedAlias: key, matchType: 'SUBSTRING', confidence: 0.75 };
        }
      }
    }
    for (const [key, entry] of this.taigiIndex) {
      if (normalized.includes(key) || key.includes(normalized)) {
        if (entry.priority > bestPriority) {
          bestPriority = entry.priority;
          bestMatch = { entry, matchedAlias: key, matchType: 'TAIGI', confidence: 0.70 };
        }
      }
    }

    if (bestMatch) {
      console.log(`[HualienAddressDB] 子字串命中: ${normalized} → ${bestMatch.entry.name}`);
    }

    return bestMatch;
  }

  /**
   * 把輸入文字中的台語詞 / 別名替換成標準地標名
   */
  resolveAliases(text: string): string {
    let result = normalizeSegmentDigits(text);

    for (const [taigi, entry] of this.taigiIndex) {
      if (result.includes(taigi)) {
        result = result.replace(taigi, entry.name);
        console.log(`[HualienAddressDB] 台語替換: ${taigi} → ${entry.name}`);
      }
    }

    for (const [alias, entry] of this.aliasIndex) {
      if (result.includes(alias) && !result.includes(entry.name)) {
        result = result.replace(alias, entry.name);
      }
    }

    return result;
  }

  /**
   * 直接取得座標（供 geocodeAddress 拿精確座標）
   */
  getCoords(name: string): { lat: number; lng: number; address: string } | null {
    const result = this.lookup(name);
    if (result && result.entry.lat !== null && result.entry.lng !== null) {
      return {
        lat: result.entry.lat,
        lng: result.entry.lng,
        address: result.entry.address
      };
    }
    return null;
  }

  /**
   * 給 Geocoding API 使用的地址前綴（依鄉鎮判斷）
   */
  getGeocodingPrefix(address: string): string {
    const result = this.lookup(address);
    if (result) {
      const district = result.entry.district;
      if (district === '花蓮市') return '花蓮縣花蓮市';
      return `花蓮縣${district}`;
    }
    return '花蓮縣花蓮市';
  }

  /**
   * 取得所有地標（供外部使用，例如 /api/landmarks/sync 回 App 同步）
   */
  getAll(): LandmarkEntry[] {
    return this.allLandmarks;
  }
}

export const hualienAddressDB = new HualienAddressDB();

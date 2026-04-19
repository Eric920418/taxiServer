/**
 * AddressFailureLogger
 *
 * 當 LINE / 電話 / App 語音叫車時，HualienAddressDB.lookup() 無法高信心命中，
 * 透過這個 logger 把「未收錄的查詢」累積到 address_lookup_failures 表，
 * 讓 Admin 可以從真實用戶失敗中補漏（見 admin-panel 待補齊地標頁面）。
 *
 * 設計原則：
 *   1. 完全 fire-and-forget — 任何錯誤只 console.warn，絕不阻斷叫車流程
 *   2. 去重：相同 normalized + source 累加 hit_count，不重複插入
 *   3. 閾值：confidence < 0.7 視為失敗
 *
 * 兩段式 API：
 *   recordFailedQuery()   — 查詢進入時呼叫，累加 hit_count
 *   attachGoogleResult()  — google 補救成功後呼叫，補充 google_result 欄位
 */

import pool from '../db/connection';
import { hualienAddressDB, LookupResult } from './HualienAddressDB';

export type FailureSource = 'LINE' | 'PHONE' | 'APP_VOICE';

const CONFIDENCE_THRESHOLD = 0.7;
const MAX_QUERY_LENGTH = 200;

export function shouldLogFailure(lookup: LookupResult | null | undefined): boolean {
  if (!lookup) return true;
  return lookup.confidence < CONFIDENCE_THRESHOLD;
}

function normalizeKey(query: string): string {
  return hualienAddressDB.normalizeSegment(query.trim());
}

/**
 * 記錄一次失敗查詢，累加 hit_count。
 * 每次呼叫會讓 hit_count +1（或新增記錄 hit_count=1）。
 */
export async function recordFailedQuery(
  query: string,
  source: FailureSource,
  lookup: LookupResult | null | undefined
): Promise<void> {
  try {
    if (!query || !query.trim()) return;
    if (!shouldLogFailure(lookup)) return;

    const normalized = normalizeKey(query);
    if (normalized.length > MAX_QUERY_LENGTH || normalized.length === 0) return;

    const bestMatch = lookup ? {
      entry_name: lookup.entry.name,
      entry_lat: lookup.entry.lat,
      entry_lng: lookup.entry.lng,
      matched_alias: lookup.matchedAlias,
      match_type: lookup.matchType,
      confidence: lookup.confidence,
    } : null;

    await pool.query(
      `INSERT INTO address_lookup_failures
         (query, normalized, source, best_match)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (normalized, source) DO UPDATE SET
         hit_count = address_lookup_failures.hit_count + 1,
         last_seen_at = NOW(),
         best_match = COALESCE(EXCLUDED.best_match, address_lookup_failures.best_match)`,
      [
        query.trim(),
        normalized,
        source,
        bestMatch ? JSON.stringify(bestMatch) : null,
      ]
    );
  } catch (err) {
    console.warn('[AddressFailureLogger] recordFailedQuery 失敗（不影響叫車）:', (err as Error).message);
  }
}

/**
 * 當 google 補救出座標後，把 google_result 附加到該筆 failure 記錄。
 * 不增加 hit_count。如果該 query 當時 lookup 就成功（未 record），這裡不會建立新記錄。
 */
export async function attachGoogleResult(
  query: string,
  source: FailureSource,
  googleResult: { lat: number; lng: number; formattedAddress?: string; name?: string; types?: string[] }
): Promise<void> {
  try {
    if (!query || !query.trim()) return;
    const normalized = normalizeKey(query);
    if (normalized.length > MAX_QUERY_LENGTH || normalized.length === 0) return;

    await pool.query(
      `UPDATE address_lookup_failures
         SET google_result = $1::jsonb, last_seen_at = NOW()
         WHERE normalized = $2 AND source = $3
           AND resolved_landmark_id IS NULL
           AND dismissed_at IS NULL`,
      [JSON.stringify(googleResult), normalized, source]
    );
  } catch (err) {
    console.warn('[AddressFailureLogger] attachGoogleResult 失敗:', (err as Error).message);
  }
}

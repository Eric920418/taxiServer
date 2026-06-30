/**
 * hualienGeo.ts — 花蓮地名/路名匹配共用工具
 *
 * 解決「電話/LINE 叫車把路名配到錯鄉鎮、甚至配到完全無關的路」問題：
 *  - roadStemMismatch：geocode 回的路名與客人講的對不上（台昌路→民國路）就拒收
 *  - utteranceHasTownship / extractTownship：判斷客人是否講了鄉鎮、結果落在哪個鄉鎮
 * PhoneCallProcessor 與 LineMessageProcessor 共用，避免兩處邏輯漂移。
 */

/** 花蓮 12 鄉鎮（不含花蓮市；花蓮市另以 includes('花蓮市') 判）。 */
export const HUALIEN_TOWNSHIPS = ['吉安', '新城', '壽豐', '光復', '豐濱', '瑞穗', '富里', '秀林', '萬榮', '卓溪', '玉里', '鳳林'];

/** 全名鄉鎮市（含花蓮市），抽鄉鎮用，長者優先比對完整字。 */
const ALL_DISTRICTS = ['花蓮市', '吉安鄉', '新城鄉', '壽豐鄉', '光復鄉', '豐濱鄉', '瑞穗鄉', '富里鄉', '秀林鄉', '萬榮鄉', '卓溪鄉', '玉里鎮', '鳳林鎮'];

/** 客人原話是否已含鄉鎮市（含花蓮市）。false → 鄉鎮是系統猜的、AI 要跟客人確認。 */
export function utteranceHasTownship(addr: string): boolean {
  if (!addr) return false;
  if (addr.includes('花蓮市')) return true;
  return HUALIEN_TOWNSHIPS.some(t => addr.includes(t));
}

/** 從地址抽鄉鎮市名（'玉里鎮'/'吉安鄉'/'花蓮市'…），抽不到回 null。 */
export function extractTownship(addr: string): string | null {
  if (!addr) return null;
  for (const d of ALL_DISTRICTS) {
    if (addr.includes(d)) return d;
  }
  for (const t of HUALIEN_TOWNSHIPS) {
    if (addr.includes(t)) return t;
  }
  return null;
}

/** 抽出地址中的「路名主幹」（路/街/道 之前 1-4 個中文字），無路名回 null。 */
export function extractRoadStem(addr: string): string | null {
  if (!addr) return null;
  const matches = [...addr.matchAll(/([一-龥]{1,4})(路|街|道)/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1];
}

/**
 * geocode 結果的路名是否與客人講的「對不上」。
 *  - 客人沒講路（地標/裸地名）→ 不檢查、回 false。
 *  - 客人有路名但結果沒路名 → 可疑、回 true。
 *  - 路名主幹零共同字（台昌 vs 民國）→ 對不上、回 true。
 *  - 任一方包含另一方（太昌 ↔ 太昌路42巷）→ 相符、回 false。
 * 先寬鬆判「零共同字才拒」，再依 log 收緊。
 */
export function roadStemMismatch(input: string, resultAddr: string): boolean {
  const inStem = extractRoadStem(input);
  if (!inStem) return false;
  const outStem = extractRoadStem(resultAddr);
  if (!outStem) return true;
  if (inStem.includes(outStem) || outStem.includes(inStem)) return false;
  const outChars = new Set(outStem.split(''));
  const common = inStem.split('').filter(c => outChars.has(c)).length;
  return common === 0;
}

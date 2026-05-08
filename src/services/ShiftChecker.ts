/**
 * ShiftChecker - 班次檢查 helper
 *
 * 司機 drivers.shifts JSONB 欄位（schema 從 migration 014）：
 *   [{ shift_type: 'MORNING'|'AFTERNOON'|'EVENING'|'NIGHT', start: 'HH:MM', end: 'HH:MM', is_active: boolean }]
 *
 * 用途：dispatcher 派單前過濾不在班次的司機；cron 自動把不在班的 ON_DUTY 司機切 OFFLINE。
 *
 * 設計決策：
 * - shifts 為空陣列 → 視為 24/7 在班（向後相容，沒設排班的司機行為不變）
 * - 跨日班次（end < start，例 22:00-06:00）：拆兩段 [start..23:59] ∪ [00:00..end]
 * - 時區：Asia/Taipei（台灣本地時間）
 * - 任一 active 的 shift 命中即視為在班
 */

import type { ShiftSlot } from '../utils/validators';

const TAIPEI_TIMEZONE = 'Asia/Taipei';

/**
 * 把 Date 轉成 Asia/Taipei 的 HH:MM 字串。
 * 不依賴 Intl.DateTimeFormat 的 locale option（部分 Node 版本支援不全），
 * 用 toLocaleTimeString 加 timeZone 是最穩的寫法。
 */
function toTaipeiHHMM(date: Date): string {
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TAIPEI_TIMEZONE,
  });
}

/** 'HH:MM' 字串轉成「當天分鐘數」(0-1439) */
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(s => parseInt(s, 10));
  return h * 60 + m;
}

/**
 * 檢查「現在分鐘數」是否在 [startMin, endMin] 區間內。
 * 跨日（endMin < startMin）拆兩段：[startMin..1439] ∪ [0..endMin]
 */
function isMinuteInRange(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) {
    // 退化 case：start == end，視為整天（避免 24:00:00 之類的邊界）
    return true;
  }
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin <= endMin;
  }
  // 跨日：例 22:00-06:00
  return nowMin >= startMin || nowMin <= endMin;
}

/**
 * 檢查司機現在是否在班次時間內。
 * shifts 為空 / 未提供 → return true（24/7 在班）
 */
export function isOnShift(now: Date, shifts: ShiftSlot[] | null | undefined): boolean {
  if (!shifts || !Array.isArray(shifts) || shifts.length === 0) return true;

  const activeShifts = shifts.filter(s => s.is_active);
  if (activeShifts.length === 0) {
    // 全部停用 → 視為「主動下班」，不在班
    return false;
  }

  const nowHHMM = toTaipeiHHMM(now);
  const nowMin = hhmmToMinutes(nowHHMM);

  return activeShifts.some(s => {
    const startMin = hhmmToMinutes(s.start);
    const endMin = hhmmToMinutes(s.end);
    return isMinuteInRange(nowMin, startMin, endMin);
  });
}

/**
 * 取得司機距離當前班次結束剩餘分鐘數（給 App 顯示「離下班 X 分」用）。
 * 不在班 → 回 null
 * 跨多段 active shift 中時 → 回最早結束那段
 */
export function minutesUntilShiftEnd(now: Date, shifts: ShiftSlot[] | null | undefined): number | null {
  if (!shifts || !Array.isArray(shifts) || shifts.length === 0) return null;
  const activeShifts = shifts.filter(s => s.is_active);
  if (activeShifts.length === 0) return null;

  const nowHHMM = toTaipeiHHMM(now);
  const nowMin = hhmmToMinutes(nowHHMM);

  let minRemaining: number | null = null;
  for (const s of activeShifts) {
    const startMin = hhmmToMinutes(s.start);
    const endMin = hhmmToMinutes(s.end);
    if (!isMinuteInRange(nowMin, startMin, endMin)) continue;

    let remaining: number;
    if (startMin <= endMin) {
      remaining = endMin - nowMin;
    } else {
      // 跨日 case
      remaining = nowMin >= startMin
        ? (1440 - nowMin) + endMin  // 還在前段
        : endMin - nowMin;          // 已過午夜進後段
    }
    if (minRemaining === null || remaining < minRemaining) {
      minRemaining = remaining;
    }
  }
  return minRemaining;
}

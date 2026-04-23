/**
 * 車資費率配置服務
 * 對齊花蓮縣政府計程車費率公告：
 *   - 日費率：起跳 100 元/1000m、每跳 5 元/230m、低速 120 秒/5 元
 *   - 夜費率（22:00–06:00）：起跳距離 834m、每跳距離 192m、低速 100 秒/5 元
 *     （起跳價與每跳金額沿用日費率 100/5 元）
 *   - 春節加成：期間內全日套用夜費率 + 每趟加收 50 元
 *
 * 持久化：config/fareConfig.json（巢狀結構，admin UI 可改）
 * 時區：以伺服器本地時間判斷夜間 / 春節（系統部署於 Asia/Taipei）
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DayFareConfig {
  basePrice: number;           // 起跳價（元）
  baseDistanceMeters: number;  // 起跳距離（公尺）
  jumpDistanceMeters: number;  // 每跳距離（公尺）
  jumpPrice: number;           // 每跳價格（元）
  slowTrafficSeconds: number;  // 低速計時門檻（秒）— Phase A 只存欄位，Phase C 才接 GPS
  slowTrafficPrice: number;    // 每段低速金額（元）
}

export interface NightFareConfig extends DayFareConfig {
  startHour: number;           // 夜間開始時間（0-23）
  endHour: number;             // 夜間結束時間（0-23），跨日支援（startHour > endHour）
}

export interface SpringFestivalConfig {
  enabled: boolean;            // 是否啟用春節加成
  startDate: string;           // ISO date "YYYY-MM-DD"
  endDate: string;             // ISO date "YYYY-MM-DD"（含當日）
  perTripSurcharge: number;    // 每趟加收（元）
}

export interface FareConfig {
  day: DayFareConfig;
  night: NightFareConfig;
  springFestival: SpringFestivalConfig;
  loveCardSubsidyAmount: number;  // 愛心卡每趟補貼金額（元）
}

export interface FareCalculationResult {
  baseFare: number;
  distanceFare: number;
  slowTrafficFare: number;
  springFestivalSurcharge: number;
  totalFare: number;
  meterJumps: number;
  isNight: boolean;
  isSpringFestival: boolean;
  appliedSchedule: 'day' | 'night';
}

const DEFAULT_CONFIG: FareConfig = {
  day: {
    basePrice: 100,
    baseDistanceMeters: 1000,
    jumpDistanceMeters: 230,
    jumpPrice: 5,
    slowTrafficSeconds: 120,
    slowTrafficPrice: 5,
  },
  night: {
    basePrice: 100,
    baseDistanceMeters: 834,
    jumpDistanceMeters: 192,
    jumpPrice: 5,
    slowTrafficSeconds: 100,
    slowTrafficPrice: 5,
    startHour: 22,
    endHour: 6,
  },
  springFestival: {
    enabled: false,
    startDate: '2026-02-16',
    endDate: '2026-02-22',
    perTripSurcharge: 50,
  },
  loveCardSubsidyAmount: 73,
};

class FareConfigService {
  private config: FareConfig;
  private jsonPath: string;

  constructor() {
    this.jsonPath = path.join(__dirname, '../../config/fareConfig.json');
    this.config = this.loadFromJson();
    console.log('[FareConfig] 費率配置已載入:', JSON.stringify(this.config, null, 2));
  }

  private loadFromJson(): FareConfig {
    try {
      if (fs.existsSync(this.jsonPath)) {
        const raw = fs.readFileSync(this.jsonPath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<FareConfig>;
        return this.mergeWithDefaults(parsed);
      }
    } catch (error) {
      console.error('[FareConfig] 讀取 fareConfig.json 失敗，使用預設值:', error);
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  private mergeWithDefaults(partial: Partial<FareConfig>): FareConfig {
    return {
      day: { ...DEFAULT_CONFIG.day, ...(partial.day ?? {}) },
      night: { ...DEFAULT_CONFIG.night, ...(partial.night ?? {}) },
      springFestival: { ...DEFAULT_CONFIG.springFestival, ...(partial.springFestival ?? {}) },
      loveCardSubsidyAmount: partial.loveCardSubsidyAmount ?? DEFAULT_CONFIG.loveCardSubsidyAmount,
    };
  }

  getConfig(): FareConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  async updateConfig(newConfig: Partial<FareConfig>): Promise<FareConfig> {
    this.validate(newConfig);
    this.config = this.mergeWithDefaults({ ...this.config, ...newConfig });
    await this.saveToJson();
    console.log('[FareConfig] 費率配置已更新:', JSON.stringify(this.config, null, 2));
    return this.getConfig();
  }

  private validate(partial: Partial<FareConfig>): void {
    const validateFareGroup = (label: string, group: Partial<DayFareConfig>) => {
      if (group.basePrice !== undefined && (!Number.isInteger(group.basePrice) || group.basePrice < 0)) {
        throw new Error(`${label}.basePrice 必須是非負整數`);
      }
      if (group.baseDistanceMeters !== undefined && (!Number.isInteger(group.baseDistanceMeters) || group.baseDistanceMeters < 0)) {
        throw new Error(`${label}.baseDistanceMeters 必須是非負整數`);
      }
      if (group.jumpDistanceMeters !== undefined && (!Number.isInteger(group.jumpDistanceMeters) || group.jumpDistanceMeters <= 0)) {
        throw new Error(`${label}.jumpDistanceMeters 必須是正整數`);
      }
      if (group.jumpPrice !== undefined && (!Number.isInteger(group.jumpPrice) || group.jumpPrice < 0)) {
        throw new Error(`${label}.jumpPrice 必須是非負整數`);
      }
      if (group.slowTrafficSeconds !== undefined && (!Number.isInteger(group.slowTrafficSeconds) || group.slowTrafficSeconds <= 0)) {
        throw new Error(`${label}.slowTrafficSeconds 必須是正整數`);
      }
      if (group.slowTrafficPrice !== undefined && (!Number.isInteger(group.slowTrafficPrice) || group.slowTrafficPrice < 0)) {
        throw new Error(`${label}.slowTrafficPrice 必須是非負整數`);
      }
    };

    if (partial.day) validateFareGroup('day', partial.day);
    if (partial.night) {
      validateFareGroup('night', partial.night);
      if (partial.night.startHour !== undefined && (partial.night.startHour < 0 || partial.night.startHour > 23)) {
        throw new Error('night.startHour 必須介於 0-23');
      }
      if (partial.night.endHour !== undefined && (partial.night.endHour < 0 || partial.night.endHour > 23)) {
        throw new Error('night.endHour 必須介於 0-23');
      }
    }
    if (partial.springFestival) {
      const sf = partial.springFestival;
      if (sf.perTripSurcharge !== undefined && (!Number.isInteger(sf.perTripSurcharge) || sf.perTripSurcharge < 0)) {
        throw new Error('springFestival.perTripSurcharge 必須是非負整數');
      }
      if (sf.startDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(sf.startDate)) {
        throw new Error('springFestival.startDate 必須是 YYYY-MM-DD 格式');
      }
      if (sf.endDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(sf.endDate)) {
        throw new Error('springFestival.endDate 必須是 YYYY-MM-DD 格式');
      }
    }
    if (partial.loveCardSubsidyAmount !== undefined && (!Number.isInteger(partial.loveCardSubsidyAmount) || partial.loveCardSubsidyAmount < 0)) {
      throw new Error('loveCardSubsidyAmount 必須是非負整數');
    }
  }

  private async saveToJson(): Promise<void> {
    const dir = path.dirname(this.jsonPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.jsonPath, JSON.stringify(this.config, null, 2), 'utf-8');
    console.log('[FareConfig] config/fareConfig.json 已更新');
  }

  /**
   * 計算車資（跳錶制）
   * 車資尾數只會是 0 或 5
   *
   * @param distanceMeters 行駛距離（公尺）
   * @param at 計算當下時間（預設為 new Date()），可指定以測試夜間/春節情境
   * @param slowTrafficSeconds 低速累積秒數（Phase A 預設 0，Phase C 接 GPS）
   */
  calculateFare(
    distanceMeters: number,
    at: Date = new Date(),
    slowTrafficSeconds: number = 0,
  ): FareCalculationResult {
    const isSpringFestival = this.isSpringFestival(at);
    const isNight = this.isNightTime(at);

    // 春節期間強制套用夜費率（公告：全日套夜間費率）
    const useNightSchedule = isSpringFestival || isNight;
    const schedule = useNightSchedule ? this.config.night : this.config.day;

    const extraDistanceMeters = Math.max(0, distanceMeters - schedule.baseDistanceMeters);
    const meterJumps = extraDistanceMeters > 0
      ? Math.ceil(extraDistanceMeters / schedule.jumpDistanceMeters)
      : 0;
    const distanceFare = meterJumps * schedule.jumpPrice;

    // 低速計時：每滿 schedule.slowTrafficSeconds 秒加 schedule.slowTrafficPrice 元
    const slowTrafficUnits = slowTrafficSeconds > 0
      ? Math.floor(slowTrafficSeconds / schedule.slowTrafficSeconds)
      : 0;
    const slowTrafficFare = slowTrafficUnits * schedule.slowTrafficPrice;

    const springFestivalSurcharge = isSpringFestival ? this.config.springFestival.perTripSurcharge : 0;

    const totalFare = schedule.basePrice + distanceFare + slowTrafficFare + springFestivalSurcharge;

    return {
      baseFare: schedule.basePrice,
      distanceFare,
      slowTrafficFare,
      springFestivalSurcharge,
      totalFare,
      meterJumps,
      isNight,
      isSpringFestival,
      appliedSchedule: useNightSchedule ? 'night' : 'day',
    };
  }

  /**
   * 取得指定時間在台北（Asia/Taipei, UTC+8）的「日期 + 小時」
   *
   * 為什麼不用 at.getHours() / at.getDate()：production server 時區是 UTC，
   * Date 物件的 local time 方法會回 UTC 值 → 「台北 23:00」變成 UTC 15:00 → 不算夜間。
   * 為什麼不依賴系統 TZ 環境變數：避免「換主機 / 改 systemd 設定」就靜默改變計費。
   * 為什麼不用 Intl.DateTimeFormat：台北無夏令時，固定 +8 偏移，手算最簡單可靠。
   */
  private toTaipei(at: Date): { year: number; month: number; day: number; hour: number } {
    const taipeiMs = at.getTime() + 8 * 60 * 60 * 1000;
    const t = new Date(taipeiMs);
    return {
      year: t.getUTCFullYear(),
      month: t.getUTCMonth() + 1,
      day: t.getUTCDate(),
      hour: t.getUTCHours(),
    };
  }

  private isNightTime(at: Date): boolean {
    const { startHour, endHour } = this.config.night;
    const hour = this.toTaipei(at).hour;
    if (startHour > endHour) {
      return hour >= startHour || hour < endHour;
    }
    return hour >= startHour && hour < endHour;
  }

  private isSpringFestival(at: Date): boolean {
    const sf = this.config.springFestival;
    if (!sf.enabled) return false;
    const tp = this.toTaipei(at);
    const today = `${tp.year}-${String(tp.month).padStart(2, '0')}-${String(tp.day).padStart(2, '0')}`;
    return today >= sf.startDate && today <= sf.endDate;
  }
}

export const fareConfigService = new FareConfigService();

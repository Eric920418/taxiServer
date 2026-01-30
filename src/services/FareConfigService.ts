/**
 * 車資費率配置服務
 * 統一管理計程車跳錶費率，供 Server 和 Android 端使用
 * 支援運行時動態更新 + .env 持久化
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FareConfig {
  basePrice: number;           // 起跳價（元）
  baseDistanceMeters: number;  // 起跳距離（公尺）
  jumpDistanceMeters: number;  // 每跳距離（公尺）
  jumpPrice: number;           // 每跳價格（元）
  nightSurchargeRate: number;  // 夜間加成比例
  nightStartHour: number;      // 夜間開始時間
  nightEndHour: number;        // 夜間結束時間
}

class FareConfigService {
  private config: FareConfig;
  private envPath: string;

  constructor() {
    this.envPath = path.join(__dirname, '../../.env');
    this.config = this.loadFromEnv();
    console.log('[FareConfig] 費率配置已載入:', this.config);
  }

  private loadFromEnv(): FareConfig {
    return {
      basePrice: parseInt(process.env.FARE_BASE_PRICE || '100'),
      baseDistanceMeters: parseInt(process.env.FARE_BASE_DISTANCE_METERS || '1250'),
      jumpDistanceMeters: parseInt(process.env.FARE_JUMP_DISTANCE_METERS || '200'),
      jumpPrice: parseInt(process.env.FARE_JUMP_PRICE || '5'),
      nightSurchargeRate: parseFloat(process.env.FARE_NIGHT_SURCHARGE_RATE || '0.2'),
      nightStartHour: parseInt(process.env.FARE_NIGHT_START_HOUR || '23'),
      nightEndHour: parseInt(process.env.FARE_NIGHT_END_HOUR || '6'),
    };
  }

  getConfig(): FareConfig {
    return { ...this.config };
  }

  /**
   * 更新費率配置（運行時 + 持久化到 .env）
   */
  async updateConfig(newConfig: Partial<FareConfig>): Promise<FareConfig> {
    // 更新記憶體中的配置
    this.config = {
      ...this.config,
      ...newConfig,
    };

    // 持久化到 .env 文件
    await this.saveToEnv();

    console.log('[FareConfig] 費率配置已更新:', this.config);
    return this.getConfig();
  }

  /**
   * 將配置寫入 .env 文件
   */
  private async saveToEnv(): Promise<void> {
    try {
      let envContent = fs.readFileSync(this.envPath, 'utf-8');

      const updates: Record<string, string | number> = {
        'FARE_BASE_PRICE': this.config.basePrice,
        'FARE_BASE_DISTANCE_METERS': this.config.baseDistanceMeters,
        'FARE_JUMP_DISTANCE_METERS': this.config.jumpDistanceMeters,
        'FARE_JUMP_PRICE': this.config.jumpPrice,
        'FARE_NIGHT_SURCHARGE_RATE': this.config.nightSurchargeRate,
        'FARE_NIGHT_START_HOUR': this.config.nightStartHour,
        'FARE_NIGHT_END_HOUR': this.config.nightEndHour,
      };

      for (const [key, value] of Object.entries(updates)) {
        const regex = new RegExp(`^=.*$`, 'm');
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, `=`);
        } else {
          envContent += `\n=`;
        }
      }

      fs.writeFileSync(this.envPath, envContent);
      console.log('[FareConfig] .env 文件已更新');
    } catch (error) {
      console.error('[FareConfig] 寫入 .env 失敗:', error);
      throw error;
    }
  }

  /**
   * 四捨五入到最接近的 5 元
   */
  private roundToNearest5(value: number): number {
    return Math.round(value / 5) * 5;
  }

  /**
   * 計算車資（跳錶制）
   * - 車資尾數只會是 0 或 5
   */
  calculateFare(distanceMeters: number, isNightTime?: boolean): {
    baseFare: number;
    distanceFare: number;
    nightSurcharge: number;
    totalFare: number;
    meterJumps: number;
  } {
    const { basePrice, baseDistanceMeters, jumpDistanceMeters, jumpPrice, nightSurchargeRate, nightStartHour, nightEndHour } = this.config;

    // 計算超出起跳距離的部分
    const extraDistanceMeters = Math.max(0, distanceMeters - baseDistanceMeters);

    // 計算跳錶次數（無條件進位）
    const meterJumps = extraDistanceMeters > 0 
      ? Math.ceil(extraDistanceMeters / jumpDistanceMeters)
      : 0;

    // 里程費 = 跳錶次數 × 每跳價格（尾數只會是 0 或 5）
    const distanceFare = meterJumps * jumpPrice;
    const fare = basePrice + distanceFare;

    // 判斷是否為夜間時段
    const nightTime = isNightTime ?? this.isCurrentlyNightTime();

    // 夜間加成（四捨五入到 5 元）
    const nightSurcharge = nightTime 
      ? this.roundToNearest5(fare * nightSurchargeRate)
      : 0;

    const totalFare = fare + nightSurcharge;

    return {
      baseFare: basePrice,
      distanceFare,
      nightSurcharge,
      totalFare,
      meterJumps,
    };
  }

  /**
   * 判斷當前是否為夜間時段
   */
  private isCurrentlyNightTime(): boolean {
    const { nightStartHour, nightEndHour } = this.config;
    const currentHour = new Date().getHours();

    // 跨日情況（例如 23:00 - 06:00）
    if (nightStartHour > nightEndHour) {
      return currentHour >= nightStartHour || currentHour < nightEndHour;
    }
    return currentHour >= nightStartHour && currentHour < nightEndHour;
  }
}

// 單例模式
export const fareConfigService = new FareConfigService();

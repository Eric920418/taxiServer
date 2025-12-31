/**
 * 花蓮計程車系統 - 拒單預測器
 * 使用 TensorFlow.js 訓練二分類模型預測司機拒單機率
 *
 * 安裝依賴：pnpm add @tensorflow/tfjs-node
 *
 * 功能：
 * 1. 從歷史數據訓練模型
 * 2. 即時預測拒單機率
 * 3. 定期自動重訓練
 * 4. 模型持久化
 */

import { Pool } from 'pg';
import * as tf from '@tensorflow/tfjs-node';
import * as fs from 'fs';
import * as path from 'path';

// ============================================
// 類型定義
// ============================================

export interface PredictionFeatures {
  // 訂單特徵
  distanceToPickup: number;      // 司機到上車點距離（km）
  tripDistance: number;          // 行程距離（km）
  estimatedFare: number;         // 預估車資

  // 時間特徵
  hourOfDay: number;             // 時段 (0-23)
  dayOfWeek: number;             // 星期 (0-6)
  isHoliday: boolean;            // 是否假日

  // 司機狀態
  driverTodayEarnings: number;   // 今日收入
  driverTodayTrips: number;      // 今日訂單數
  driverOnlineHours: number;     // 今日在線時數
  driverAcceptanceRate: number;  // 歷史接單率
}

export interface DriverPattern {
  driverId: string;
  hourlyAcceptance: Record<string, number>;
  zoneAcceptance: Record<string, number>;
  avgAcceptedDistance: number;
  maxAcceptedDistance: number;
  shortTripRate: number;
  longTripRate: number;
  earningsThreshold: number;
  driverType: 'FAST_TURNOVER' | 'LONG_DISTANCE' | 'HIGH_VOLUME';
}

// ============================================
// 配置
// ============================================

const CONFIG = {
  // 模型結構
  INPUT_FEATURES: 10,
  HIDDEN_UNITS_1: 16,
  HIDDEN_UNITS_2: 8,
  DROPOUT_RATE: 0.2,

  // 訓練參數
  LEARNING_RATE: 0.001,
  EPOCHS: 50,
  BATCH_SIZE: 32,
  VALIDATION_SPLIT: 0.2,

  // 數據要求
  MIN_TRAINING_SAMPLES: 100,
  TRAINING_DAYS_LOOKBACK: 30,

  // 模型路徑
  MODEL_SAVE_PATH: './models/rejection-predictor',

  // 閾值
  HIGH_REJECTION_THRESHOLD: 0.7,

  // 特徵正規化參數
  FEATURE_RANGES: {
    distanceToPickup: { min: 0, max: 20 },
    tripDistance: { min: 0, max: 50 },
    estimatedFare: { min: 0, max: 2000 },
    hourOfDay: { min: 0, max: 23 },
    dayOfWeek: { min: 0, max: 6 },
    driverTodayEarnings: { min: 0, max: 20000 },
    driverTodayTrips: { min: 0, max: 30 },
    driverOnlineHours: { min: 0, max: 14 },
    driverAcceptanceRate: { min: 0, max: 100 },
  },
};

// ============================================
// 拒單預測器類
// ============================================

export class RejectionPredictor {
  private pool: Pool;
  private model: tf.Sequential | null = null;
  private isTraining: boolean = false;
  private lastTrainedAt: Date | null = null;
  private patternCache: Map<string, DriverPattern> = new Map();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * 初始化（載入或訓練模型）
   */
  async initialize(): Promise<void> {
    console.log('[RejectionPredictor] 初始化中...');

    // 嘗試載入現有模型
    const loaded = await this.loadModel();
    if (loaded) {
      console.log('[RejectionPredictor] 已載入現有模型');
      return;
    }

    // 訓練新模型
    console.log('[RejectionPredictor] 無現有模型，開始訓練...');
    await this.trainModel();
  }

  /**
   * 預測拒單機率
   */
  async predict(driverId: string, features: PredictionFeatures): Promise<number> {
    // 如果模型不存在，使用規則引擎
    if (!this.model) {
      return this.predictWithRules(driverId, features);
    }

    try {
      // 正規化特徵
      const normalizedFeatures = this.normalizeFeatures(features);

      // 預測
      const inputTensor = tf.tensor2d([normalizedFeatures]);
      const prediction = this.model.predict(inputTensor) as tf.Tensor;
      const probability = (await prediction.data())[0];

      // 清理
      inputTensor.dispose();
      prediction.dispose();

      return probability;
    } catch (error) {
      console.error('[RejectionPredictor] 預測失敗，使用規則引擎:', error);
      return this.predictWithRules(driverId, features);
    }
  }

  /**
   * 批量預測
   */
  async predictBatch(
    predictions: Array<{ driverId: string; features: PredictionFeatures }>
  ): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    if (!this.model) {
      // 使用規則引擎
      for (const { driverId, features } of predictions) {
        results.set(driverId, await this.predictWithRules(driverId, features));
      }
      return results;
    }

    try {
      // 批量正規化
      const normalizedBatch = predictions.map(p => this.normalizeFeatures(p.features));

      // 批量預測
      const inputTensor = tf.tensor2d(normalizedBatch);
      const predictionTensor = this.model.predict(inputTensor) as tf.Tensor;
      const probabilities = await predictionTensor.data();

      // 組裝結果
      for (let i = 0; i < predictions.length; i++) {
        results.set(predictions[i].driverId, probabilities[i]);
      }

      // 清理
      inputTensor.dispose();
      predictionTensor.dispose();

      return results;
    } catch (error) {
      console.error('[RejectionPredictor] 批量預測失敗:', error);
      // 回退到規則引擎
      for (const { driverId, features } of predictions) {
        results.set(driverId, await this.predictWithRules(driverId, features));
      }
      return results;
    }
  }

  /**
   * 使用規則引擎預測（備援方案）
   */
  private async predictWithRules(driverId: string, features: PredictionFeatures): Promise<number> {
    let probability = 0;

    // 獲取司機行為模式
    const pattern = await this.getDriverPattern(driverId);

    // 1. 距離因素（距離越遠，拒單機率越高）
    if (pattern) {
      if (features.distanceToPickup > pattern.maxAcceptedDistance) {
        probability += 0.35;
      } else if (features.distanceToPickup > pattern.avgAcceptedDistance * 1.5) {
        probability += 0.20;
      } else if (features.distanceToPickup > pattern.avgAcceptedDistance) {
        probability += 0.10;
      }
    } else {
      // 無歷史數據，使用預設
      if (features.distanceToPickup > 8) probability += 0.30;
      else if (features.distanceToPickup > 5) probability += 0.15;
    }

    // 2. 收入飽和檢測
    const earningsThreshold = pattern?.earningsThreshold || 8500;
    if (features.driverTodayEarnings > earningsThreshold) {
      probability += 0.25;
    } else if (features.driverTodayEarnings > earningsThreshold * 0.8) {
      probability += 0.10;
    }

    // 3. 時段偏好
    if (pattern?.hourlyAcceptance) {
      const hourRate = pattern.hourlyAcceptance[features.hourOfDay.toString()] || 0.8;
      probability += (1 - hourRate) * 0.15;
    }

    // 4. 行程類型偏好
    if (pattern) {
      if (features.tripDistance < 3 && pattern.shortTripRate < 70) {
        probability += 0.15; // 不喜歡短程
      }
      if (features.tripDistance > 10 && pattern.longTripRate < 70) {
        probability += 0.15; // 不喜歡長程
      }
    }

    // 5. 歷史接單率（低接單率司機更可能拒單）
    if (features.driverAcceptanceRate < 70) {
      probability += 0.15;
    } else if (features.driverAcceptanceRate < 85) {
      probability += 0.05;
    }

    // 6. 在線時間過長
    if (features.driverOnlineHours > 10) {
      probability += 0.10;
    }

    return Math.min(probability, 0.95);
  }

  /**
   * 訓練模型
   */
  async trainModel(): Promise<boolean> {
    if (this.isTraining) {
      console.log('[RejectionPredictor] 已在訓練中，跳過');
      return false;
    }

    this.isTraining = true;
    console.log('[RejectionPredictor] 開始訓練模型...');

    try {
      // 1. 獲取訓練數據
      const trainingData = await this.getTrainingData();

      if (trainingData.length < CONFIG.MIN_TRAINING_SAMPLES) {
        console.log(`[RejectionPredictor] 訓練樣本不足 (${trainingData.length}/${CONFIG.MIN_TRAINING_SAMPLES})，使用規則引擎`);
        this.isTraining = false;
        return false;
      }

      console.log(`[RejectionPredictor] 訓練樣本數: ${trainingData.length}`);

      // 2. 準備訓練資料
      const { features, labels } = this.prepareTrainingData(trainingData);

      // 3. 建立模型
      this.model = this.buildModel();

      // 4. 訓練
      const xs = tf.tensor2d(features);
      const ys = tf.tensor2d(labels, [labels.length, 1]);

      await this.model.fit(xs, ys, {
        epochs: CONFIG.EPOCHS,
        batchSize: CONFIG.BATCH_SIZE,
        validationSplit: CONFIG.VALIDATION_SPLIT,
        shuffle: true,
        callbacks: {
          onEpochEnd: (epoch, logs) => {
            if ((epoch + 1) % 10 === 0) {
              console.log(`  Epoch ${epoch + 1}: loss=${logs?.loss?.toFixed(4)}, accuracy=${logs?.acc?.toFixed(4)}`);
            }
          },
        },
      });

      // 5. 清理
      xs.dispose();
      ys.dispose();

      // 6. 儲存模型
      await this.saveModel();

      this.lastTrainedAt = new Date();
      console.log('[RejectionPredictor] 模型訓練完成');

      return true;
    } catch (error) {
      console.error('[RejectionPredictor] 訓練失敗:', error);
      return false;
    } finally {
      this.isTraining = false;
    }
  }

  /**
   * 建立模型架構
   */
  private buildModel(): tf.Sequential {
    const model = tf.sequential();

    // 輸入層 + 隱藏層 1
    model.add(tf.layers.dense({
      inputShape: [CONFIG.INPUT_FEATURES],
      units: CONFIG.HIDDEN_UNITS_1,
      activation: 'relu',
      kernelInitializer: 'glorotUniform',
    }));

    // Dropout
    model.add(tf.layers.dropout({ rate: CONFIG.DROPOUT_RATE }));

    // 隱藏層 2
    model.add(tf.layers.dense({
      units: CONFIG.HIDDEN_UNITS_2,
      activation: 'relu',
    }));

    // 輸出層
    model.add(tf.layers.dense({
      units: 1,
      activation: 'sigmoid',
    }));

    // 編譯
    model.compile({
      optimizer: tf.train.adam(CONFIG.LEARNING_RATE),
      loss: 'binaryCrossentropy',
      metrics: ['accuracy'],
    });

    return model;
  }

  /**
   * 獲取訓練數據
   */
  private async getTrainingData(): Promise<any[]> {
    const result = await this.pool.query(`
      SELECT
        r.driver_id,
        r.distance_to_pickup,
        r.trip_distance,
        r.estimated_fare,
        r.hour_of_day,
        EXTRACT(DOW FROM r.created_at) as day_of_week,
        r.driver_today_earnings,
        r.driver_today_trips,
        r.driver_online_hours,
        COALESCE(d.acceptance_rate, 80) as driver_acceptance_rate,
        1 as rejected  -- 這是拒單記錄
      FROM order_rejections r
      LEFT JOIN drivers d ON r.driver_id = d.driver_id
      WHERE r.created_at > NOW() - INTERVAL '${CONFIG.TRAINING_DAYS_LOOKBACK} days'
        AND r.rejection_reason != 'TIMEOUT'

      UNION ALL

      SELECT
        o.driver_id,
        -- 估算接單時的距離（使用簡化計算）
        COALESCE(
          SQRT(
            POW((o.pickup_lat - d.current_lat) * 111, 2) +
            POW((o.pickup_lng - d.current_lng) * 111 * COS(RADIANS(o.pickup_lat)), 2)
          ),
          3.0
        ) as distance_to_pickup,
        COALESCE(o.actual_distance_km, 5.0) as trip_distance,
        COALESCE(o.meter_amount, 200) as estimated_fare,
        o.hour_of_day,
        EXTRACT(DOW FROM o.created_at) as day_of_week,
        COALESCE(de.total_earnings, 0) as driver_today_earnings,
        COALESCE(de.total_trips, 0) as driver_today_trips,
        COALESCE(de.online_hours, 0) as driver_online_hours,
        COALESCE(d.acceptance_rate, 80) as driver_acceptance_rate,
        0 as rejected  -- 這是接單記錄
      FROM orders o
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      LEFT JOIN daily_earnings de ON o.driver_id = de.driver_id AND de.date = DATE(o.accepted_at)
      WHERE o.status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP', 'DONE')
        AND o.accepted_at > NOW() - INTERVAL '${CONFIG.TRAINING_DAYS_LOOKBACK} days'
        AND o.driver_id IS NOT NULL
    `);

    return result.rows;
  }

  /**
   * 準備訓練資料
   */
  private prepareTrainingData(data: any[]): { features: number[][]; labels: number[] } {
    const features: number[][] = [];
    const labels: number[] = [];

    for (const row of data) {
      const featureObj: PredictionFeatures = {
        distanceToPickup: parseFloat(row.distance_to_pickup) || 3,
        tripDistance: parseFloat(row.trip_distance) || 5,
        estimatedFare: parseInt(row.estimated_fare) || 200,
        hourOfDay: parseInt(row.hour_of_day) || 12,
        dayOfWeek: parseInt(row.day_of_week) || 3,
        isHoliday: false, // 簡化：暫不處理假日
        driverTodayEarnings: parseInt(row.driver_today_earnings) || 0,
        driverTodayTrips: parseInt(row.driver_today_trips) || 0,
        driverOnlineHours: parseFloat(row.driver_online_hours) || 0,
        driverAcceptanceRate: parseFloat(row.driver_acceptance_rate) || 80,
      };

      features.push(this.normalizeFeatures(featureObj));
      labels.push(parseInt(row.rejected));
    }

    return { features, labels };
  }

  /**
   * 正規化特徵
   */
  private normalizeFeatures(features: PredictionFeatures): number[] {
    const ranges = CONFIG.FEATURE_RANGES;

    return [
      this.normalize(features.distanceToPickup, ranges.distanceToPickup),
      this.normalize(features.tripDistance, ranges.tripDistance),
      this.normalize(features.estimatedFare, ranges.estimatedFare),
      this.normalize(features.hourOfDay, ranges.hourOfDay),
      this.normalize(features.dayOfWeek, ranges.dayOfWeek),
      features.isHoliday ? 1 : 0,
      this.normalize(features.driverTodayEarnings, ranges.driverTodayEarnings),
      this.normalize(features.driverTodayTrips, ranges.driverTodayTrips),
      this.normalize(features.driverOnlineHours, ranges.driverOnlineHours),
      this.normalize(features.driverAcceptanceRate, ranges.driverAcceptanceRate),
    ];
  }

  /**
   * Min-Max 正規化
   */
  private normalize(value: number, range: { min: number; max: number }): number {
    return (value - range.min) / (range.max - range.min);
  }

  /**
   * 儲存模型
   */
  private async saveModel(): Promise<void> {
    if (!this.model) return;

    try {
      const modelPath = path.resolve(CONFIG.MODEL_SAVE_PATH);

      // 確保目錄存在
      if (!fs.existsSync(path.dirname(modelPath))) {
        fs.mkdirSync(path.dirname(modelPath), { recursive: true });
      }

      await this.model.save(`file://${modelPath}`);
      console.log(`[RejectionPredictor] 模型已儲存到 ${modelPath}`);
    } catch (error) {
      console.error('[RejectionPredictor] 儲存模型失敗:', error);
    }
  }

  /**
   * 載入模型
   */
  private async loadModel(): Promise<boolean> {
    try {
      const modelPath = path.resolve(CONFIG.MODEL_SAVE_PATH);
      const modelJsonPath = path.join(modelPath, 'model.json');

      if (!fs.existsSync(modelJsonPath)) {
        console.log('[RejectionPredictor] 未找到模型文件');
        return false;
      }

      this.model = await tf.loadLayersModel(`file://${modelJsonPath}`) as tf.Sequential;

      // 重新編譯
      this.model.compile({
        optimizer: tf.train.adam(CONFIG.LEARNING_RATE),
        loss: 'binaryCrossentropy',
        metrics: ['accuracy'],
      });

      console.log('[RejectionPredictor] 模型載入成功');
      return true;
    } catch (error) {
      console.error('[RejectionPredictor] 載入模型失敗:', error);
      return false;
    }
  }

  /**
   * 獲取司機行為模式
   */
  private async getDriverPattern(driverId: string): Promise<DriverPattern | null> {
    // 先查快取
    if (this.patternCache.has(driverId)) {
      return this.patternCache.get(driverId)!;
    }

    try {
      const result = await this.pool.query(
        `SELECT * FROM driver_patterns WHERE driver_id = $1`,
        [driverId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      const pattern: DriverPattern = {
        driverId: row.driver_id,
        hourlyAcceptance: row.hourly_acceptance || {},
        zoneAcceptance: row.zone_acceptance || {},
        avgAcceptedDistance: parseFloat(row.avg_accepted_distance) || 3,
        maxAcceptedDistance: parseFloat(row.max_accepted_distance) || 10,
        shortTripRate: parseFloat(row.short_trip_rate) || 80,
        longTripRate: parseFloat(row.long_trip_rate) || 70,
        earningsThreshold: parseInt(row.earnings_threshold) || 8500,
        driverType: row.driver_type || 'HIGH_VOLUME',
      };

      // 存入快取
      this.patternCache.set(driverId, pattern);

      return pattern;
    } catch (error) {
      console.error('[RejectionPredictor] 獲取司機模式失敗:', error);
      return null;
    }
  }

  /**
   * 更新司機行為模式
   */
  async updateDriverPattern(driverId: string): Promise<void> {
    try {
      // 計算時段接單率
      const hourlyResult = await this.pool.query(`
        SELECT
          hour_of_day,
          COUNT(*) FILTER (WHERE rejected = 0)::float / NULLIF(COUNT(*), 0) as acceptance_rate
        FROM (
          SELECT hour_of_day, 0 as rejected
          FROM orders
          WHERE driver_id = $1 AND status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP', 'DONE')
            AND created_at > NOW() - INTERVAL '30 days'

          UNION ALL

          SELECT hour_of_day, 1 as rejected
          FROM order_rejections
          WHERE driver_id = $1 AND created_at > NOW() - INTERVAL '30 days'
        ) combined
        GROUP BY hour_of_day
      `, [driverId]);

      const hourlyAcceptance: Record<string, number> = {};
      for (const row of hourlyResult.rows) {
        hourlyAcceptance[row.hour_of_day] = parseFloat(row.acceptance_rate) || 0.8;
      }

      // 計算距離偏好
      const distanceResult = await this.pool.query(`
        SELECT
          AVG(distance_to_pickup) as avg_distance,
          MAX(distance_to_pickup) as max_distance
        FROM (
          SELECT
            SQRT(
              POW((o.pickup_lat - d.current_lat) * 111, 2) +
              POW((o.pickup_lng - d.current_lng) * 111 * COS(RADIANS(o.pickup_lat)), 2)
            ) as distance_to_pickup
          FROM orders o
          JOIN drivers d ON o.driver_id = d.driver_id
          WHERE o.driver_id = $1 AND o.status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP', 'DONE')
            AND o.created_at > NOW() - INTERVAL '30 days'
        ) distances
      `, [driverId]);

      // 計算訂單類型偏好
      const tripTypeResult = await this.pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE actual_distance_km < 3)::float / NULLIF(COUNT(*), 0) * 100 as short_rate,
          COUNT(*) FILTER (WHERE actual_distance_km > 10)::float / NULLIF(COUNT(*), 0) * 100 as long_rate
        FROM orders
        WHERE driver_id = $1 AND status = 'DONE'
          AND created_at > NOW() - INTERVAL '30 days'
      `, [driverId]);

      // 計算收入門檻
      const earningsResult = await this.pool.query(`
        SELECT AVG(total_earnings) * 1.2 as threshold
        FROM daily_earnings
        WHERE driver_id = $1 AND date > CURRENT_DATE - INTERVAL '30 days'
      `, [driverId]);

      // 計算司機類型
      const typeResult = await this.pool.query(`
        SELECT
          AVG(actual_duration_min) as avg_duration,
          AVG(actual_distance_km) as avg_distance
        FROM orders
        WHERE driver_id = $1 AND status = 'DONE'
          AND created_at > NOW() - INTERVAL '7 days'
      `, [driverId]);

      let driverType = 'HIGH_VOLUME';
      if (typeResult.rows[0]) {
        const avgDuration = parseFloat(typeResult.rows[0].avg_duration);
        const avgDistance = parseFloat(typeResult.rows[0].avg_distance);
        if (avgDuration < 10) driverType = 'FAST_TURNOVER';
        else if (avgDistance > 5) driverType = 'LONG_DISTANCE';
      }

      // 更新或插入
      await this.pool.query(`
        INSERT INTO driver_patterns (
          driver_id, hourly_acceptance, avg_accepted_distance, max_accepted_distance,
          short_trip_rate, long_trip_rate, earnings_threshold, driver_type,
          last_calculated_at, data_points
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP,
          (SELECT COUNT(*) FROM orders WHERE driver_id = $1 AND status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP', 'DONE'))
        )
        ON CONFLICT (driver_id) DO UPDATE SET
          hourly_acceptance = EXCLUDED.hourly_acceptance,
          avg_accepted_distance = EXCLUDED.avg_accepted_distance,
          max_accepted_distance = EXCLUDED.max_accepted_distance,
          short_trip_rate = EXCLUDED.short_trip_rate,
          long_trip_rate = EXCLUDED.long_trip_rate,
          earnings_threshold = EXCLUDED.earnings_threshold,
          driver_type = EXCLUDED.driver_type,
          last_calculated_at = EXCLUDED.last_calculated_at,
          data_points = EXCLUDED.data_points
      `, [
        driverId,
        JSON.stringify(hourlyAcceptance),
        distanceResult.rows[0]?.avg_distance || 3,
        distanceResult.rows[0]?.max_distance || 10,
        tripTypeResult.rows[0]?.short_rate || 80,
        tripTypeResult.rows[0]?.long_rate || 70,
        earningsResult.rows[0]?.threshold || 8500,
        driverType,
      ]);

      // 清除快取
      this.patternCache.delete(driverId);

      console.log(`[RejectionPredictor] 已更新司機 ${driverId} 的行為模式`);
    } catch (error) {
      console.error(`[RejectionPredictor] 更新司機模式失敗:`, error);
    }
  }

  /**
   * 批量更新所有司機模式
   */
  async updateAllDriverPatterns(): Promise<void> {
    console.log('[RejectionPredictor] 開始更新所有司機行為模式...');

    const result = await this.pool.query(`
      SELECT DISTINCT driver_id FROM orders
      WHERE status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP', 'DONE')
        AND created_at > NOW() - INTERVAL '30 days'
    `);

    let updated = 0;
    for (const row of result.rows) {
      await this.updateDriverPattern(row.driver_id);
      updated++;
    }

    console.log(`[RejectionPredictor] 已更新 ${updated} 位司機的行為模式`);
  }

  /**
   * 獲取模型統計
   */
  getStats(): {
    modelLoaded: boolean;
    lastTrainedAt: Date | null;
    isTraining: boolean;
    patternCacheSize: number;
  } {
    return {
      modelLoaded: this.model !== null,
      lastTrainedAt: this.lastTrainedAt,
      isTraining: this.isTraining,
      patternCacheSize: this.patternCache.size,
    };
  }
}

// ============================================
// 單例
// ============================================

let predictorInstance: RejectionPredictor | null = null;

export async function initRejectionPredictor(pool: Pool): Promise<RejectionPredictor> {
  if (!predictorInstance) {
    predictorInstance = new RejectionPredictor(pool);
    await predictorInstance.initialize();
    console.log('[RejectionPredictor] 初始化完成');
  }
  return predictorInstance;
}

export function getRejectionPredictor(): RejectionPredictor {
  if (!predictorInstance) {
    throw new Error('[RejectionPredictor] 尚未初始化，請先呼叫 initRejectionPredictor()');
  }
  return predictorInstance;
}

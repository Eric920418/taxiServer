/**
 * 花蓮計程車系統 - 智能派單引擎 V2
 *
 * 核心功能：
 * 1. 分層派單：每批 3 位司機，20 秒超時
 * 2. 真實 ETA：混合策略（< 3km 估算，>= 3km 用 Google API）
 * 3. 預測性拒絕：TensorFlow.js ML 模型
 * 4. 動態權重：根據時段、需求調整
 * 5. 派單決策日誌
 */

import { Pool } from 'pg';
import { Server } from 'socket.io';
import {
  driverSockets,
  driverLocations,
  passengerSockets,
  getSocketIO,
} from '../socket';
import { ETAService, getETAService, Location } from './ETAService';
import {
  RejectionPredictor,
  getRejectionPredictor,
  PredictionFeatures,
} from './RejectionPredictor';

// ============================================
// 類型定義
// ============================================

export interface OrderData {
  orderId: string;
  passengerId: string;
  passengerName: string;
  passengerPhone: string;
  pickup: {
    lat: number;
    lng: number;
    address: string;
  };
  destination?: {
    lat: number;
    lng: number;
    address: string;
  } | null;
  paymentType: string;
  estimatedFare?: number;
  createdAt: number;
}

export interface DriverScore {
  driverId: string;
  driverName: string;
  totalScore: number;
  components: {
    distance: number;
    eta: number;
    earningsBalance: number;
    acceptancePrediction: number;
    efficiencyMatch: number;
    hotZone: number;
  };
  etaSeconds: number;
  etaSource: string;
  distanceKm: number;
  rejectionProbability: number;
  reason: string;
}

interface BatchResult {
  batchNumber: number;
  offeredDriverIds: string[];
  startedAt: number;
  endedAt?: number;
  acceptedBy?: string;
  rejectedBy: string[];
  timedOutDriverIds: string[];
}

interface OrderDispatchState {
  order: OrderData;
  status: 'DISPATCHING' | 'ACCEPTED' | 'CANCELLED' | 'TIMEOUT';
  currentBatch: number;
  batches: BatchResult[];
  allOfferedDriverIds: Set<string>;
  allRejectedDriverIds: Set<string>;
  allTimedOutDriverIds: Set<string>;
  acceptedBy?: string;
  createdAt: number;
  orderTimeoutTimer?: NodeJS.Timeout;
  batchTimeoutTimer?: NodeJS.Timeout;
}

// ============================================
// 配置
// ============================================

const CONFIG = {
  // 分層派單設定
  BATCH_SIZE: 3,
  BATCH_TIMEOUT_MS: 20_000,           // 20 秒
  MAX_BATCHES: 5,
  ORDER_TOTAL_TIMEOUT_MS: 300_000,    // 5 分鐘

  // 評分權重
  WEIGHTS: {
    distance: 0.20,
    eta: 0.20,
    earningsBalance: 0.20,
    acceptancePrediction: 0.20,
    efficiencyMatch: 0.10,
    hotZone: 0.10,
  },

  // 預測閾值
  REJECTION_PROBABILITY_THRESHOLD: 0.7,

  // 熱區定義
  HOT_ZONES: {
    '東大門夜市': { lat: 23.9986, lng: 121.6083, radius: 1, peakHours: [18, 19, 20, 21, 22] },
    '花蓮火車站': { lat: 23.9933, lng: 121.6011, radius: 0.8, peakHours: [6, 7, 8, 9, 17, 18] },
    '遠百花蓮店': { lat: 23.9878, lng: 121.6061, radius: 0.5, peakHours: [15, 16, 17, 18, 19, 20] },
    '太魯閣國家公園': { lat: 24.1555, lng: 121.6207, radius: 2, peakHours: [8, 9, 10, 15, 16] },
  },

  // 司機類型效率匹配分數
  EFFICIENCY_SCORES: {
    SHORT_TRIP: { FAST_TURNOVER: 15, LONG_DISTANCE: 7, HIGH_VOLUME: 10 },
    MEDIUM_TRIP: { FAST_TURNOVER: 10, LONG_DISTANCE: 10, HIGH_VOLUME: 15 },
    LONG_TRIP: { FAST_TURNOVER: 7, LONG_DISTANCE: 15, HIGH_VOLUME: 10 },
  },
};

// ============================================
// 智能派單引擎 V2
// ============================================

export class SmartDispatcherV2 {
  private pool: Pool;
  private activeOrders: Map<string, OrderDispatchState> = new Map();

  // 快取
  private driverEarningsCache: Map<string, { earnings: number; updatedAt: number }> = new Map();
  private driverStatsCache: Map<string, { stats: any; updatedAt: number }> = new Map();

  constructor(pool: Pool) {
    this.pool = pool;

    // 每小時清理快取
    setInterval(() => this.cleanupCaches(), 3600000);
  }

  // ============================================
  // 主要派單流程
  // ============================================

  /**
   * 開始派單（入口方法）
   */
  async startDispatch(order: OrderData): Promise<{
    success: boolean;
    message: string;
    batchNumber: number;
    offeredTo: string[];
  }> {
    console.log(`\n[SmartDispatcherV2] 開始派單 - 訂單 ${order.orderId}`);

    // 初始化派單狀態
    const state: OrderDispatchState = {
      order,
      status: 'DISPATCHING',
      currentBatch: 0,
      batches: [],
      allOfferedDriverIds: new Set(),
      allRejectedDriverIds: new Set(),
      allTimedOutDriverIds: new Set(),
      createdAt: Date.now(),
    };

    this.activeOrders.set(order.orderId, state);

    // 設置總超時
    state.orderTimeoutTimer = setTimeout(
      () => this.handleOrderTimeout(order.orderId),
      CONFIG.ORDER_TOTAL_TIMEOUT_MS
    );

    // 執行第一批派單
    const result = await this.executeBatch(order.orderId);

    return {
      success: result.offeredDriverIds.length > 0,
      message: result.offeredDriverIds.length > 0
        ? `已派發給 ${result.offeredDriverIds.length} 位司機`
        : '無可用司機',
      batchNumber: result.batchNumber,
      offeredTo: result.offeredDriverIds,
    };
  }

  /**
   * 執行單一批次派單
   */
  private async executeBatch(orderId: string): Promise<BatchResult> {
    const state = this.activeOrders.get(orderId);
    if (!state || state.status !== 'DISPATCHING') {
      return {
        batchNumber: 0,
        offeredDriverIds: [],
        startedAt: Date.now(),
        rejectedBy: [],
        timedOutDriverIds: [],
      };
    }

    state.currentBatch++;
    const batchNumber = state.currentBatch;

    console.log(`[SmartDispatcherV2] 執行第 ${batchNumber} 批派單`);

    // 選擇最佳司機
    const excludeDrivers = new Set([
      ...state.allOfferedDriverIds,
      ...state.allRejectedDriverIds,
      ...state.allTimedOutDriverIds,
    ]);

    const selectedDrivers = await this.selectBestDrivers(
      state.order,
      CONFIG.BATCH_SIZE,
      excludeDrivers
    );

    if (selectedDrivers.length === 0) {
      console.log(`[SmartDispatcherV2] 第 ${batchNumber} 批無可用司機`);

      // 檢查是否全部拒絕
      if (state.allRejectedDriverIds.size > 0 || state.allTimedOutDriverIds.size > 0) {
        await this.handleNoDriversAvailable(orderId, 'ALL_REJECTED');
      } else {
        await this.handleNoDriversAvailable(orderId, 'NO_DRIVERS');
      }

      return {
        batchNumber,
        offeredDriverIds: [],
        startedAt: Date.now(),
        rejectedBy: [],
        timedOutDriverIds: [],
      };
    }

    // 建立批次記錄
    const batchResult: BatchResult = {
      batchNumber,
      offeredDriverIds: selectedDrivers.map(d => d.driverId),
      startedAt: Date.now(),
      rejectedBy: [],
      timedOutDriverIds: [],
    };
    state.batches.push(batchResult);

    // 記錄派單決策
    await this.logDispatchDecision(orderId, batchNumber, selectedDrivers);

    // 推送訂單給選中的司機
    const io = getSocketIO();
    const responseDeadline = Date.now() + CONFIG.BATCH_TIMEOUT_MS;

    for (const driver of selectedDrivers) {
      const socketId = driverSockets.get(driver.driverId);
      if (socketId) {
        const orderOffer = {
          orderId: state.order.orderId,
          passengerId: state.order.passengerId,
          passengerName: state.order.passengerName,
          passengerPhone: state.order.passengerPhone,
          pickup: state.order.pickup,
          destination: state.order.destination,
          paymentType: state.order.paymentType,
          // 新增欄位
          batchNumber,
          estimatedFare: state.order.estimatedFare,
          distanceToPickup: driver.distanceKm,
          etaToPickup: Math.ceil(driver.etaSeconds / 60),
          googleEtaSeconds: driver.etaSeconds,
          etaSource: driver.etaSource,
          dispatchReason: driver.reason,
          responseDeadline,
          tripDistance: state.order.destination
            ? this.calculateDistance(
                state.order.pickup,
                state.order.destination
              )
            : null,
        };

        io.to(socketId).emit('order:offer', orderOffer);
        console.log(`  -> 推送給司機 ${driver.driverId} (${driver.driverName}), 評分: ${driver.totalScore.toFixed(1)}`);
        state.allOfferedDriverIds.add(driver.driverId);
      }
    }

    // 通知乘客派單進度
    this.notifyPassengerDispatchProgress(state.order.passengerId, {
      orderId,
      dispatchStatus: 'SEARCHING',
      currentBatch: batchNumber,
      offeredToCount: state.allOfferedDriverIds.size,
      estimatedWaitTime: CONFIG.BATCH_TIMEOUT_MS / 1000,
      message: `正在尋找司機 (第 ${batchNumber} 批)...`,
    });

    // 設置批次超時
    state.batchTimeoutTimer = setTimeout(
      () => this.handleBatchTimeout(orderId, batchNumber),
      CONFIG.BATCH_TIMEOUT_MS
    );

    return batchResult;
  }

  /**
   * 選擇最佳司機
   */
  private async selectBestDrivers(
    order: OrderData,
    count: number,
    excludeDrivers: Set<string>
  ): Promise<DriverScore[]> {
    const availableDrivers = await this.getAvailableDrivers(excludeDrivers);

    if (availableDrivers.length === 0) {
      return [];
    }

    console.log(`[SmartDispatcherV2] 評估 ${availableDrivers.length} 位可用司機`);

    // 計算所有司機的評分
    const scoredDrivers: DriverScore[] = [];

    for (const driver of availableDrivers) {
      const score = await this.calculateDriverScore(driver, order);

      // 過濾高拒單機率的司機
      if (score.rejectionProbability < CONFIG.REJECTION_PROBABILITY_THRESHOLD) {
        scoredDrivers.push(score);
      } else {
        console.log(`  跳過司機 ${driver.driverId} (拒單機率: ${(score.rejectionProbability * 100).toFixed(1)}%)`);
      }
    }

    // 按總分排序，取前 N 名
    scoredDrivers.sort((a, b) => b.totalScore - a.totalScore);

    return scoredDrivers.slice(0, count);
  }

  /**
   * 計算司機評分
   */
  private async calculateDriverScore(
    driver: any,
    order: OrderData
  ): Promise<DriverScore> {
    const currentHour = new Date().getHours();
    const weights = CONFIG.WEIGHTS;

    const components = {
      distance: 0,
      eta: 0,
      earningsBalance: 0,
      acceptancePrediction: 0,
      efficiencyMatch: 0,
      hotZone: 0,
    };

    // 司機位置
    const driverLocation: Location = {
      lat: driver.currentLat,
      lng: driver.currentLng,
    };
    const pickupLocation: Location = {
      lat: order.pickup.lat,
      lng: order.pickup.lng,
    };

    // 1. 獲取 ETA
    let etaResult;
    try {
      const etaService = getETAService();
      etaResult = await etaService.getETA(driverLocation, pickupLocation);
    } catch (error) {
      // 回退到簡單估算
      const distanceKm = this.calculateDistance(driverLocation, pickupLocation);
      etaResult = {
        seconds: Math.ceil(distanceKm * 1.3 / 25 * 3600),
        distanceMeters: distanceKm * 1000,
        source: 'ESTIMATED' as const,
      };
    }

    const distanceKm = etaResult.distanceMeters / 1000;
    const etaMinutes = etaResult.seconds / 60;

    // 2. 距離評分（越近越高，滿分 100）
    components.distance = Math.max(0, 100 - distanceKm * 10);

    // 3. ETA 評分（越快越高，滿分 100）
    components.eta = Math.max(0, 100 - etaMinutes * 5);

    // 4. 收入平衡評分
    const todayEarnings = await this.getDriverTodayEarnings(driver.driverId);
    const avgEarnings = 8500;
    if (todayEarnings < avgEarnings) {
      components.earningsBalance = 100 * (1 - todayEarnings / avgEarnings);
    }

    // 5. 預測接單率評分
    let rejectionProbability = 0;
    try {
      const predictor = getRejectionPredictor();
      const features: PredictionFeatures = {
        distanceToPickup: distanceKm,
        tripDistance: order.destination
          ? this.calculateDistance(order.pickup, order.destination)
          : 5,
        estimatedFare: order.estimatedFare || 200,
        hourOfDay: currentHour,
        dayOfWeek: new Date().getDay(),
        isHoliday: false,
        driverTodayEarnings: todayEarnings,
        driverTodayTrips: driver.todayTrips || 0,
        driverOnlineHours: driver.onlineHours || 0,
        driverAcceptanceRate: driver.acceptanceRate || 80,
      };
      rejectionProbability = await predictor.predict(driver.driverId, features);
      components.acceptancePrediction = 100 * (1 - rejectionProbability);
    } catch (error) {
      // 使用歷史接單率
      components.acceptancePrediction = driver.acceptanceRate || 80;
      rejectionProbability = 1 - (driver.acceptanceRate || 80) / 100;
    }

    // 6. 效率匹配評分
    const tripDistance = order.destination
      ? this.calculateDistance(order.pickup, order.destination)
      : 5;
    const driverType = driver.driverType || 'HIGH_VOLUME';
    let tripType: 'SHORT_TRIP' | 'MEDIUM_TRIP' | 'LONG_TRIP' = 'MEDIUM_TRIP';
    if (tripDistance < 3) tripType = 'SHORT_TRIP';
    else if (tripDistance > 10) tripType = 'LONG_TRIP';

    const efficiencyScore = CONFIG.EFFICIENCY_SCORES[tripType][driverType as keyof typeof CONFIG.EFFICIENCY_SCORES.SHORT_TRIP] || 10;
    components.efficiencyMatch = efficiencyScore * 100 / 15;

    // 7. 熱區評分
    if (this.isInHotZone(order.pickup.lat, order.pickup.lng, currentHour)) {
      components.hotZone = 100;
    }

    // 計算加權總分
    const totalScore =
      components.distance * weights.distance +
      components.eta * weights.eta +
      components.earningsBalance * weights.earningsBalance +
      components.acceptancePrediction * weights.acceptancePrediction +
      components.efficiencyMatch * weights.efficiencyMatch +
      components.hotZone * weights.hotZone;

    // 生成派單原因
    const reason = this.generateDispatchReason(components);

    return {
      driverId: driver.driverId,
      driverName: driver.name,
      totalScore,
      components,
      etaSeconds: etaResult.seconds,
      etaSource: etaResult.source,
      distanceKm,
      rejectionProbability,
      reason,
    };
  }

  // ============================================
  // 事件處理
  // ============================================

  /**
   * 處理司機接單
   */
  async handleDriverAccept(orderId: string, driverId: string): Promise<boolean> {
    const state = this.activeOrders.get(orderId);
    if (!state || state.status !== 'DISPATCHING') {
      console.log(`[SmartDispatcherV2] 訂單 ${orderId} 已被處理`);
      return false;
    }

    console.log(`[SmartDispatcherV2] 司機 ${driverId} 接受訂單 ${orderId}`);

    // 更新狀態
    state.status = 'ACCEPTED';
    state.acceptedBy = driverId;

    // 清除計時器
    if (state.batchTimeoutTimer) clearTimeout(state.batchTimeoutTimer);
    if (state.orderTimeoutTimer) clearTimeout(state.orderTimeoutTimer);

    // 更新當前批次結果
    const currentBatch = state.batches[state.batches.length - 1];
    if (currentBatch) {
      currentBatch.acceptedBy = driverId;
      currentBatch.endedAt = Date.now();
    }

    // 記錄接單到派單日誌
    await this.updateDispatchLogAccepted(orderId, driverId, currentBatch?.startedAt);

    // 通知其他司機訂單已被接走
    const io = getSocketIO();
    for (const offeredDriverId of state.allOfferedDriverIds) {
      if (offeredDriverId !== driverId) {
        const socketId = driverSockets.get(offeredDriverId);
        if (socketId) {
          io.to(socketId).emit('order:taken', {
            orderId,
            message: '此訂單已被其他司機接走',
          });
        }
      }
    }

    // 從活動訂單移除
    this.activeOrders.delete(orderId);

    return true;
  }

  /**
   * 處理司機拒單
   */
  async handleDriverReject(
    orderId: string,
    driverId: string,
    reason: string,
    detailedReason?: string
  ): Promise<{
    success: boolean;
    reDispatched: boolean;
    nextBatch: number;
    message: string;
  }> {
    const state = this.activeOrders.get(orderId);
    if (!state || state.status !== 'DISPATCHING') {
      return {
        success: false,
        reDispatched: false,
        nextBatch: 0,
        message: '訂單已被處理',
      };
    }

    console.log(`[SmartDispatcherV2] 司機 ${driverId} 拒絕訂單 ${orderId}, 原因: ${reason}`);

    // 記錄拒單
    state.allRejectedDriverIds.add(driverId);

    const currentBatch = state.batches[state.batches.length - 1];
    if (currentBatch) {
      currentBatch.rejectedBy.push(driverId);
    }

    // 記錄拒單詳情
    await this.logRejection(orderId, driverId, reason, state.order);

    // 更新司機行為模式
    try {
      const predictor = getRejectionPredictor();
      await predictor.updateDriverPattern(driverId);
    } catch (error) {
      // 忽略錯誤
    }

    // 檢查當前批次是否全部回應
    const currentBatchOffered = currentBatch?.offeredDriverIds || [];
    const responded = [
      ...currentBatch?.rejectedBy || [],
      ...currentBatch?.timedOutDriverIds || [],
    ];

    const allResponded = currentBatchOffered.every(
      id => responded.includes(id) || state.acceptedBy === id
    );

    if (allResponded) {
      // 清除批次超時
      if (state.batchTimeoutTimer) {
        clearTimeout(state.batchTimeoutTimer);
      }

      // 檢查是否達到最大批次
      if (state.currentBatch >= CONFIG.MAX_BATCHES) {
        await this.handleNoDriversAvailable(orderId, 'MAX_BATCHES');
        return {
          success: true,
          reDispatched: false,
          nextBatch: 0,
          message: '達到最大派單批次',
        };
      }

      // 執行下一批
      const result = await this.executeBatch(orderId);
      return {
        success: true,
        reDispatched: result.offeredDriverIds.length > 0,
        nextBatch: result.batchNumber,
        message: result.offeredDriverIds.length > 0
          ? `已派發給第 ${result.batchNumber} 批司機`
          : '無更多可用司機',
      };
    }

    return {
      success: true,
      reDispatched: false,
      nextBatch: state.currentBatch,
      message: '等待其他司機回應',
    };
  }

  /**
   * 處理批次超時
   */
  private async handleBatchTimeout(orderId: string, batchNumber: number): Promise<void> {
    const state = this.activeOrders.get(orderId);
    if (!state || state.status !== 'DISPATCHING' || state.currentBatch !== batchNumber) {
      return;
    }

    console.log(`[SmartDispatcherV2] 第 ${batchNumber} 批超時`);

    const currentBatch = state.batches[batchNumber - 1];
    if (currentBatch) {
      currentBatch.endedAt = Date.now();

      // 找出未回應的司機
      const responded = new Set([
        ...currentBatch.rejectedBy,
        currentBatch.acceptedBy,
      ].filter(Boolean));

      for (const driverId of currentBatch.offeredDriverIds) {
        if (!responded.has(driverId)) {
          currentBatch.timedOutDriverIds.push(driverId);
          state.allTimedOutDriverIds.add(driverId);

          // 通知司機超時
          const socketId = driverSockets.get(driverId);
          if (socketId) {
            const io = getSocketIO();
            io.to(socketId).emit('order:batch-timeout', {
              orderId,
              message: '回應時間已過，訂單已轉派給其他司機',
            });
          }
        }
      }
    }

    // 檢查是否達到最大批次
    if (state.currentBatch >= CONFIG.MAX_BATCHES) {
      await this.handleNoDriversAvailable(orderId, 'MAX_BATCHES');
      return;
    }

    // 執行下一批
    await this.executeBatch(orderId);
  }

  /**
   * 處理訂單總超時
   */
  private async handleOrderTimeout(orderId: string): Promise<void> {
    const state = this.activeOrders.get(orderId);
    if (!state || state.status !== 'DISPATCHING') {
      return;
    }

    console.log(`[SmartDispatcherV2] 訂單 ${orderId} 總超時`);

    await this.handleNoDriversAvailable(orderId, 'TIMEOUT');
  }

  /**
   * 處理無司機可用
   */
  private async handleNoDriversAvailable(
    orderId: string,
    reason: 'NO_DRIVERS' | 'ALL_REJECTED' | 'MAX_BATCHES' | 'TIMEOUT'
  ): Promise<void> {
    const state = this.activeOrders.get(orderId);
    if (!state) return;

    console.log(`[SmartDispatcherV2] 訂單 ${orderId} 失敗: ${reason}`);

    // 更新狀態
    state.status = 'CANCELLED';

    // 清除計時器
    if (state.batchTimeoutTimer) clearTimeout(state.batchTimeoutTimer);
    if (state.orderTimeoutTimer) clearTimeout(state.orderTimeoutTimer);

    // 更新資料庫
    const cancelReason = {
      NO_DRIVERS: '目前沒有可用司機',
      ALL_REJECTED: '所有司機都已拒絕',
      MAX_BATCHES: '超過最大派單次數',
      TIMEOUT: '派單超時',
    }[reason];

    await this.pool.query(
      `UPDATE orders
       SET status = 'CANCELLED',
           cancelled_at = CURRENT_TIMESTAMP,
           cancel_reason = $1
       WHERE order_id = $2`,
      [cancelReason, orderId]
    );

    // 通知乘客
    this.notifyPassengerDispatchProgress(state.order.passengerId, {
      orderId,
      status: 'CANCELLED',
      dispatchStatus: 'FAILED',
      currentBatch: state.currentBatch,
      offeredToCount: state.allOfferedDriverIds.size,
      message: cancelReason,
      cancelReason,
    });

    // 從活動訂單移除
    this.activeOrders.delete(orderId);
  }

  // ============================================
  // 輔助方法
  // ============================================

  /**
   * 獲取可用司機
   */
  private async getAvailableDrivers(excludeDrivers: Set<string>): Promise<any[]> {
    // 從內存獲取在線司機
    const onlineDriverIds = Array.from(driverSockets.keys()).filter(
      id => !excludeDrivers.has(id)
    );

    if (onlineDriverIds.length === 0) {
      return [];
    }

    // 從資料庫獲取司機詳細資訊
    const result = await this.pool.query(`
      SELECT
        d.driver_id,
        d.name,
        d.phone,
        d.plate,
        d.availability,
        d.current_lat,
        d.current_lng,
        d.acceptance_rate,
        d.driver_type,
        COALESCE(de.total_trips, 0) as today_trips,
        COALESCE(de.online_hours, 0) as online_hours
      FROM drivers d
      LEFT JOIN daily_earnings de ON d.driver_id = de.driver_id AND de.date = CURRENT_DATE
      WHERE d.driver_id = ANY($1)
        AND d.availability IN ('AVAILABLE', 'REST')
    `, [onlineDriverIds]);

    // 補充實時位置
    return result.rows.map(row => {
      const realtimeLocation = driverLocations.get(row.driver_id);
      return {
        driverId: row.driver_id,
        name: row.name,
        phone: row.phone,
        plate: row.plate,
        currentLat: realtimeLocation?.lat || parseFloat(row.current_lat) || 23.9933,
        currentLng: realtimeLocation?.lng || parseFloat(row.current_lng) || 121.6011,
        acceptanceRate: parseFloat(row.acceptance_rate) || 80,
        driverType: row.driver_type || 'HIGH_VOLUME',
        todayTrips: parseInt(row.today_trips) || 0,
        onlineHours: parseFloat(row.online_hours) || 0,
      };
    });
  }

  /**
   * 獲取司機今日收入
   */
  private async getDriverTodayEarnings(driverId: string): Promise<number> {
    // 檢查快取
    const cached = this.driverEarningsCache.get(driverId);
    if (cached && Date.now() - cached.updatedAt < 600000) { // 10 分鐘
      return cached.earnings;
    }

    const result = await this.pool.query(
      `SELECT COALESCE(SUM(meter_amount), 0) as earnings
       FROM orders
       WHERE driver_id = $1
         AND status = 'DONE'
         AND DATE(completed_at) = CURRENT_DATE`,
      [driverId]
    );

    const earnings = parseInt(result.rows[0].earnings) || 0;

    // 存入快取
    this.driverEarningsCache.set(driverId, {
      earnings,
      updatedAt: Date.now(),
    });

    return earnings;
  }

  /**
   * 判斷是否在熱區
   */
  private isInHotZone(lat: number, lng: number, hour: number): boolean {
    for (const [, zone] of Object.entries(CONFIG.HOT_ZONES)) {
      const distance = this.calculateDistance(
        { lat, lng },
        { lat: zone.lat, lng: zone.lng }
      );
      if (distance <= zone.radius && zone.peakHours.includes(hour)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 計算距離（Haversine）
   */
  private calculateDistance(origin: Location | { lat: number; lng: number }, dest: Location | { lat: number; lng: number }): number {
    const R = 6371;
    const dLat = this.toRadians(dest.lat - origin.lat);
    const dLng = this.toRadians(dest.lng - origin.lng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(origin.lat)) *
        Math.cos(this.toRadians(dest.lat)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * 生成派單原因
   */
  private generateDispatchReason(components: DriverScore['components']): string {
    const reasons: string[] = [];

    if (components.distance > 70) reasons.push('距離最近');
    if (components.eta > 70) reasons.push('預估到達快');
    if (components.earningsBalance > 50) reasons.push('收入平衡');
    if (components.acceptancePrediction > 80) reasons.push('接單率高');
    if (components.efficiencyMatch > 80) reasons.push('效率匹配');
    if (components.hotZone > 0) reasons.push('熱區優先');

    return reasons.length > 0 ? reasons.join(' + ') : '綜合評分最高';
  }

  /**
   * 通知乘客派單進度
   */
  private notifyPassengerDispatchProgress(passengerId: string, data: any): void {
    const socketId = passengerSockets.get(passengerId);
    if (socketId) {
      const io = getSocketIO();
      io.to(socketId).emit('order:update', data);
    }
  }

  // ============================================
  // 日誌記錄
  // ============================================

  /**
   * 記錄派單決策
   */
  private async logDispatchDecision(
    orderId: string,
    batchNumber: number,
    drivers: DriverScore[]
  ): Promise<void> {
    const hour = new Date().getHours();
    const dayOfWeek = new Date().getDay();

    const recommendedDrivers = drivers.map(d => ({
      driverId: d.driverId,
      score: d.totalScore,
      etaSeconds: d.etaSeconds,
      reason: d.reason,
      rejectionProbability: d.rejectionProbability,
    }));

    try {
      await this.pool.query(
        `INSERT INTO dispatch_logs
         (order_id, batch_number, recommended_drivers, weight_config, hour_of_day, day_of_week)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          orderId,
          batchNumber,
          JSON.stringify(recommendedDrivers),
          JSON.stringify(CONFIG.WEIGHTS),
          hour,
          dayOfWeek,
        ]
      );
    } catch (error) {
      console.error('[SmartDispatcherV2] 記錄派單決策失敗:', error);
    }
  }

  /**
   * 更新派單日誌（接單）
   */
  private async updateDispatchLogAccepted(
    orderId: string,
    driverId: string,
    startedAt?: number
  ): Promise<void> {
    const responseTime = startedAt ? Date.now() - startedAt : null;

    try {
      await this.pool.query(
        `UPDATE dispatch_logs
         SET accepted_by = $1,
             accepted_at = CURRENT_TIMESTAMP,
             response_time_ms = $2
         WHERE order_id = $3
         ORDER BY batch_number DESC
         LIMIT 1`,
        [driverId, responseTime, orderId]
      );
    } catch (error) {
      console.error('[SmartDispatcherV2] 更新派單日誌失敗:', error);
    }
  }

  /**
   * 記錄拒單詳情
   */
  private async logRejection(
    orderId: string,
    driverId: string,
    reason: string,
    order: OrderData
  ): Promise<void> {
    const hour = new Date().getHours();
    const driverLocation = driverLocations.get(driverId);
    const todayEarnings = await this.getDriverTodayEarnings(driverId);

    let distanceToPickup = 0;
    if (driverLocation) {
      distanceToPickup = this.calculateDistance(
        { lat: driverLocation.lat, lng: driverLocation.lng },
        order.pickup
      );
    }

    const tripDistance = order.destination
      ? this.calculateDistance(order.pickup, order.destination)
      : null;

    try {
      await this.pool.query(
        `INSERT INTO order_rejections
         (order_id, driver_id, rejection_reason, distance_to_pickup, trip_distance,
          estimated_fare, hour_of_day, driver_today_earnings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          orderId,
          driverId,
          reason,
          distanceToPickup,
          tripDistance,
          order.estimatedFare,
          hour,
          todayEarnings,
        ]
      );

      // 更新訂單的 reject_count
      await this.pool.query(
        `UPDATE orders SET reject_count = reject_count + 1 WHERE order_id = $1`,
        [orderId]
      );
    } catch (error) {
      console.error('[SmartDispatcherV2] 記錄拒單失敗:', error);
    }
  }

  /**
   * 清理快取
   */
  private cleanupCaches(): void {
    const now = Date.now();

    // 清理收入快取（超過 1 小時）
    for (const [key, value] of this.driverEarningsCache.entries()) {
      if (now - value.updatedAt > 3600000) {
        this.driverEarningsCache.delete(key);
      }
    }

    // 清理統計快取
    for (const [key, value] of this.driverStatsCache.entries()) {
      if (now - value.updatedAt > 3600000) {
        this.driverStatsCache.delete(key);
      }
    }
  }

  /**
   * 獲取活動訂單統計
   */
  getActiveOrdersStats(): {
    count: number;
    orders: Array<{
      orderId: string;
      status: string;
      currentBatch: number;
      offeredCount: number;
      rejectedCount: number;
    }>;
  } {
    const orders = Array.from(this.activeOrders.entries()).map(([orderId, state]) => ({
      orderId,
      status: state.status,
      currentBatch: state.currentBatch,
      offeredCount: state.allOfferedDriverIds.size,
      rejectedCount: state.allRejectedDriverIds.size,
    }));

    return {
      count: orders.length,
      orders,
    };
  }
}

// ============================================
// 單例
// ============================================

let dispatcherInstance: SmartDispatcherV2 | null = null;

export function initSmartDispatcherV2(pool: Pool): SmartDispatcherV2 {
  if (!dispatcherInstance) {
    dispatcherInstance = new SmartDispatcherV2(pool);
    console.log('[SmartDispatcherV2] 初始化完成');
  }
  return dispatcherInstance;
}

export function getSmartDispatcherV2(): SmartDispatcherV2 {
  if (!dispatcherInstance) {
    throw new Error('[SmartDispatcherV2] 尚未初始化，請先呼叫 initSmartDispatcherV2()');
  }
  return dispatcherInstance;
}

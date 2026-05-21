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
import { getFcmService } from './FcmService';
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
import { getAutoAcceptService, AutoAcceptService } from './AutoAcceptService';
import { getHotZoneQuotaService, HotZoneQuotaService, ZoneCheckResult, QueueEntry } from './HotZoneQuotaService';
import { isOnShift } from './ShiftChecker';
import { queueZoneResolver } from './QueueZoneResolver';
import { queueOrderingService } from './QueueOrderingService';
import { fareConfigService } from './FareConfigService';

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
  // 電話叫車擴展欄位
  source?: string;           // PHONE/APP/LINE
  subsidyType?: string;      // SENIOR_CARD/LOVE_CARD/PENDING/NONE
  petPresent?: string;       // YES/NO/UNKNOWN
  petCarrier?: string;       // YES/NO/UNKNOWN
  customerPhone?: string;    // 來電號碼
  // GoGoCha 媒合擴展
  discountAmount?: number;             // 客人答應給的折扣 NT$ 元 (0/10/20/30/40)
  preferredFleetPartnerId?: string | null;  // 優先派此 fleet 的司機（LINE 官方/電話來源）
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
  // 自動接單擴展
  autoAcceptScore?: number;
  autoAcceptAllowed?: boolean;
  autoAcceptBlockReason?: string;
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
  status: 'DISPATCHING' | 'ACCEPTED' | 'CANCELLED' | 'TIMEOUT' | 'QUEUED';
  currentBatch: number;
  batches: BatchResult[];
  allOfferedDriverIds: Set<string>;
  allRejectedDriverIds: Set<string>;
  allTimedOutDriverIds: Set<string>;
  acceptedBy?: string;
  createdAt: number;
  orderTimeoutTimer?: NodeJS.Timeout;
  batchTimeoutTimer?: NodeJS.Timeout;
  // 熱區配額擴展
  hotZoneQuota?: ZoneCheckResult;
  queuePosition?: number;
  // Queue Priority Layer：訂單 pickup 落在某 zone 時，第一批先派 queue 司機
  queueZoneId?: string;
  queueDriverIds?: string[];  // 待派 queue 司機 ID list（已排序：rebate>FIFO>距離）

  // 每位司機收到的最後一次 orderOffer payload（給 socket reconnect 後 replay 用）
  // key = driverId, value = order:offer 完整 payload
  perDriverOffers?: Map<string, any>;
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

  // 第 N 批的最大半徑（km）— 累進式：batch 1 只考慮 ≤2km 的司機，batch 2 ≤3km，依此類推。
  // 為什麼累進不分段：邏輯簡單、不會「漏人」（近的司機沒接 batch 1，batch 2 仍在候選池）。
  // 偏遠訂單前幾批可能候選池為空也沒關係，會自動往後批延伸到更大半徑。
  BATCH_RADIUS_KM: [2, 3, 5, 8, 15],

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
  private queuedOrders: Map<string, OrderDispatchState> = new Map(); // 排隊中的訂單

  // 快取
  private driverEarningsCache: Map<string, { earnings: number; updatedAt: number }> = new Map();
  private driverStatsCache: Map<string, { stats: any; updatedAt: number }> = new Map();

  // 服務
  private autoAcceptService: AutoAcceptService | null = null;
  private hotZoneQuotaService: HotZoneQuotaService | null = null;
  private rejectionPredictor: RejectionPredictor | null = null;

  constructor(pool: Pool) {
    this.pool = pool;

    // 延遲初始化服務
    this.initServices();

    // 每小時清理快取
    setInterval(() => this.cleanupCaches(), 3600000);

    // 每 10 秒檢查排隊訂單
    setInterval(() => this.processQueuedOrders(), 10000);
  }

  private initServices(): void {
    try {
      this.rejectionPredictor = new RejectionPredictor(this.pool);
      this.autoAcceptService = getAutoAcceptService(this.pool, this.rejectionPredictor);
      this.hotZoneQuotaService = getHotZoneQuotaService(this.pool);
      console.log('[SmartDispatcherV2] 服務初始化完成 (AutoAccept + HotZoneQuota)');
    } catch (error) {
      console.error('[SmartDispatcherV2] 服務初始化失敗:', error);
    }
  }

  // ============================================
  // 主要派單流程
  // ============================================

  /**
   * 開始派單（入口方法）
   * 整合熱區配額檢查 - 配額滿時加入排隊
   */
  async startDispatch(order: OrderData): Promise<{
    success: boolean;
    message: string;
    batchNumber: number;
    offeredTo: string[];
    hotZoneInfo?: {
      isHotZone: boolean;
      zoneName?: string;
      surgeMultiplier?: number;
      queuePosition?: number;
      estimatedWait?: number;
    };
  }> {
    console.log(`\n[SmartDispatcherV2] 開始派單 - 訂單 ${order.orderId}`);

    // === 黑名單檢查（Phase 2）===
    // 黑名單客戶的訂單直接拒絕派單，不浪費司機時間
    try {
      const blacklistCheck = await this.pool.query(
        'SELECT is_blacklisted, blacklist_reason FROM passengers WHERE passenger_id = $1',
        [order.passengerId]
      );
      if (blacklistCheck.rows[0]?.is_blacklisted === true) {
        const reason = blacklistCheck.rows[0]?.blacklist_reason || '黑名單客戶';
        console.warn(`[SmartDispatcherV2] 黑名單客戶嘗試叫車 - 訂單 ${order.orderId} (${order.passengerId}): ${reason}`);

        // 將訂單立刻設為 CANCELLED 並記錄原因
        await this.pool.query(
          `UPDATE orders SET status = 'CANCELLED',
                             cancelled_at = CURRENT_TIMESTAMP,
                             cancel_reason = $1
           WHERE order_id = $2`,
          [`黑名單客戶：${reason}`, order.orderId]
        );

        // 通知乘客（雖然是黑名單，仍給友善訊息）
        this.notifyPassengerDispatchProgress(order.passengerId, {
          orderId: order.orderId,
          status: 'CANCELLED',
          message: '無法為您派單，請聯繫客服',
          cancelReason: '無法為您派單，請聯繫客服',
        });

        return {
          success: false,
          message: '無法為您派單，請聯繫客服',
          batchNumber: 0,
          offeredTo: [],
        };
      }
    } catch (err: any) {
      // 查詢失敗不阻擋派單（fail-open，避免 DB 抽風時所有人都叫不到車）
      console.error('[SmartDispatcherV2] 黑名單檢查失敗（fail-open，繼續派單）:', err.message);
    }

    // === 熱區配額檢查 ===
    let hotZoneQuota: ZoneCheckResult | undefined;
    // 用 getOrComputeFare 取代舊 `|| 200`（沒有 fare 時用 0 表示「不適用熱區加成」，不假裝有基本價）
    const estimatedFare = this.getOrComputeFare(order) ?? 0;
    if (this.hotZoneQuotaService) {
      try {
        hotZoneQuota = await this.hotZoneQuotaService.checkZoneAndQuota(
          order.pickup.lat,
          order.pickup.lng,
          estimatedFare
        );

        if (hotZoneQuota.inHotZone && hotZoneQuota.zone) {
          const zoneName = hotZoneQuota.zone.zoneName;
          const zoneId = hotZoneQuota.zone.zoneId;
          console.log(`[SmartDispatcherV2] 熱區偵測: ${zoneName}`);
          console.log(`  配額使用: ${hotZoneQuota.quotaStatus?.quotaUsed || 0}/${hotZoneQuota.quotaStatus?.quotaLimit || 0}`);
          console.log(`  加成倍率: ${hotZoneQuota.surgeMultiplier}x`);

          // 配額已滿 -> 進入排隊
          if (hotZoneQuota.action === 'QUEUE') {
            console.log(`[SmartDispatcherV2] 配額已滿，訂單進入排隊`);

            const queueResult = await this.hotZoneQuotaService.enqueue(
              zoneId,
              order.orderId,
              order.passengerId,
              estimatedFare
            );

            // 建立排隊狀態
            const queuedState: OrderDispatchState = {
              order,
              status: 'QUEUED',
              currentBatch: 0,
              batches: [],
              allOfferedDriverIds: new Set(),
              allRejectedDriverIds: new Set(),
              allTimedOutDriverIds: new Set(),
              createdAt: Date.now(),
              hotZoneQuota,
              queuePosition: queueResult.queuePosition,
            };

            this.queuedOrders.set(order.orderId, queuedState);

            // 通知乘客進入排隊
            this.notifyPassengerDispatchProgress(order.passengerId, {
              orderId: order.orderId,
              dispatchStatus: 'QUEUED',
              queuePosition: queueResult.queuePosition,
              estimatedWait: queueResult.estimatedWaitMinutes,
              message: `您在${zoneName}的排隊位置: 第 ${queueResult.queuePosition} 位`,
              hotZoneInfo: {
                isHotZone: true,
                zoneName: zoneName,
                surgeMultiplier: hotZoneQuota.surgeMultiplier,
              },
            });

            return {
              success: true,
              message: `訂單已加入${zoneName}排隊，位置: 第 ${queueResult.queuePosition} 位`,
              batchNumber: 0,
              offeredTo: [],
              hotZoneInfo: {
                isHotZone: true,
                zoneName: zoneName,
                surgeMultiplier: hotZoneQuota.surgeMultiplier,
                queuePosition: queueResult.queuePosition,
                estimatedWait: queueResult.estimatedWaitMinutes,
              },
            };
          }

          // 配額可用，消費配額
          await this.hotZoneQuotaService.consumeQuota(
            zoneId,
            order.orderId,
            estimatedFare,
            hotZoneQuota.surgeMultiplier
          );
        }
      } catch (error) {
        console.error('[SmartDispatcherV2] 熱區配額檢查失敗:', error);
        // 繼續派單，不阻斷流程
      }
    }

    // ============================================
    // Queue Priority Layer：判斷上車點是否落在排班區
    // 命中 → 第一批派 queue 司機；queue 全拒/超時自然 fallback 既有評分派遣
    // ============================================
    let queueZoneId: string | undefined;
    let queueDriverIds: string[] | undefined;
    try {
      const zone = await queueZoneResolver.resolveZone(order.pickup.lat, order.pickup.lng);
      if (zone) {
        const orderDiscountAmount = order.discountAmount ?? 0;
        const candidates = await queueOrderingService.getQueueDriversForOrder(
          zone.zone_id,
          orderDiscountAmount,
          order.pickup.lat,
          order.pickup.lng,
        );
        if (candidates.length > 0) {
          queueZoneId = zone.zone_id;
          queueDriverIds = candidates.map(c => c.driver_id);
          console.log(`[QueuePriority] 訂單 ${order.orderId} 落在 zone "${zone.name}"，使用 ${queueDriverIds.length} 位 queue 司機`);
          // 標記 orders 表 dispatch_type='QUEUE'
          await this.pool.query(
            `UPDATE orders SET dispatch_type = 'QUEUE', dispatched_from_zone = $1 WHERE order_id = $2`,
            [zone.zone_id, order.orderId]
          );
        } else {
          console.log(`[QueuePriority] 訂單 ${order.orderId} 在 zone "${zone.name}" 但無合資格司機，fallback 一般派遣`);
        }
      }
    } catch (e: any) {
      // Queue 失敗不擋一般派遣
      console.error('[QueuePriority] resolveZone 失敗，fallback 一般派遣:', e.message);
    }

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
      hotZoneQuota,
      queueZoneId,
      queueDriverIds,
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
      hotZoneInfo: hotZoneQuota?.inHotZone ? {
        isHotZone: true,
        zoneName: hotZoneQuota.zone?.zoneName,
        surgeMultiplier: hotZoneQuota.surgeMultiplier,
      } : undefined,
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

    // 距離 bucket：第 N 批用 BATCH_RADIUS_KM[N-1]（累進）
    const maxRadiusKm = CONFIG.BATCH_RADIUS_KM[batchNumber - 1] ?? CONFIG.BATCH_RADIUS_KM[CONFIG.BATCH_RADIUS_KM.length - 1];

    // 排除已試過的司機
    const excludeDrivers = new Set([
      ...state.allOfferedDriverIds,
      ...state.allRejectedDriverIds,
      ...state.allTimedOutDriverIds,
    ]);

    // ============================================
    // Queue Priority：若 state.queueDriverIds 還有人，本批優先派 queue 司機
    // queue 全部派完/全拒/全超時 → state.queueDriverIds 變空 → 自然 fallback 評分派遣
    // ============================================
    let selectedDrivers: DriverScore[] = [];
    if (state.queueDriverIds && state.queueDriverIds.length > 0) {
      // 取下一批 queue 司機（已排序好，不再評分）
      const queueBatch = state.queueDriverIds
        .filter(id => !excludeDrivers.has(id))
        .slice(0, CONFIG.BATCH_SIZE);

      if (queueBatch.length > 0) {
        console.log(`[SmartDispatcherV2] 第 ${batchNumber} 批走 Queue 模式（zone=${state.queueZoneId}, 候選 ${queueBatch.length} 位）`);
        // 把 queue 司機 ID 包成 DriverScore 結構（部分欄位用預設）
        // 簡化：直接 query 補齊必要欄位
        const driverDetails = await this.pool.query(
          `SELECT driver_id, name, phone, plate, current_lat, current_lng
           FROM drivers WHERE driver_id = ANY($1)`,
          [queueBatch]
        );
        const detailMap = new Map(driverDetails.rows.map((r: any) => [r.driver_id, r]));

        selectedDrivers = queueBatch
          .map(id => {
            const d = detailMap.get(id);
            if (!d) return null;
            const score: DriverScore = {
              driverId: id,
              driverName: d.name || '',
              currentLocation: {
                lat: d.current_lat ? parseFloat(d.current_lat) : 0,
                lng: d.current_lng ? parseFloat(d.current_lng) : 0,
              } as any,
              distanceKm: 0,
              etaMinutes: 0,
              etaSeconds: 0,
              etaSource: 'QUEUE' as any,
              components: {
                distance: 100, eta: 100, earningsBalance: 0,
                acceptancePrediction: 0, efficiencyMatch: 0, hotZone: 0,
              } as any,
              totalScore: 100,  // queue 司機本質上就是「最佳」，不走評分
              rejectionProbability: 0,
              reason: 'QUEUE_PRIORITY',
            } as DriverScore;
            return score;
          })
          .filter((x): x is DriverScore => x !== null);

        // 從 queueDriverIds 移除本批已派的
        state.queueDriverIds = state.queueDriverIds.filter(id => !queueBatch.includes(id));
      } else {
        // queue 司機都被 exclude（已試過/拒/超時）→ queue 失效，clear 之後 fallback
        console.log(`[SmartDispatcherV2] Queue 司機都被排除，fallback 評分派遣`);
        state.queueDriverIds = [];
      }
    }

    // Queue 沒有結果 → fallback 既有評分派遣（依 batchNumber 半徑 bucket）
    if (selectedDrivers.length === 0) {
      console.log(`[SmartDispatcherV2] 執行第 ${batchNumber} 批派單（半徑 ${maxRadiusKm} km，評分模式）`);
      selectedDrivers = await this.selectBestDrivers(
        state.order,
        CONFIG.BATCH_SIZE,
        excludeDrivers,
        maxRadiusKm
      );
    }

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
        // 計算最終車資（含熱區加成）— baseFare 可能是 undefined（純電話叫車無目的地）
        const baseFare = this.getOrComputeFare(state.order);
        const surgeMultiplier = state.hotZoneQuota?.surgeMultiplier || 1.0;
        const finalFare = baseFare !== undefined ? Math.round(baseFare * surgeMultiplier) : undefined;

        const orderOffer = {
          orderId: state.order.orderId,
          passengerId: state.order.passengerId,
          passengerName: state.order.passengerName,
          passengerPhone: state.order.passengerPhone,
          pickup: state.order.pickup,
          destination: state.order.destination,
          paymentType: state.order.paymentType,
          // Android 端需要此欄位判斷訂單狀態，缺少時預設 WAITING 導致訂單卡不顯示
          status: 'OFFERED',
          // 派單資訊
          batchNumber,
          estimatedFare: baseFare,
          finalFare,
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
          // 熱區資訊
          hotZone: state.hotZoneQuota?.inHotZone ? {
            zoneName: state.hotZoneQuota.zone?.zoneName,
            surgeMultiplier: state.hotZoneQuota.surgeMultiplier,
          } : null,
          // 自動接單資訊
          autoAccept: {
            score: driver.autoAcceptScore || 0,
            allowed: driver.autoAcceptAllowed || false,
            blockReason: driver.autoAcceptBlockReason || null,
          },
          // 電話叫車欄位
          source: state.order.source || 'APP',
          subsidyType: state.order.subsidyType || 'NONE',
          petPresent: state.order.petPresent || 'UNKNOWN',
          petCarrier: state.order.petCarrier || 'UNKNOWN',
          customerPhone: state.order.customerPhone || null,
          destinationConfirmed: false,
        };

        console.log(`[SmartDispatcherV2] ✅ 推送 order:offer 給司機 ${driver.driverId} (socket: ${socketId})`);
        // 存 payload 供 socket reconnect 時 replay
        if (!state.perDriverOffers) state.perDriverOffers = new Map();
        state.perDriverOffers.set(driver.driverId, orderOffer);
        io.to(socketId).emit('order:offer', orderOffer);

        // 並行送 FCM 給該司機（背景叫醒）
        const fcm = getFcmService();
        fcm?.sendNewOrderToDriver(driver.driverId, {
          orderId: orderOffer.orderId,
          passengerName: orderOffer.passengerName || '乘客',
          passengerPhone: orderOffer.passengerPhone,
          pickup: typeof orderOffer.pickup === 'string' ? orderOffer.pickup : (orderOffer.pickup?.address || '未知地點'),
        }).catch((e: Error) => console.error('[FCM] dispatch 推播失敗:', e.message));

        // 記錄自動接單決策
        if (this.autoAcceptService && driver.autoAcceptScore !== undefined) {
          const decision = {
            decision: driver.autoAcceptAllowed ? 'AUTO_ACCEPT' : (driver.autoAcceptBlockReason ? 'BLOCKED' : 'MANUAL'),
            orderId: state.order.orderId,
            driverId: driver.driverId,
            score: driver.autoAcceptScore,
            threshold: 70, // 預設閾值
            blockReason: driver.autoAcceptBlockReason || undefined,
          } as const;
          const orderFeatures = {
            pickupDistanceKm: driver.distanceKm,
            estimatedFare: this.getOrComputeFare(state.order) ?? 0,
            tripDistanceKm: state.order.destination
              ? this.calculateDistance(state.order.pickup, state.order.destination)
              : 5,
            hourOfDay: new Date().getHours(),
            zoneName: state.hotZoneQuota?.zone?.zoneName,
          };
          this.autoAcceptService.logDecision(decision, orderFeatures)
            .catch(err => console.error('[SmartDispatcherV2] 記錄自動接單決策失敗:', err));
        }

        console.log(`  -> 推送給司機 ${driver.driverId} (${driver.driverName}), 評分: ${driver.totalScore.toFixed(1)}, 自動接單: ${driver.autoAcceptAllowed ? '✓' : '✗'}`);
        state.allOfferedDriverIds.add(driver.driverId);
      } else {
        console.error(`[SmartDispatcherV2] ❌ 司機 ${driver.driverId} socket 不存在，無法推送`);
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
   * @param maxRadiusKm 距離 bucket 上限（累進式：第 N 批用 BATCH_RADIUS_KM[N-1]）。
   *                    超過此距離的司機本批不考慮，下一批會自動納入更大半徑。
   */
  private async selectBestDrivers(
    order: OrderData,
    count: number,
    excludeDrivers: Set<string>,
    maxRadiusKm?: number
  ): Promise<DriverScore[]> {
    const availableDrivers = await this.getAvailableDrivers(excludeDrivers, order);

    if (availableDrivers.length === 0) {
      return [];
    }

    console.log(`[SmartDispatcherV2] 評估 ${availableDrivers.length} 位可用司機（半徑限制: ${maxRadiusKm ?? '無'} km）`);

    // 計算所有司機的評分
    const scoredDrivers: DriverScore[] = [];

    for (const driver of availableDrivers) {
      const score = await this.calculateDriverScore(driver, order);

      // 半徑 bucket 過濾：超過本批最大半徑的司機跳過（下一批會自動納入）
      if (maxRadiusKm !== undefined && score.distanceKm > maxRadiusKm) {
        continue;
      }

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
        estimatedFare: this.getOrComputeFare(order) ?? 0,
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

    // === 計算自動接單分數 ===
    let autoAcceptScore = 0;
    let autoAcceptAllowed = false;
    let autoAcceptBlockReason: string | undefined = undefined;

    if (this.autoAcceptService) {
      try {
        // 準備 PredictionFeatures
        const driverFeatures: PredictionFeatures = {
          distanceToPickup: distanceKm,
          tripDistance: tripDistance,
          estimatedFare: this.getOrComputeFare(order) ?? 0,
          hourOfDay: currentHour,
          dayOfWeek: new Date().getDay(),
          isHoliday: false,
          driverTodayEarnings: todayEarnings,
          driverTodayTrips: driver.todayTrips || 0,
          driverOnlineHours: driver.onlineHours || 0,
          driverAcceptanceRate: driver.acceptanceRate || 80,
        };

        // 計算自動接單分數（返回 AutoAcceptScore 對象）
        const autoAcceptResult = await this.autoAcceptService.calculateAutoAcceptScore(
          driver.driverId,
          {
            pickupDistanceKm: distanceKm,
            tripDistanceKm: tripDistance,
            estimatedFare: this.getOrComputeFare(order) ?? 0,
            hourOfDay: currentHour,
            dayOfWeek: new Date().getDay(),
          },
          driverFeatures
        );

        autoAcceptScore = autoAcceptResult.score;
        autoAcceptAllowed = autoAcceptResult.allowAutoAccept;
        autoAcceptBlockReason = autoAcceptResult.blockReason;

        if (autoAcceptAllowed) {
          console.log(`    [AutoAccept] 司機 ${driver.driverId} 可自動接單，分數: ${autoAcceptScore.toFixed(1)}`);
        }
      } catch (error) {
        console.error(`[SmartDispatcherV2] 計算自動接單分數失敗 (${driver.driverId}):`, error);
      }
    }

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
      // 自動接單擴展
      autoAcceptScore,
      autoAcceptAllowed,
      autoAcceptBlockReason,
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

    // Queue 模式：標記司機 entry 為 LEFT (reason=ACCEPTED)
    if (state.queueZoneId) {
      try {
        await queueOrderingService.markDispatched(driverId);
      } catch (e: any) {
        console.error('[QueuePriority] markDispatched 失敗:', e.message);
      }
    }

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

    // Queue 模式：拒單司機移到隊尾（status 維持 ACTIVE，joined_at 更新為現在）
    if (state.queueZoneId) {
      try {
        await queueOrderingService.moveToTail(driverId);
        console.log(`[QueuePriority] 司機 ${driverId} 拒 queue 訂單，移至隊尾`);
      } catch (e: any) {
        console.error('[QueuePriority] moveToTail 失敗:', e.message);
      }
    }

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

    // ALL_REJECTED：所有司機拒絕但訂單仍有效，保持 OFFERED 讓司機可手動接單
    // 其他原因：真正取消
    const shouldCancel = reason !== 'ALL_REJECTED';

    // 更新狀態
    state.status = 'CANCELLED';

    // 清除計時器
    if (state.batchTimeoutTimer) clearTimeout(state.batchTimeoutTimer);
    if (state.orderTimeoutTimer) clearTimeout(state.orderTimeoutTimer);

    // 更新資料庫
    if (shouldCancel) {
      const cancelReason = {
        NO_DRIVERS: '目前沒有可用司機',
        MAX_BATCHES: '超過最大派單次數',
        TIMEOUT: '派單超時',
      }[reason as 'NO_DRIVERS' | 'MAX_BATCHES' | 'TIMEOUT'] || '派單失敗';

      await this.pool.query(
        `UPDATE orders
         SET status = 'CANCELLED',
             cancelled_at = CURRENT_TIMESTAMP,
             cancel_reason = $1
         WHERE order_id = $2`,
        [cancelReason, orderId]
      );
    } else {
      // ALL_REJECTED：訂單回到 OFFERED，允許司機手動接單
      await this.pool.query(
        `UPDATE orders SET status = 'OFFERED' WHERE order_id = $1`,
        [orderId]
      );
      console.log(`[SmartDispatcherV2] 訂單 ${orderId} 所有司機拒絕，保持 OFFERED 等待手動接單`);
    }

    // 通知乘客
    this.notifyPassengerDispatchProgress(state.order.passengerId, {
      orderId,
      status: shouldCancel ? 'CANCELLED' : 'OFFERED',
      dispatchStatus: 'FAILED',
      currentBatch: state.currentBatch,
      offeredToCount: state.allOfferedDriverIds.size,
      message: shouldCancel ? '目前無可用司機' : '所有司機都已拒絕，等待手動接單',
      cancelReason: shouldCancel ? '目前無可用司機' : undefined,
    });

    // 客人反向通知（派單失敗）— 走分派層（LINE 優先、SMS 備援）
    // 若 CustomerNotificationService 未 init（LINE 或 SMS 任一未設），
    // fallback 到舊的 LineNotifier shortcut 以保持行為相容
    if (shouldCancel) {
      try {
        const { getCustomerNotificationService } = require('./CustomerNotificationService');
        const cns = getCustomerNotificationService();
        if (cns) {
          cns.notifyDispatchFailed(orderId, '目前無可用司機')
            .catch((err: any) => console.error('[SmartDispatcherV2] CustomerNotification 失敗:', err));
        } else {
          // 分派層未啟用時保留舊 LINE-only shortcut
          const { getLineNotifier } = require('./LineNotifier');
          const lineNotifier = getLineNotifier();
          if (lineNotifier) {
            lineNotifier.notifyNoDriverAvailable(orderId)
              .catch((err: any) => console.error('[SmartDispatcherV2] LINE 推播失敗:', err));
          }
        }
      } catch { /* 通知模組未初始化，忽略 */ }
    }

    // 從活動訂單移除
    this.activeOrders.delete(orderId);
  }

  // ============================================
  // 輔助方法
  // ============================================

  /**
   * 獲取可用司機
   */
  private async getAvailableDrivers(excludeDrivers: Set<string>, order?: OrderData): Promise<any[]> {
    // 派單診斷：顯示當前在線司機
    console.log(`[SmartDispatcherV2] driverSockets 當前有 ${driverSockets.size} 位司機: [${Array.from(driverSockets.keys()).join(', ')}]`);

    // 從內存獲取在線司機
    const onlineDriverIds = Array.from(driverSockets.keys()).filter(
      id => !excludeDrivers.has(id)
    );

    if (onlineDriverIds.length === 0) {
      return [];
    }

    // 建立能力過濾條件
    let capabilityFilter = '';
    if (order?.subsidyType === 'SENIOR_CARD') {
      capabilityFilter += ' AND d.can_senior_card = TRUE';
    } else if (order?.subsidyType === 'LOVE_CARD') {
      capabilityFilter += ' AND d.can_love_card = TRUE';
    }
    if (order?.petPresent === 'YES') {
      capabilityFilter += ' AND d.can_pet = TRUE';
    }

    // [Layer 0.5] Preferred Fleet 過濾：訂單綁定特定車隊（LINE 官方/電話來源）
    //   只派此 fleet 的 PRIMARY_FLEET 司機；30 秒 timeout 後客人可選擇解除
    const preferredFleetPartnerId = order?.preferredFleetPartnerId || null;
    if (preferredFleetPartnerId) {
      capabilityFilter += ` AND EXISTS (
        SELECT 1 FROM driver_partners dp
        WHERE dp.driver_id = d.driver_id
          AND dp.partner_id = $2
          AND dp.relationship_type = 'PRIMARY_FLEET'
          AND dp.is_active = true
      )`;
      console.log(`[SmartDispatcherV2] 訂單 ${order?.orderId || 'unknown'} 限定 preferred fleet = ${preferredFleetPartnerId}`);
    }

    // 從資料庫獲取司機詳細資訊（含 shifts 用於排班過濾）
    // 1+1 疊單：除了 AVAILABLE/REST，也納入 ON_TRIP 司機 — 之後用「離當前訂單目的地直線距離 ≤ 2km」過濾
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
        d.can_senior_card,
        d.can_love_card,
        d.can_pet,
        d.shifts,
        COALESCE(de.total_trips, 0) as today_trips,
        COALESCE(de.online_hours, 0) as online_hours,
        -- 司機目前進行中訂單的目的地（給疊單 ETA 估算用，沒有當前訂單則 NULL）
        (SELECT dest_lat FROM orders o WHERE o.driver_id = d.driver_id
           AND o.status = 'ON_TRIP' ORDER BY started_at DESC LIMIT 1) AS current_dest_lat,
        (SELECT dest_lng FROM orders o WHERE o.driver_id = d.driver_id
           AND o.status = 'ON_TRIP' ORDER BY started_at DESC LIMIT 1) AS current_dest_lng,
        (SELECT order_id FROM orders o WHERE o.driver_id = d.driver_id
           AND o.status = 'ON_TRIP' ORDER BY started_at DESC LIMIT 1) AS current_order_id
      FROM drivers d
      LEFT JOIN daily_earnings de ON d.driver_id = de.driver_id AND de.date = CURRENT_DATE
      WHERE d.driver_id = ANY($1)
        AND d.availability IN ('AVAILABLE', 'REST', 'ON_TRIP')
        ${capabilityFilter}
    `, preferredFleetPartnerId ? [onlineDriverIds, preferredFleetPartnerId] : [onlineDriverIds]);

    // 1+1 疊單過濾：ON_TRIP 司機只有「離當前 dest 直線距離 ≤ 2km」才算候選（避免太早派疊單）
    // 假設 30 km/h 平均車速 → 2km 直線 ≈ 4 分鐘車程，跟設計「< 5 分鐘」一致
    const STACKED_DISPATCH_RADIUS_KM = 2;
    const beforeStackedFilter = result.rows.length;
    result.rows = result.rows.filter(d => {
      if (d.availability !== 'ON_TRIP') return true;
      // ON_TRIP 但沒有 current dest → 異常狀態，不派
      if (d.current_dest_lat == null || d.current_dest_lng == null) return false;
      // 沒有 current_lat/lng → 不派
      if (d.current_lat == null || d.current_lng == null) return false;
      // Haversine 直線距離
      const dist = this.calculateDistance(
        { lat: d.current_lat, lng: d.current_lng },
        { lat: d.current_dest_lat, lng: d.current_dest_lng }
      );
      return dist <= STACKED_DISPATCH_RADIUS_KM;
    });
    if (beforeStackedFilter !== result.rows.length) {
      console.log(`[SmartDispatcherV2] 1+1 疊單過濾: ${result.rows.length}/${beforeStackedFilter} (ON_TRIP 中只取距離 dest ≤ ${STACKED_DISPATCH_RADIUS_KM} km)`);
    }

    if (order?.subsidyType && order.subsidyType !== 'NONE') {
      console.log(`[SmartDispatcherV2] 能力過濾: subsidyType=${order.subsidyType}, petPresent=${order.petPresent} → ${result.rows.length}/${onlineDriverIds.length} 位司機符合`);
    }

    // 排班過濾：移除不在班次時間的司機（shifts 為空視同 24/7 在班）
    const beforeShiftFilter = result.rows.length;
    const now = new Date();
    const onShiftRows = result.rows.filter(row => isOnShift(now, row.shifts));
    if (beforeShiftFilter !== onShiftRows.length) {
      console.log(`[SmartDispatcherV2] 排班過濾: ${onShiftRows.length}/${beforeShiftFilter} 位司機在班`);
    }
    result.rows = onShiftRows;

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
        driverType: 'HIGH_VOLUME',
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
   * 取得訂單預估車資 — 消除舊版 `|| 200` hardcoded fallback。
   *
   * 優先順序：
   *   1. order.estimatedFare（passengers.ts / line-liff.ts 已算好的，最準）
   *   2. 用 pickup + destination 透過 fareConfigService 即時算（保底，避免上游 race condition）
   *   3. 都沒有（無目的地的純電話叫車）→ undefined，讓司機 UI 顯示「未估算」而非假的 200
   */
  private getOrComputeFare(order: {
    pickup: { lat: number; lng: number };
    destination?: { lat: number; lng: number } | null;
    estimatedFare?: number;
  }): number | undefined {
    if (order.estimatedFare && order.estimatedFare > 0) return order.estimatedFare;
    if (order.destination) {
      const distKm = this.calculateDistance(order.pickup, order.destination);
      return fareConfigService.calculateFare(distKm * 1000).totalFare;
    }
    return undefined;
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
         WHERE log_id = (
           SELECT log_id FROM dispatch_logs
           WHERE order_id = $3
           ORDER BY batch_number DESC
           LIMIT 1
         )`,
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
   * Socket reconnect 補發：司機重連後，重新送他 active 但未過期的 order:offer
   * 司機 App 切背景被 Doze 殺 socket → 訂單 timeout 前回前景時找不到卡片的 fix
   *
   * 過濾條件：
   *   - state.status === 'DISPATCHING' （訂單仍在派發中沒人接）
   *   - 該司機在 perDriverOffers 內（曾被 offer 過）
   *   - 司機沒 rejected / timeout / acceptedBy（offer 仍對他有效）
   */
  public replayActiveOffersForDriver(driverId: string): number {
    const socketId = driverSockets.get(driverId);
    if (!socketId) return 0;
    const io = getSocketIO();
    let replayed = 0;
    for (const [orderId, state] of this.activeOrders.entries()) {
      if (state.status !== 'DISPATCHING') continue;
      if (state.acceptedBy) continue;
      if (state.allRejectedDriverIds.has(driverId)) continue;
      if (state.allTimedOutDriverIds.has(driverId)) continue;
      const offer = state.perDriverOffers?.get(driverId);
      if (!offer) continue;
      io.to(socketId).emit('order:offer', offer);
      console.log(`[SmartDispatcherV2] 司機 ${driverId} 重連 → replay order:offer ${orderId}`);
      replayed++;
    }
    return replayed;
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
    queuedCount: number;
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
      queuedCount: this.queuedOrders.size,
    };
  }

  // ============================================
  // 排隊管理
  // ============================================

  /**
   * 處理排隊訂單（定期執行）
   */
  private async processQueuedOrders(): Promise<void> {
    if (this.queuedOrders.size === 0 || !this.hotZoneQuotaService) {
      return;
    }

    console.log(`[SmartDispatcherV2] 檢查排隊訂單 (${this.queuedOrders.size} 筆)`);

    for (const [orderId, state] of this.queuedOrders.entries()) {
      const zoneId = state.hotZoneQuota?.zone?.zoneId;
      if (!zoneId) continue;

      try {
        // 檢查配額是否可用
        const quotaStatus = await this.hotZoneQuotaService.checkQuota(zoneId);

        if (quotaStatus.availableQuota > 0) {
          console.log(`[SmartDispatcherV2] 排隊訂單 ${orderId} 配額可用，開始派單`);

          // 從排隊取消
          await this.hotZoneQuotaService.dequeue(orderId);

          // 消費配額（用 getOrComputeFare 確保有正確的 fare 值）
          const estimatedFare = this.getOrComputeFare(state.order) ?? 0;
          await this.hotZoneQuotaService.consumeQuota(
            zoneId,
            orderId,
            estimatedFare,
            quotaStatus.currentSurge
          );

          // 從排隊移除
          this.queuedOrders.delete(orderId);

          // 更新狀態並開始派單
          state.status = 'DISPATCHING';
          this.activeOrders.set(orderId, state);

          // 設置總超時
          state.orderTimeoutTimer = setTimeout(
            () => this.handleOrderTimeout(orderId),
            CONFIG.ORDER_TOTAL_TIMEOUT_MS
          );

          // 通知乘客開始派單
          this.notifyPassengerDispatchProgress(state.order.passengerId, {
            orderId,
            dispatchStatus: 'SEARCHING',
            message: '排隊結束，正在尋找司機...',
          });

          // 執行派單
          await this.executeBatch(orderId);
        } else {
          // 更新排隊位置
          const currentPosition = await this.getQueuePosition(zoneId, orderId);
          if (currentPosition !== state.queuePosition) {
            state.queuePosition = currentPosition;

            // 通知乘客位置更新
            this.notifyPassengerDispatchProgress(state.order.passengerId, {
              orderId,
              dispatchStatus: 'QUEUED',
              queuePosition: currentPosition,
              message: `排隊位置更新: 第 ${currentPosition} 位`,
            });
          }
        }
      } catch (error) {
        console.error(`[SmartDispatcherV2] 處理排隊訂單失敗 (${orderId}):`, error);
      }
    }
  }

  /**
   * 取得排隊位置
   */
  private async getQueuePosition(zoneId: number, orderId: string): Promise<number> {
    try {
      const result = await this.pool.query(`
        SELECT queue_position FROM hot_zone_queue
        WHERE zone_id = $1 AND order_id = $2 AND status = 'WAITING'
      `, [zoneId, orderId]);

      return result.rows[0]?.queue_position || 0;
    } catch (error) {
      return 0;
    }
  }

  /**
   * 訂單完成時釋放配額
   */
  async releaseOrderQuota(orderId: string): Promise<void> {
    // 從活動訂單查找
    const state = this.activeOrders.get(orderId);
    if (state?.hotZoneQuota?.inHotZone && this.hotZoneQuotaService) {
      try {
        await this.hotZoneQuotaService.releaseQuota(orderId);
        console.log(`[SmartDispatcherV2] 已釋放訂單 ${orderId} 的熱區配額`);
      } catch (error) {
        console.error(`[SmartDispatcherV2] 釋放配額失敗 (${orderId}):`, error);
      }
    }
  }

  /**
   * 取消排隊訂單
   */
  async cancelQueuedOrder(orderId: string): Promise<boolean> {
    const state = this.queuedOrders.get(orderId);
    if (!state) {
      return false;
    }

    console.log(`[SmartDispatcherV2] 取消排隊訂單 ${orderId}`);

    // 從排隊移除
    if (state.hotZoneQuota?.zone?.zoneId && this.hotZoneQuotaService) {
      try {
        await this.pool.query(
          `UPDATE hot_zone_queue SET status = 'cancelled' WHERE order_id = $1`,
          [orderId]
        );
      } catch (error) {
        console.error(`[SmartDispatcherV2] 更新排隊狀態失敗:`, error);
      }
    }

    this.queuedOrders.delete(orderId);

    // 更新資料庫
    await this.pool.query(
      `UPDATE orders SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancel_reason = '乘客取消排隊' WHERE order_id = $1`,
      [orderId]
    );

    return true;
  }

  /**
   * 取得排隊訂單統計
   */
  getQueuedOrdersStats(): Array<{
    orderId: string;
    passengerId: string;
    zoneName: string;
    queuePosition: number;
    waitingTime: number;
  }> {
    return Array.from(this.queuedOrders.entries()).map(([orderId, state]) => ({
      orderId,
      passengerId: state.order.passengerId,
      zoneName: state.hotZoneQuota?.zone?.zoneName || '未知',
      queuePosition: state.queuePosition || 0,
      waitingTime: Math.floor((Date.now() - state.createdAt) / 1000),
    }));
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

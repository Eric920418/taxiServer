/**
 * 訂單派發管理器
 * 負責追蹤訂單狀態、自動重新派單、超時處理
 */

import { driverSockets, driverLocations, notifyPassengerOrderUpdate, getIO } from '../socket';
import { query, queryOne } from '../db/connection';

// 預估速度設定（公里/小時）
const SPEED_CONFIG = {
  CITY_AVG_SPEED: 30,    // 市區平均時速 30 km/h
  HIGHWAY_SPEED: 60,      // 快速道路時速 60 km/h
};

// 訂單派發設定
const CONFIG = {
  ORDER_TIMEOUT_MS: 5 * 60 * 1000,     // 訂單總超時時間：5 分鐘
  DRIVER_RESPONSE_TIMEOUT_MS: 30 * 1000, // 單一司機回應超時：30 秒
  MAX_REJECT_COUNT: 10,                 // 最大拒絕次數
  RE_DISPATCH_DELAY_MS: 1000,           // 重新派單延遲：1 秒
};

/**
 * 計算兩點距離（Haversine 公式）
 * @returns 距離（公里）
 */
function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // 地球半徑（公里）
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // 返回公里
}

/**
 * 根據距離計算預估時間（分鐘）
 * 使用實際道路係數（直線距離 × 1.3 ≈ 實際路程）
 */
function calculateETA(distanceKm: number): number {
  const roadFactor = 1.3; // 實際道路通常比直線長 30%
  const actualDistance = distanceKm * roadFactor;
  const etaHours = actualDistance / SPEED_CONFIG.CITY_AVG_SPEED;
  return Math.ceil(etaHours * 60); // 返回分鐘，無條件進位
}

/**
 * 為司機計算訂單的距離和時間資訊
 */
function calculateOrderInfoForDriver(
  driverId: string,
  order: any
): {
  distanceToPickup: number;      // 到上車點距離（公里）
  etaToPickup: number;           // 到上車點預估時間（分鐘）
  tripDistance: number | null;   // 行程距離（公里），無目的地則 null
  estimatedTripDuration: number | null; // 預估車程（分鐘），無目的地則 null
} {
  // 取得司機當前位置
  const driverLocation = driverLocations.get(driverId);

  let distanceToPickup = 0;
  let etaToPickup = 0;

  if (driverLocation) {
    // 計算司機到上車點的距離
    distanceToPickup = calculateDistance(
      driverLocation.lat,
      driverLocation.lng,
      order.pickup.lat,
      order.pickup.lng
    );
    etaToPickup = calculateETA(distanceToPickup);
  }

  // 計算行程距離（如果有目的地）
  let tripDistance: number | null = null;
  let estimatedTripDuration: number | null = null;

  if (order.destination && order.destination.lat && order.destination.lng) {
    tripDistance = calculateDistance(
      order.pickup.lat,
      order.pickup.lng,
      order.destination.lat,
      order.destination.lng
    );
    estimatedTripDuration = calculateETA(tripDistance);
  }

  return {
    distanceToPickup: Math.round(distanceToPickup * 10) / 10, // 四捨五入到小數點一位
    etaToPickup,
    tripDistance: tripDistance !== null ? Math.round(tripDistance * 10) / 10 : null,
    estimatedTripDuration
  };
}

// 訂單追蹤資訊
interface OrderTracking {
  orderId: string;
  passengerId: string;
  order: any;  // 完整訂單資訊
  offeredDriverIds: Set<string>;   // 已推送過的司機
  rejectedDriverIds: Set<string>;  // 已拒絕的司機
  createdAt: number;
  timeoutTimer?: NodeJS.Timeout;
  status: 'DISPATCHING' | 'ACCEPTED' | 'CANCELLED' | 'TIMEOUT';
}

// 正在派發中的訂單 { orderId: OrderTracking }
const activeOrders = new Map<string, OrderTracking>();

/**
 * 註冊新訂單開始派發
 */
export function registerOrder(order: any): string[] {
  const orderId = order.orderId;

  // 如果已存在，先清理
  if (activeOrders.has(orderId)) {
    cancelOrderTracking(orderId);
  }

  const tracking: OrderTracking = {
    orderId,
    passengerId: order.passengerId,
    order,
    offeredDriverIds: new Set(),
    rejectedDriverIds: new Set(),
    createdAt: Date.now(),
    status: 'DISPATCHING',
  };

  activeOrders.set(orderId, tracking);

  // 設置訂單總超時定時器
  tracking.timeoutTimer = setTimeout(() => {
    handleOrderTimeout(orderId);
  }, CONFIG.ORDER_TIMEOUT_MS);

  console.log(`[Dispatcher] 📋 訂單 ${orderId} 開始派發，超時時間：${CONFIG.ORDER_TIMEOUT_MS / 1000}秒`);

  // 推送給所有在線司機
  const offeredDrivers = dispatchToAvailableDrivers(orderId);

  return offeredDrivers;
}

/**
 * 推送訂單給可用的司機（排除已推送/已拒絕的）
 * 每位司機會收到個人化的距離和預估時間資訊
 */
function dispatchToAvailableDrivers(orderId: string): string[] {
  const tracking = activeOrders.get(orderId);
  if (!tracking || tracking.status !== 'DISPATCHING') {
    return [];
  }

  const io = getIO();
  const offeredDrivers: string[] = [];

  driverSockets.forEach((socketId, driverId) => {
    // 跳過已推送過或已拒絕的司機
    if (tracking.offeredDriverIds.has(driverId) || tracking.rejectedDriverIds.has(driverId)) {
      return;
    }

    // 為此司機計算個人化的距離和時間資訊
    const orderInfo = calculateOrderInfoForDriver(driverId, tracking.order);

    // 組合完整的訂單資訊（含距離和預估時間）
    const orderWithInfo = {
      ...tracking.order,
      // 新增：到上車點的資訊（因司機位置而異）
      distanceToPickup: orderInfo.distanceToPickup,     // 公里
      etaToPickup: orderInfo.etaToPickup,               // 分鐘
      // 新增：行程資訊（所有司機相同）
      tripDistance: orderInfo.tripDistance,             // 公里，無目的地則 null
      estimatedTripDuration: orderInfo.estimatedTripDuration, // 分鐘，無目的地則 null
    };

    // 推送訂單（含個人化資訊）
    io.to(socketId).emit('order:offer', orderWithInfo);
    tracking.offeredDriverIds.add(driverId);
    offeredDrivers.push(driverId);

    console.log(`[Dispatcher] 📤 推播訂單 ${orderId} 給司機 ${driverId}` +
      ` (到客人: ${orderInfo.distanceToPickup}km/${orderInfo.etaToPickup}分鐘` +
      (orderInfo.tripDistance ? `, 行程: ${orderInfo.tripDistance}km/${orderInfo.estimatedTripDuration}分鐘` : '') +
      (tracking.order.estimatedFare ? `, 車資: ${tracking.order.estimatedFare}元)` : ')'));
  });

  if (offeredDrivers.length === 0) {
    console.log(`[Dispatcher] ⚠️ 訂單 ${orderId} 無可用司機可推送`);

    // 檢查是否所有司機都拒絕了
    checkAllDriversRejected(orderId);
  } else {
    console.log(`[Dispatcher] ✅ 訂單 ${orderId} 已推送給 ${offeredDrivers.length} 位司機`);
  }

  return offeredDrivers;
}

/**
 * 處理司機拒絕訂單
 */
export async function handleDriverReject(orderId: string, driverId: string, reason?: string): Promise<{
  success: boolean;
  reDispatchedTo: string[];
  message: string;
}> {
  const tracking = activeOrders.get(orderId);

  if (!tracking) {
    console.log(`[Dispatcher] ⚠️ 訂單 ${orderId} 不在派發佇列中`);
    return { success: false, reDispatchedTo: [], message: '訂單不在派發中' };
  }

  if (tracking.status !== 'DISPATCHING') {
    console.log(`[Dispatcher] ⚠️ 訂單 ${orderId} 狀態為 ${tracking.status}，無法處理拒絕`);
    return { success: false, reDispatchedTo: [], message: '訂單狀態不允許' };
  }

  // 記錄拒絕
  tracking.rejectedDriverIds.add(driverId);

  console.log(`[Dispatcher] 🚫 司機 ${driverId} 拒絕訂單 ${orderId}，原因：${reason || '未提供'}`);
  console.log(`[Dispatcher] 📊 訂單 ${orderId} 統計：已推送 ${tracking.offeredDriverIds.size} 位，已拒絕 ${tracking.rejectedDriverIds.size} 位`);

  // 更新資料庫的拒絕次數
  await query(
    'UPDATE orders SET reject_count = reject_count + 1 WHERE order_id = $1',
    [orderId]
  );

  // 檢查是否達到最大拒絕次數
  if (tracking.rejectedDriverIds.size >= CONFIG.MAX_REJECT_COUNT) {
    console.log(`[Dispatcher] ❌ 訂單 ${orderId} 達到最大拒絕次數 ${CONFIG.MAX_REJECT_COUNT}`);
    await handleNoDriversAvailable(orderId, 'MAX_REJECT');
    return { success: true, reDispatchedTo: [], message: '達到最大拒絕次數' };
  }

  // 延遲後重新派發給其他司機
  await new Promise(resolve => setTimeout(resolve, CONFIG.RE_DISPATCH_DELAY_MS));

  const reDispatchedTo = dispatchToAvailableDrivers(orderId);

  return {
    success: true,
    reDispatchedTo,
    message: reDispatchedTo.length > 0
      ? `已重新派發給 ${reDispatchedTo.length} 位司機`
      : '無其他可用司機'
  };
}

/**
 * 處理司機接受訂單
 */
export function handleDriverAccept(orderId: string, driverId: string): boolean {
  const tracking = activeOrders.get(orderId);

  if (!tracking) {
    return false;
  }

  if (tracking.status !== 'DISPATCHING') {
    console.log(`[Dispatcher] ⚠️ 訂單 ${orderId} 已被處理，狀態：${tracking.status}`);
    return false;
  }

  // 更新狀態
  tracking.status = 'ACCEPTED';

  // 清除超時定時器
  if (tracking.timeoutTimer) {
    clearTimeout(tracking.timeoutTimer);
  }

  console.log(`[Dispatcher] ✅ 訂單 ${orderId} 被司機 ${driverId} 接受`);

  // 通知其他司機訂單已被接走
  notifyOtherDriversOrderTaken(orderId, driverId);

  // 從活動訂單中移除
  activeOrders.delete(orderId);

  return true;
}

/**
 * 通知其他司機訂單已被接走
 */
function notifyOtherDriversOrderTaken(orderId: string, acceptedByDriverId: string) {
  const tracking = activeOrders.get(orderId);
  if (!tracking) return;

  const io = getIO();

  tracking.offeredDriverIds.forEach(driverId => {
    if (driverId !== acceptedByDriverId) {
      const socketId = driverSockets.get(driverId);
      if (socketId) {
        io.to(socketId).emit('order:taken', {
          orderId,
          acceptedBy: acceptedByDriverId,
          message: '此訂單已被其他司機接走'
        });
      }
    }
  });
}

/**
 * 檢查是否所有在線司機都拒絕了
 */
function checkAllDriversRejected(orderId: string) {
  const tracking = activeOrders.get(orderId);
  if (!tracking) return;

  // 取得目前在線的司機數量
  const onlineDriverCount = driverSockets.size;

  // 如果已拒絕數量 >= 在線司機數量，表示所有人都拒絕了
  if (tracking.rejectedDriverIds.size >= onlineDriverCount && onlineDriverCount > 0) {
    console.log(`[Dispatcher] ❌ 訂單 ${orderId} 所有 ${onlineDriverCount} 位在線司機都已拒絕`);
    handleNoDriversAvailable(orderId, 'ALL_REJECTED');
  }

  // 如果沒有在線司機
  if (onlineDriverCount === 0) {
    console.log(`[Dispatcher] ❌ 訂單 ${orderId} 沒有在線司機`);
    handleNoDriversAvailable(orderId, 'NO_DRIVERS');
  }
}

/**
 * 處理訂單超時
 */
async function handleOrderTimeout(orderId: string) {
  const tracking = activeOrders.get(orderId);
  if (!tracking || tracking.status !== 'DISPATCHING') {
    return;
  }

  console.log(`[Dispatcher] ⏰ 訂單 ${orderId} 派發超時`);
  await handleNoDriversAvailable(orderId, 'TIMEOUT');
}

/**
 * 處理無司機可用的情況
 */
async function handleNoDriversAvailable(orderId: string, reason: 'TIMEOUT' | 'ALL_REJECTED' | 'MAX_REJECT' | 'NO_DRIVERS') {
  const tracking = activeOrders.get(orderId);
  if (!tracking) return;

  // 更新追蹤狀態
  tracking.status = reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED';

  // 清除定時器
  if (tracking.timeoutTimer) {
    clearTimeout(tracking.timeoutTimer);
  }

  // 更新資料庫訂單狀態
  const reasonText = {
    'TIMEOUT': '派單超時',
    'ALL_REJECTED': '所有司機拒絕',
    'MAX_REJECT': '達到最大拒絕次數',
    'NO_DRIVERS': '無在線司機'
  }[reason];

  await query(
    `UPDATE orders
     SET status = 'CANCELLED',
         cancelled_at = CURRENT_TIMESTAMP,
         cancel_reason = $1
     WHERE order_id = $2`,
    [reasonText, orderId]
  );

  console.log(`[Dispatcher] 📢 通知乘客 ${tracking.passengerId} 訂單已取消，原因：${reasonText}`);

  // 通知乘客
  const cancelNotification = {
    orderId,
    passengerId: tracking.passengerId,
    status: 'CANCELLED',
    cancelReason: reason,
    cancelReasonText: reasonText,
    message: getPassengerMessage(reason),
    suggestRetry: reason !== 'NO_DRIVERS',
    statistics: {
      offeredTo: tracking.offeredDriverIds.size,
      rejectedBy: tracking.rejectedDriverIds.size,
      elapsedSeconds: Math.floor((Date.now() - tracking.createdAt) / 1000)
    }
  };

  notifyPassengerOrderUpdate(tracking.passengerId, cancelNotification);

  // 從活動訂單中移除
  activeOrders.delete(orderId);
}

/**
 * 取得乘客友善的訊息
 */
function getPassengerMessage(reason: 'TIMEOUT' | 'ALL_REJECTED' | 'MAX_REJECT' | 'NO_DRIVERS'): string {
  switch (reason) {
    case 'TIMEOUT':
      return '很抱歉，目前無司機接單，請稍後再試';
    case 'ALL_REJECTED':
      return '很抱歉，附近司機都無法接單，請稍後再試';
    case 'MAX_REJECT':
      return '很抱歉，目前無可用司機，請稍後再試';
    case 'NO_DRIVERS':
      return '很抱歉，目前沒有在線司機，請稍後再試';
    default:
      return '訂單已取消';
  }
}

/**
 * 手動取消訂單追蹤
 */
export function cancelOrderTracking(orderId: string) {
  const tracking = activeOrders.get(orderId);
  if (tracking) {
    if (tracking.timeoutTimer) {
      clearTimeout(tracking.timeoutTimer);
    }
    activeOrders.delete(orderId);
    console.log(`[Dispatcher] 🗑️ 訂單 ${orderId} 追蹤已清除`);
  }
}

/**
 * 取得訂單派發狀態
 */
export function getOrderDispatchStatus(orderId: string): {
  exists: boolean;
  status?: string;
  offeredCount?: number;
  rejectedCount?: number;
  elapsedSeconds?: number;
} | null {
  const tracking = activeOrders.get(orderId);
  if (!tracking) {
    return { exists: false };
  }

  return {
    exists: true,
    status: tracking.status,
    offeredCount: tracking.offeredDriverIds.size,
    rejectedCount: tracking.rejectedDriverIds.size,
    elapsedSeconds: Math.floor((Date.now() - tracking.createdAt) / 1000)
  };
}

/**
 * 取得所有活動訂單狀態（除錯用）
 */
export function getAllActiveOrders(): any[] {
  return Array.from(activeOrders.entries()).map(([orderId, tracking]) => ({
    orderId,
    passengerId: tracking.passengerId,
    status: tracking.status,
    offeredCount: tracking.offeredDriverIds.size,
    rejectedCount: tracking.rejectedDriverIds.size,
    elapsedSeconds: Math.floor((Date.now() - tracking.createdAt) / 1000)
  }));
}

/**
 * 當有新司機上線時，推送待派發的訂單
 * 包含個人化的距離和預估時間資訊
 */
export function onDriverOnline(driverId: string) {
  console.log(`[Dispatcher] 👋 司機 ${driverId} 上線，檢查是否有待派發訂單`);

  activeOrders.forEach((tracking, orderId) => {
    if (tracking.status === 'DISPATCHING' &&
        !tracking.offeredDriverIds.has(driverId) &&
        !tracking.rejectedDriverIds.has(driverId)) {

      const socketId = driverSockets.get(driverId);
      if (socketId) {
        const io = getIO();

        // 為此司機計算個人化的距離和時間資訊
        const orderInfo = calculateOrderInfoForDriver(driverId, tracking.order);

        // 組合完整的訂單資訊
        const orderWithInfo = {
          ...tracking.order,
          distanceToPickup: orderInfo.distanceToPickup,
          etaToPickup: orderInfo.etaToPickup,
          tripDistance: orderInfo.tripDistance,
          estimatedTripDuration: orderInfo.estimatedTripDuration,
        };

        io.to(socketId).emit('order:offer', orderWithInfo);
        tracking.offeredDriverIds.add(driverId);
        console.log(`[Dispatcher] 📤 推播待派發訂單 ${orderId} 給新上線司機 ${driverId}` +
          ` (到客人: ${orderInfo.distanceToPickup}km/${orderInfo.etaToPickup}分鐘)`);
      }
    }
  });
}

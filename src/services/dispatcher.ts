/**
 * 派單演算法 - 距離優先 + 司機評分
 */

import { query, queryMany } from '../db/connection';
import { driverSockets, driverLocations, getSocketIO } from '../socket';

interface DispatchCandidate {
  driverId: string;
  distance: number;
  eta: number;
  rating: number;
  acceptanceRate: number;
  totalTrips: number;
  score: number; // 綜合評分
}

/**
 * 計算兩點距離（Haversine 公式）
 */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // 地球半徑（公尺）
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // 返回公尺
}

/**
 * 計算派單評分
 * 考慮因素：
 * - 距離（權重50%）
 * - 接單率（權重30%）
 * - 司機評分（權重20%）
 */
function calculateDispatchScore(candidate: Omit<DispatchCandidate, 'score'>): number {
  // 距離評分（越近越高，最遠5km）
  const distanceScore = Math.max(0, 100 - (candidate.distance / 5000) * 100);

  // 接單率評分（直接使用百分比）
  const acceptanceScore = candidate.acceptanceRate;

  // 評分評分（5分制轉100分制）
  const ratingScore = (candidate.rating / 5.0) * 100;

  // 綜合評分
  const totalScore =
    distanceScore * 0.5 +
    acceptanceScore * 0.3 +
    ratingScore * 0.2;

  return totalScore;
}

/**
 * 智能派單演算法
 * @param pickupLat 上車點緯度
 * @param pickupLng 上車點經度
 * @param maxRadius 最大搜尋半徑（公尺），預設 5000m
 * @param maxDrivers 最多推送給幾位司機，預設 3
 */
export async function dispatchOrder(
  pickupLat: number,
  pickupLng: number,
  maxRadius: number = 5000,
  maxDrivers: number = 3
): Promise<string[]> {
  console.log(`[Dispatch] 開始派單，上車點: (${pickupLat}, ${pickupLng})`);

  try {
    // 1. 查詢所有可接單的司機
    const availableDrivers = await queryMany(`
      SELECT
        driver_id,
        current_lat,
        current_lng,
        rating,
        acceptance_rate,
        total_trips
      FROM drivers
      WHERE availability = 'AVAILABLE'
        AND current_lat IS NOT NULL
        AND current_lng IS NOT NULL
        AND last_heartbeat > NOW() - INTERVAL '5 minutes'
    `);

    console.log(`[Dispatch] 找到 ${availableDrivers.length} 位可接單司機`);

    if (availableDrivers.length === 0) {
      console.log('[Dispatch] 沒有可用司機');
      return [];
    }

    // 2. 計算每位司機的距離和評分
    const candidates: DispatchCandidate[] = availableDrivers
      .map(driver => {
        const distance = calculateDistance(
          pickupLat,
          pickupLng,
          parseFloat(driver.current_lat),
          parseFloat(driver.current_lng)
        );

        // 預估到達時間（假設平均時速 30km/h）
        const eta = Math.round((distance / 1000) / 30 * 60); // 分鐘

        const candidate = {
          driverId: driver.driver_id,
          distance,
          eta,
          rating: parseFloat(driver.rating),
          acceptanceRate: parseFloat(driver.acceptance_rate),
          totalTrips: driver.total_trips,
          score: 0
        };

        candidate.score = calculateDispatchScore(candidate);

        return candidate;
      })
      .filter(c => c.distance <= maxRadius) // 過濾超出範圍的司機
      .sort((a, b) => b.score - a.score); // 按評分排序

    console.log(`[Dispatch] 範圍內有 ${candidates.length} 位司機`);

    if (candidates.length === 0) {
      console.log('[Dispatch] 範圍內沒有司機');
      return [];
    }

    // 3. 選擇前 N 位司機推送
    const selectedDrivers = candidates.slice(0, maxDrivers);

    selectedDrivers.forEach((driver, index) => {
      console.log(
        `[Dispatch] #${index + 1} 司機 ${driver.driverId}:`,
        `距離 ${Math.round(driver.distance)}m,`,
        `ETA ${driver.eta}分,`,
        `評分 ${driver.score.toFixed(1)}`
      );
    });

    return selectedDrivers.map(d => d.driverId);

  } catch (error) {
    console.error('[Dispatch] 派單失敗:', error);
    return [];
  }
}

/**
 * 推播訂單給指定司機列表
 */
export function broadcastOrderToSelectedDrivers(order: any, driverIds: string[]): string[] {
  const io = getSocketIO();
  const notifiedDrivers: string[] = [];

  driverIds.forEach(driverId => {
    const socketId = driverSockets.get(driverId);

    if (socketId) {
      io.to(socketId).emit('order:offer', order);
      console.log(`[Dispatch] 已推播訂單 ${order.orderId} 給司機 ${driverId}`);
      notifiedDrivers.push(driverId);
    } else {
      console.log(`[Dispatch] 司機 ${driverId} 不在線，跳過推播`);
    }
  });

  return notifiedDrivers;
}

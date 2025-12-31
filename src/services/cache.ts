/**
 * Redis 快取服務
 * 提供高效能的記憶體快取功能
 */

import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// 初始化 Redis 客戶端
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  db: parseInt(process.env.REDIS_DB || '0'),
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  }
});

// Redis 連線事件處理
redis.on('connect', () => {
  console.log('[Redis] 連線成功');
});

redis.on('error', (err) => {
  console.error('[Redis] 連線錯誤:', err);
});

redis.on('close', () => {
  console.log('[Redis] 連線關閉');
});

// ============================================
// 快取鍵前綴定義
// ============================================
const CACHE_KEYS = {
  DRIVER_LOCATION: 'driver:location:',
  DRIVER_STATUS: 'driver:status:',
  DRIVER_EARNINGS: 'driver:earnings:',
  HOT_ZONES: 'hotzones',
  API_RESPONSE: 'api:',
  ORDER: 'order:',
  PASSENGER: 'passenger:',
  NEARBY_DRIVERS: 'nearby:drivers:',
  DISPATCH_STATS: 'dispatch:stats'
};

// 快取過期時間設定（秒）
const CACHE_TTL = {
  DRIVER_LOCATION: 60,      // 司機位置：1分鐘
  DRIVER_STATUS: 300,        // 司機狀態：5分鐘
  DRIVER_EARNINGS: 3600,     // 司機收入：1小時
  HOT_ZONES: 3600,           // 熱區：1小時
  API_RESPONSE: 600,         // API回應：10分鐘
  ORDER: 1800,               // 訂單：30分鐘
  NEARBY_DRIVERS: 30,        // 附近司機：30秒
  DISPATCH_STATS: 300        // 派單統計：5分鐘
};

// ============================================
// 司機相關快取
// ============================================

/**
 * 快取司機位置
 */
export async function cacheDriverLocation(driverId: string, location: {
  lat: number;
  lng: number;
  speed?: number;
  bearing?: number;
  timestamp?: number;
}) {
  try {
    const key = `${CACHE_KEYS.DRIVER_LOCATION}${driverId}`;
    const data = {
      ...location,
      timestamp: location.timestamp || Date.now()
    };
    await redis.setex(key, CACHE_TTL.DRIVER_LOCATION, JSON.stringify(data));
    return true;
  } catch (error) {
    console.error('[Cache] 快取司機位置失敗:', error);
    return false;
  }
}

/**
 * 取得司機位置
 */
export async function getDriverLocation(driverId: string) {
  try {
    const key = `${CACHE_KEYS.DRIVER_LOCATION}${driverId}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[Cache] 取得司機位置失敗:', error);
    return null;
  }
}

/**
 * 批次取得多個司機位置
 */
export async function getMultipleDriverLocations(driverIds: string[]) {
  try {
    const keys = driverIds.map(id => `${CACHE_KEYS.DRIVER_LOCATION}${id}`);
    const values = await redis.mget(...keys);

    const locations = new Map<string, any>();
    values.forEach((value, index) => {
      if (value) {
        locations.set(driverIds[index], JSON.parse(value));
      }
    });

    return locations;
  } catch (error) {
    console.error('[Cache] 批次取得司機位置失敗:', error);
    return new Map();
  }
}

/**
 * 快取司機狀態
 */
export async function cacheDriverStatus(driverId: string, status: string) {
  try {
    const key = `${CACHE_KEYS.DRIVER_STATUS}${driverId}`;
    await redis.setex(key, CACHE_TTL.DRIVER_STATUS, status);
    return true;
  } catch (error) {
    console.error('[Cache] 快取司機狀態失敗:', error);
    return false;
  }
}

/**
 * 快取司機今日收入
 */
export async function cacheDriverEarnings(driverId: string, earnings: number) {
  try {
    const key = `${CACHE_KEYS.DRIVER_EARNINGS}${driverId}:${new Date().toDateString()}`;
    await redis.setex(key, CACHE_TTL.DRIVER_EARNINGS, earnings.toString());
    return true;
  } catch (error) {
    console.error('[Cache] 快取司機收入失敗:', error);
    return false;
  }
}

/**
 * 取得司機今日收入
 */
export async function getDriverEarnings(driverId: string): Promise<number | null> {
  try {
    const key = `${CACHE_KEYS.DRIVER_EARNINGS}${driverId}:${new Date().toDateString()}`;
    const data = await redis.get(key);
    return data ? parseFloat(data) : null;
  } catch (error) {
    console.error('[Cache] 取得司機收入失敗:', error);
    return null;
  }
}

// ============================================
// 熱區相關快取
// ============================================

/**
 * 快取熱區資料
 */
export async function cacheHotZones(hotZones: any) {
  try {
    await redis.setex(CACHE_KEYS.HOT_ZONES, CACHE_TTL.HOT_ZONES, JSON.stringify(hotZones));
    return true;
  } catch (error) {
    console.error('[Cache] 快取熱區失敗:', error);
    return false;
  }
}

/**
 * 取得熱區資料
 */
export async function getHotZones() {
  try {
    const data = await redis.get(CACHE_KEYS.HOT_ZONES);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[Cache] 取得熱區失敗:', error);
    return null;
  }
}

// ============================================
// API 回應快取
// ============================================

/**
 * 快取 API 回應
 */
export async function cacheApiResponse(endpoint: string, data: any, ttl?: number) {
  try {
    const key = `${CACHE_KEYS.API_RESPONSE}${endpoint}`;
    const expiry = ttl || CACHE_TTL.API_RESPONSE;
    await redis.setex(key, expiry, JSON.stringify(data));
    return true;
  } catch (error) {
    console.error('[Cache] 快取 API 回應失敗:', error);
    return false;
  }
}

/**
 * 取得快取的 API 回應
 */
export async function getCachedApiResponse(endpoint: string) {
  try {
    const key = `${CACHE_KEYS.API_RESPONSE}${endpoint}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[Cache] 取得 API 快取失敗:', error);
    return null;
  }
}

// ============================================
// 訂單相關快取
// ============================================

/**
 * 快取訂單資料
 */
export async function cacheOrder(orderId: string, orderData: any) {
  try {
    const key = `${CACHE_KEYS.ORDER}${orderId}`;
    await redis.setex(key, CACHE_TTL.ORDER, JSON.stringify(orderData));
    return true;
  } catch (error) {
    console.error('[Cache] 快取訂單失敗:', error);
    return false;
  }
}

/**
 * 取得訂單資料
 */
export async function getOrder(orderId: string) {
  try {
    const key = `${CACHE_KEYS.ORDER}${orderId}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[Cache] 取得訂單失敗:', error);
    return null;
  }
}

// ============================================
// 附近司機快取
// ============================================

/**
 * 快取附近司機列表
 */
export async function cacheNearbyDrivers(lat: number, lng: number, drivers: any[]) {
  try {
    const key = `${CACHE_KEYS.NEARBY_DRIVERS}${lat.toFixed(3)},${lng.toFixed(3)}`;
    await redis.setex(key, CACHE_TTL.NEARBY_DRIVERS, JSON.stringify(drivers));
    return true;
  } catch (error) {
    console.error('[Cache] 快取附近司機失敗:', error);
    return false;
  }
}

/**
 * 取得附近司機列表
 */
export async function getNearbyDrivers(lat: number, lng: number) {
  try {
    const key = `${CACHE_KEYS.NEARBY_DRIVERS}${lat.toFixed(3)},${lng.toFixed(3)}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[Cache] 取得附近司機失敗:', error);
    return null;
  }
}

// ============================================
// 派單統計快取
// ============================================

/**
 * 快取派單統計
 */
export async function cacheDispatchStats(stats: any) {
  try {
    await redis.setex(CACHE_KEYS.DISPATCH_STATS, CACHE_TTL.DISPATCH_STATS, JSON.stringify(stats));
    return true;
  } catch (error) {
    console.error('[Cache] 快取派單統計失敗:', error);
    return false;
  }
}

/**
 * 取得派單統計
 */
export async function getDispatchStats() {
  try {
    const data = await redis.get(CACHE_KEYS.DISPATCH_STATS);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('[Cache] 取得派單統計失敗:', error);
    return null;
  }
}

// ============================================
// 工具函數
// ============================================

/**
 * 清除特定模式的快取
 */
export async function clearCache(pattern: string) {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      console.log(`[Cache] 清除 ${keys.length} 個快取鍵`);
    }
    return true;
  } catch (error) {
    console.error('[Cache] 清除快取失敗:', error);
    return false;
  }
}

/**
 * 清除所有快取
 */
export async function flushCache() {
  try {
    await redis.flushdb();
    console.log('[Cache] 已清除所有快取');
    return true;
  } catch (error) {
    console.error('[Cache] 清除所有快取失敗:', error);
    return false;
  }
}

/**
 * 取得快取統計
 */
export async function getCacheStats() {
  try {
    const info = await redis.info('stats');
    const dbSize = await redis.dbsize();

    return {
      dbSize,
      info,
      connected: redis.status === 'ready'
    };
  } catch (error) {
    console.error('[Cache] 取得統計失敗:', error);
    return null;
  }
}

/**
 * 關閉 Redis 連線
 */
export async function closeRedis() {
  try {
    await redis.quit();
    console.log('[Redis] 連線已關閉');
  } catch (error) {
    console.error('[Redis] 關閉連線失敗:', error);
  }
}

export default redis;
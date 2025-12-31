/**
 * 安全中間件
 * 包含 Rate Limiting、Helmet 安全頭、請求驗證等
 */

import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import redis from '../services/cache';
import logger, { auditLogger } from '../services/logger';

// ============================================
// Rate Limiting 設定
// ============================================

/**
 * 基礎 Rate Limiter - 使用 Redis 儲存
 */
const createRedisStore = (prefix: string) => {
  return {
    increment: async (key: string) => {
      const fullKey = `ratelimit:${prefix}:${key}`;
      const current = await redis.incr(fullKey);

      // 第一次設定過期時間
      if (current === 1) {
        await redis.expire(fullKey, 60 * 15); // 15分鐘
      }

      return current;
    },
    decrement: async (key: string) => {
      const fullKey = `ratelimit:${prefix}:${key}`;
      const current = await redis.decr(fullKey);
      return Math.max(0, current);
    },
    resetKey: async (key: string) => {
      const fullKey = `ratelimit:${prefix}:${key}`;
      await redis.del(fullKey);
    }
  };
};

/**
 * 標準 API Rate Limiter
 */
export const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分鐘
  max: 100, // 每個 IP 100 個請求
  message: {
    error: 'TOO_MANY_REQUESTS',
    message: '請求過於頻繁，請稍後再試',
    retryAfter: 15
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // 使用 IP 或用戶 ID 作為 key
    return req.ip || 'unknown';
  },
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.path,
      method: req.method
    });

    res.status(429).json({
      error: 'TOO_MANY_REQUESTS',
      message: '請求過於頻繁，請稍後再試'
    });
  }
});

/**
 * 嚴格 Rate Limiter（用於登入等敏感操作）
 */
export const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分鐘
  max: 5, // 每個 IP 5 次嘗試
  message: {
    error: 'TOO_MANY_ATTEMPTS',
    message: '嘗試次數過多，請15分鐘後再試'
  },
  skipSuccessfulRequests: true, // 成功的請求不計入限制
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * 司機位置更新 Rate Limiter（較寬鬆）
 */
export const locationUpdateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1分鐘
  max: 60, // 每分鐘最多60次（每秒1次）
  message: {
    error: 'RATE_LIMIT_LOCATION',
    message: '位置更新過於頻繁'
  }
});

/**
 * WebSocket 連線 Rate Limiter
 */
export const socketConnectionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5分鐘
  max: 10, // 每個 IP 10 次連線嘗試
  message: {
    error: 'TOO_MANY_CONNECTIONS',
    message: '連線嘗試過多'
  }
});

/**
 * 動態 Rate Limiter（根據用戶類型調整）
 */
export const dynamicLimiter = (req: Request, res: Response, next: NextFunction) => {
  // 根據用戶類型設定不同的限制
  let maxRequests = 100;

  if (req.headers['x-api-key']) {
    // API Key 用戶有更高的限制
    maxRequests = 1000;
  } else if (req.headers.authorization) {
    // 已驗證用戶
    maxRequests = 500;
  }

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: maxRequests,
    keyGenerator: (req) => {
      // 使用 API Key、用戶 ID 或 IP
      return req.headers['x-api-key'] as string ||
             req.headers.authorization as string ||
             req.ip || 'unknown';
    }
  });

  limiter(req, res, next);
};

// ============================================
// IP 黑名單/白名單
// ============================================

const IP_BLACKLIST_KEY = 'security:blacklist:ip';
const IP_WHITELIST_KEY = 'security:whitelist:ip';

/**
 * IP 黑名單中間件
 */
export const ipBlacklist = async (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || '';

  // 檢查白名單
  const isWhitelisted = await redis.sismember(IP_WHITELIST_KEY, ip);
  if (isWhitelisted) {
    return next();
  }

  // 檢查黑名單
  const isBlacklisted = await redis.sismember(IP_BLACKLIST_KEY, ip);
  if (isBlacklisted) {
    auditLogger.logSecurityEvent('BLOCKED_IP', {
      ip,
      path: req.path,
      method: req.method
    });

    return res.status(403).json({
      error: 'ACCESS_DENIED',
      message: '訪問被拒絕'
    });
  }

  next();
};

/**
 * 添加 IP 到黑名單
 */
export async function blockIP(ip: string, reason: string, duration?: number) {
  await redis.sadd(IP_BLACKLIST_KEY, ip);

  if (duration) {
    // 設定自動過期
    setTimeout(async () => {
      await redis.srem(IP_BLACKLIST_KEY, ip);
      logger.info('IP unblocked automatically', { ip });
    }, duration * 1000);
  }

  auditLogger.logSecurityEvent('IP_BLOCKED', {
    ip,
    reason,
    duration: duration ? `${duration}s` : 'permanent'
  });
}

/**
 * 從黑名單移除 IP
 */
export async function unblockIP(ip: string) {
  await redis.srem(IP_BLACKLIST_KEY, ip);
  auditLogger.logSecurityEvent('IP_UNBLOCKED', { ip });
}

// ============================================
// 請求驗證
// ============================================

/**
 * API Key 驗證中間件
 */
export const validateApiKey = async (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({
      error: 'MISSING_API_KEY',
      message: '缺少 API Key'
    });
  }

  // 驗證 API Key（從快取或資料庫）
  const isValid = await redis.get(`apikey:${apiKey}`);

  if (!isValid) {
    auditLogger.logSecurityEvent('INVALID_API_KEY', {
      apiKey,
      ip: req.ip,
      path: req.path
    });

    return res.status(401).json({
      error: 'INVALID_API_KEY',
      message: '無效的 API Key'
    });
  }

  // 記錄使用情況
  await redis.hincrby(`apikey:usage:${apiKey}`, new Date().toISOString().split('T')[0], 1);

  next();
};

// ============================================
// 防止暴力破解
// ============================================

const LOGIN_ATTEMPTS_KEY = 'security:login:attempts:';
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BLOCK_DURATION = 15 * 60; // 15分鐘

/**
 * 登入嘗試限制
 */
export const loginAttemptLimiter = async (req: Request, res: Response, next: NextFunction) => {
  const identifier = req.body.username || req.body.phone || req.ip;
  const key = `${LOGIN_ATTEMPTS_KEY}${identifier}`;

  const attempts = await redis.get(key);
  const attemptCount = attempts ? parseInt(attempts) : 0;

  if (attemptCount >= MAX_LOGIN_ATTEMPTS) {
    const ttl = await redis.ttl(key);

    auditLogger.logSecurityEvent('LOGIN_BLOCKED', {
      identifier,
      attempts: attemptCount,
      remainingTime: ttl
    });

    return res.status(429).json({
      error: 'TOO_MANY_LOGIN_ATTEMPTS',
      message: `登入嘗試次數過多，請 ${Math.ceil(ttl / 60)} 分鐘後再試`
    });
  }

  // 增加嘗試次數
  await redis.incr(key);
  await redis.expire(key, LOGIN_BLOCK_DURATION);

  // 儲存原始的 res.json 方法
  const originalJson = res.json.bind(res);

  // 覆寫 res.json 以檢查登入結果
  res.json = function(data: any) {
    // 如果登入成功，重置嘗試次數
    if (res.statusCode === 200 && data.success) {
      redis.del(key);
    }

    return originalJson(data);
  };

  next();
};

// ============================================
// 請求大小限制
// ============================================

/**
 * 請求大小限制中間件
 */
export const requestSizeLimiter = (maxSize: string = '10mb') => {
  return (req: Request, res: Response, next: NextFunction) => {
    const contentLength = req.headers['content-length'];

    if (contentLength) {
      const bytes = parseInt(contentLength);
      const maxBytes = parseSize(maxSize);

      if (bytes > maxBytes) {
        logger.warn('Request too large', {
          ip: req.ip,
          path: req.path,
          size: bytes,
          maxSize: maxBytes
        });

        return res.status(413).json({
          error: 'PAYLOAD_TOO_LARGE',
          message: '請求內容過大'
        });
      }
    }

    next();
  };
};

/**
 * 解析大小字串為 bytes
 */
function parseSize(size: string): number {
  const units: { [key: string]: number } = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024
  };

  const match = size.toLowerCase().match(/^(\d+)([a-z]+)$/);
  if (match) {
    const value = parseInt(match[1]);
    const unit = units[match[2]] || 1;
    return value * unit;
  }

  return parseInt(size);
}

// ============================================
// DDOS 防護
// ============================================

const REQUEST_COUNT_KEY = 'security:requests:';
const DDOS_THRESHOLD = 1000; // 每分鐘1000個請求
const DDOS_BLOCK_DURATION = 3600; // 1小時

/**
 * DDOS 防護中間件
 */
export const ddosProtection = async (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || '';
  const key = `${REQUEST_COUNT_KEY}${ip}`;
  const minute = new Date().getMinutes();
  const field = `${minute}`;

  // 增加請求計數
  const count = await redis.hincrby(key, field, 1);

  // 設定過期時間（2分鐘）
  await redis.expire(key, 120);

  // 檢查是否超過閾值
  if (count > DDOS_THRESHOLD) {
    // 封鎖 IP
    await blockIP(ip, 'DDOS_ATTACK', DDOS_BLOCK_DURATION);

    logger.error('DDOS attack detected', {
      ip,
      requestCount: count,
      threshold: DDOS_THRESHOLD
    });

    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: '服務暫時不可用'
    });
  }

  next();
};

export default {
  standardLimiter,
  strictLimiter,
  locationUpdateLimiter,
  socketConnectionLimiter,
  dynamicLimiter,
  ipBlacklist,
  validateApiKey,
  loginAttemptLimiter,
  requestSizeLimiter,
  ddosProtection,
  blockIP,
  unblockIP
};
/**
 * 花蓮計程車伺服器 - 優化版主程式
 * 整合所有效能優化功能
 */

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';

// 匯入優化模組
import logger, { systemLogger, requestLogger, logSocketEvent } from './services/logger';
import * as cache from './services/cache';
import batchUpdater from './services/batch-updater';
import security from './middleware/security';

// 匯入 API 路由
import driversRouter from './api/drivers';
import ordersRouter from './api/orders';
import passengersRouter from './api/passengers';
import earningsRouter from './api/earnings';
import dispatchRouter from './api/dispatch';
import authRouter from './api/auth';
import adminRouter from './api/admin';
import { setSocketIO, driverSockets, passengerSockets } from './socket';

// 載入環境變數
dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  // Socket.io 效能優化
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

const PORT = process.env.PORT || 3000;

// ============================================
// 安全性和優化中間件
// ============================================

// Helmet 安全頭 - 配置適合管理後台的 CSP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'", "ws:", "wss:", "http:", "https:"],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));

// 壓縮回應
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

// CORS 設定
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  optionsSuccessStatus: 200
}));

// 請求解析
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 請求日誌
app.use(requestLogger);

// IP 黑名單檢查
app.use(security.ipBlacklist);

// DDoS 防護（生產環境啟用）
if (process.env.NODE_ENV === 'production') {
  app.use(security.ddosProtection);
}

// ============================================
// 靜態檔案服務（優化版）
// ============================================

const adminPanelPath = path.join(__dirname, '../admin-panel/dist');
app.use('/admin', express.static(adminPanelPath, {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
  lastModified: true,
  index: 'index.html',
  setHeaders: (res, path) => {
    // 設定快取策略
    if (path.endsWith('.js') || path.endsWith('.css')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

// ============================================
// API 路由（加入 Rate Limiting）
// ============================================

// 基礎路由
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: '花蓮計程車司機端Server (優化版)',
    version: '2.0.0-optimized',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// 健康檢查
app.get('/health', async (req, res) => {
  const { checkPoolHealth } = require('./db/connection');
  const poolHealth = await checkPoolHealth();
  const cacheStats = await cache.getCacheStats();

  res.json({
    status: 'healthy',
    database: poolHealth,
    cache: cacheStats,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Socket 健康檢查
app.get('/socket/health', (req, res) => {
  const { driverLocations } = require('./socket');

  res.json({
    status: 'ok',
    socketio: {
      running: true,
      engine: io.engine ? 'active' : 'inactive'
    },
    connections: {
      total: io.engine.clientsCount || 0,
      drivers: driverSockets.size,
      passengers: passengerSockets.size
    },
    locations: {
      tracked_drivers: driverLocations.size
    },
    timestamp: new Date().toISOString()
  });
});

// 初始化Socket.io模組
setSocketIO(io);

// API路由 (加入 Rate Limiting)
app.use('/api/auth', security.strictLimiter, authRouter);
app.use('/api/admin', security.standardLimiter, adminRouter);
app.use('/api/drivers', security.standardLimiter, driversRouter);
app.use('/api/orders', security.standardLimiter, ordersRouter);
app.use('/api/dispatch', security.standardLimiter, dispatchRouter);
app.use('/api/passengers', security.standardLimiter, passengersRouter);
app.use('/api/earnings', security.standardLimiter, earningsRouter);

// ============================================
// Socket.io 連接處理（優化版）
// ============================================

// Socket 連線限制
io.use((socket, next) => {
  const req = socket.request as any;
  req.ip = socket.handshake.address;

  security.socketConnectionLimiter(req, {} as any, (err?: any) => {
    if (err) {
      return next(new Error('Too many connection attempts'));
    }
    next();
  });
});

io.on('connection', (socket) => {
  logSocketEvent('connection', socket.id);
  logger.info(`新連接: ${socket.id}`);

  // 司機上線
  socket.on('driver:online', async (data) => {
    logSocketEvent('driver:online', socket.id, data);
    const { driverId } = data;

    // 加入司機房間
    socket.join(`driver:${driverId}`);

    // 記錄司機socket
    driverSockets.set(driverId, socket.id);

    // 使用批次更新佇列
    batchUpdater.queueStatusUpdate(driverId, 'AVAILABLE');

    logger.info(`司機 ${driverId} 已上線`);
  });

  // 司機狀態更新
  socket.on('driver:status', async (data) => {
    logSocketEvent('driver:status', socket.id, data);
    const { driverId, status } = data;

    // 使用批次更新
    batchUpdater.queueStatusUpdate(driverId, status);

    // 如果司機離線，從位置列表中移除
    if (status === 'OFFLINE') {
      const { driverLocations } = require('./socket');
      driverLocations.delete(driverId);
      await cache.clearCache(`driver:location:${driverId}`);
    }

    // 廣播給所有在線乘客
    const { broadcastNearbyDrivers } = require('./socket');
    broadcastNearbyDrivers();
  });

  // 司機定位更新（使用批次更新）
  socket.on('driver:location', async (data) => {
    logSocketEvent('driver:location', socket.id, data);
    const { driverId, lat, lng, speed, bearing } = data;

    // 使用批次更新佇列
    batchUpdater.queueLocationUpdate(driverId, {
      lat,
      lng,
      speed: speed || 0,
      bearing: bearing || 0
    });

    // 更新記憶體中的位置
    const { driverLocations, broadcastNearbyDrivers } = require('./socket');
    driverLocations.set(driverId, {
      driverId,
      lat,
      lng,
      speed: speed || 0,
      bearing: bearing || 0,
      timestamp: Date.now()
    });

    // 廣播給乘客
    broadcastNearbyDrivers();
  });

  // 乘客上線
  socket.on('passenger:online', async (data) => {
    logSocketEvent('passenger:online', socket.id, data);
    const { passengerId } = data;

    // 加入乘客房間
    socket.join(`passenger:${passengerId}`);

    // 記錄乘客socket
    passengerSockets.set(passengerId, socket.id);

    logger.info(`乘客 ${passengerId} 已上線`);

    // 從快取獲取附近司機
    const { driverLocations } = require('./socket');
    const nearbyDrivers = Array.from(driverLocations.values()).map((loc: any) => ({
      driverId: loc.driverId,
      location: {
        lat: loc.lat,
        lng: loc.lng
      },
      timestamp: loc.timestamp
    }));

    socket.emit('nearby:drivers', nearbyDrivers);
  });

  // 斷線處理
  socket.on('disconnect', async () => {
    logSocketEvent('disconnect', socket.id);

    // 移除司機socket映射
    for (const [driverId, socketId] of driverSockets.entries()) {
      if (socketId === socket.id) {
        driverSockets.delete(driverId);
        batchUpdater.queueStatusUpdate(driverId, 'OFFLINE');
        logger.info(`司機 ${driverId} 已離線`);
        break;
      }
    }

    // 移除乘客socket映射
    for (const [passengerId, socketId] of passengerSockets.entries()) {
      if (socketId === socket.id) {
        passengerSockets.delete(passengerId);
        logger.info(`乘客 ${passengerId} 已離線`);
        break;
      }
    }
  });
});

// ============================================
// 錯誤處理
// ============================================

// 404 處理
app.use((req, res, next) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: '請求的資源不存在',
    path: req.path
  });
});

// 全域錯誤處理
app.use((err: any, req: any, res: any, next: any) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method
  });

  res.status(err.status || 500).json({
    error: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'production'
      ? '伺服器內部錯誤'
      : err.message
  });
});

// ============================================
// 啟動伺服器
// ============================================

httpServer.listen(PORT, async () => {
  // 啟動批次更新服務
  batchUpdater.startBatchUpdater();

  // 記錄系統啟動
  systemLogger.logStartup({
    port: PORT,
    environment: process.env.NODE_ENV,
    features: {
      redis: true,
      batchUpdates: true,
      rateLimiting: true,
      compression: true,
      logging: true
    }
  });

  console.log(`
╔════════════════════════════════════════════╗
║   花蓮計程車司機端 Server (優化版)         ║
║                                            ║
║   HTTP: http://localhost:${PORT}            ║
║   WebSocket: ws://localhost:${PORT}         ║
║   管理後台: http://localhost:${PORT}/admin  ║
║   環境: ${process.env.NODE_ENV || 'development'}                ║
║                                            ║
║   優化功能:                                ║
║   ✓ Redis 快取                            ║
║   ✓ 批次更新                              ║
║   ✓ Rate Limiting                         ║
║   ✓ 資料庫連線池優化                      ║
║   ✓ Winston 日誌系統                      ║
║   ✓ 壓縮與安全頭                          ║
╚════════════════════════════════════════════╝
  `);
});

// ============================================
// 優雅關閉處理
// ============================================

const gracefulShutdown = async (signal: string) => {
  systemLogger.logShutdown(signal);
  console.log(`\n收到 ${signal} 信號，開始優雅關閉...`);

  // 停止接受新連線
  httpServer.close(() => {
    console.log('HTTP 伺服器已關閉');
  });

  // 關閉 Socket.io
  io.close(() => {
    console.log('Socket.io 已關閉');
  });

  // 執行批次更新
  await batchUpdater.flushBatchUpdates();
  await batchUpdater.stopBatchUpdater();

  // 關閉資料庫連線
  const { closePool } = require('./db/connection');
  await closePool();

  // 關閉 Redis
  await cache.closeRedis();

  console.log('優雅關閉完成');
  process.exit(0);
};

// 監聽關閉信號
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 未處理的 Promise 拒絕
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', {
    reason,
    promise
  });
});

// 未捕獲的異常
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', {
    error: error.message,
    stack: error.stack
  });

  // 給予時間記錄錯誤後關閉
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

export default app;
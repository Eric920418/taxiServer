import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import driversRouter from './api/drivers';
import ordersRouter from './api/orders';
import passengersRouter from './api/passengers';
import earningsRouter from './api/earnings';
import dispatchRouter from './api/dispatch';
import dispatchV2Router from './api/dispatch-v2';
import authRouter from './api/auth';
import adminRouter from './api/admin';
import ratingsRouter from './api/ratings';
import whisperRouter from './api/whisper';
import { setSocketIO, driverSockets, passengerSockets } from './socket';
import { onDriverOnline } from './services/OrderDispatcher';
import { initSmartDispatcherV2, getSmartDispatcherV2 } from './services/SmartDispatcherV2';
import { initETAService } from './services/ETAService';
import { initRejectionPredictor } from './services/RejectionPredictor';
import { initWhisperService } from './services/WhisperService';
import pool from './db/connection';

// 載入環境變數
dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // 開發階段允許所有來源，生產環境要改
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

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
      // 不使用 upgradeInsecureRequests，因為目前沒有 HTTPS
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false
}));

// Middleware
app.use(cors());
app.use(express.json());

// 提供管理後台靜態檔案
const adminPanelPath = path.join(__dirname, '../admin-panel/dist');
app.use('/admin', express.static(adminPanelPath));

// 基礎路由
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: '花蓮計程車司機端Server',
    version: '1.0.0-MVP',
    timestamp: new Date().toISOString()
  });
});

// 健康檢查
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
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

// 初始化智能派單系統 V2
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
if (!GOOGLE_MAPS_API_KEY) {
  console.warn('[警告] 未設置 GOOGLE_MAPS_API_KEY，ETA 服務將僅使用估算模式');
}

// 初始化服務（順序重要：ETAService -> RejectionPredictor -> SmartDispatcherV2）
initETAService(pool, GOOGLE_MAPS_API_KEY);
initRejectionPredictor(pool);
initSmartDispatcherV2(pool);
initWhisperService();

console.log('[系統] 智能派單系統 V2 已初始化');
console.log('[系統] Whisper 語音服務已初始化');

// API路由
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/drivers', driversRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/dispatch', dispatchRouter);
app.use('/api/dispatch/v2', dispatchV2Router);
app.use('/api/passengers', passengersRouter);
app.use('/api/earnings', earningsRouter);
app.use('/api/ratings', ratingsRouter);
app.use('/api/whisper', whisperRouter);

// Socket.io 連接處理
io.on('connection', (socket) => {
  console.log(`[Socket] 新連接: ${socket.id}`);

  // 司機上線
  socket.on('driver:online', async (data) => {
    console.log('[Driver] 上線:', data);
    const { driverId } = data;

    // 加入司機房間
    socket.join(`driver:${driverId}`);

    // 記錄司機socket
    driverSockets.set(driverId, socket.id);

    // 更新數據庫：設置司機為可接單狀態
    try {
      const { query } = require('./db/connection');
      await query(`
        UPDATE drivers
        SET availability = 'AVAILABLE',
            last_heartbeat = CURRENT_TIMESTAMP
        WHERE driver_id = $1
      `, [driverId]);
      console.log(`[Driver] ${driverId} 已上線，Socket: ${socket.id}，數據庫已更新`);

      // 通知 OrderDispatcher 有新司機上線，推送待派發訂單（舊版兼容）
      onDriverOnline(driverId);

      // SmartDispatcherV2 會在派單時動態查詢在線司機，無需額外通知
    } catch (error) {
      console.error('[Driver] 更新上線狀態失敗:', error);
      console.log(`[Driver] ${driverId} 已上線，Socket: ${socket.id}`);
    }
  });

  // 【新增】司機狀態更新（關鍵修復：實時通知乘客端）
  socket.on('driver:status', async (data) => {
    console.log('[Driver] 狀態更新:', data);

    const { driverId, status } = data;

    // 更新數據庫中的司機狀態
    try {
      const { query } = require('./db/connection');
      await query(`
        UPDATE drivers
        SET availability = $1,
            last_heartbeat = CURRENT_TIMESTAMP
        WHERE driver_id = $2
      `, [status, driverId]);
      console.log(`[Driver] ${driverId} 狀態已更新為 ${status}`);
    } catch (error) {
      console.error('[Driver] 更新狀態失敗:', error);
    }

    // 【關鍵】如果司機離線，從位置列表中移除
    if (status === 'OFFLINE') {
      const { driverLocations } = require('./socket');
      driverLocations.delete(driverId);
      console.log(`[Driver] ${driverId} 已從位置列表移除`);
    }

    // 【關鍵】立即廣播給所有在線乘客，讓他們實時更新司機列表
    const { broadcastNearbyDrivers } = require('./socket');
    broadcastNearbyDrivers();
    console.log(`[Driver] 已廣播狀態變化給所有乘客`);
  });

  // 司機定位更新
  socket.on('driver:location', async (data) => {
    console.log('[Location]', data);

    const { driverId, lat, lng, speed, bearing } = data;

    // 儲存司機位置到內存
    const { driverLocations, broadcastNearbyDrivers } = require('./socket');
    driverLocations.set(driverId, {
      driverId,
      lat,
      lng,
      speed: speed || 0,
      bearing: bearing || 0,
      timestamp: Date.now()
    });

    // 同時更新數據庫（重要！讓 API 查詢能找到司機）
    try {
      const { query } = require('./db/connection');
      await query(`
        UPDATE drivers
        SET current_lat = $1,
            current_lng = $2,
            last_heartbeat = CURRENT_TIMESTAMP
        WHERE driver_id = $3
      `, [lat, lng, driverId]);
    } catch (error) {
      console.error('[Location] 更新數據庫失敗:', error);
    }

    // 立即廣播給所有在線乘客
    broadcastNearbyDrivers();
  });

  // 乘客上線
  socket.on('passenger:online', (data) => {
    console.log('[Passenger] 上線:', data);
    const { passengerId } = data;

    // 加入乘客房間
    socket.join(`passenger:${passengerId}`);

    // 記錄乘客socket
    passengerSockets.set(passengerId, socket.id);

    console.log(`[Passenger] ${passengerId} 已上線，Socket: ${socket.id}`);

    // 立即推送附近司機
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
    console.log(`[Socket] 斷線: ${socket.id}`);

    // 移除司機socket映射並更新數據庫
    for (const [driverId, socketId] of driverSockets.entries()) {
      if (socketId === socket.id) {
        driverSockets.delete(driverId);

        // 更新數據庫：設置司機為離線
        try {
          const { query } = require('./db/connection');
          await query(`
            UPDATE drivers
            SET availability = 'OFFLINE'
            WHERE driver_id = $1
          `, [driverId]);
          console.log(`[Driver] ${driverId} 已離線，數據庫已更新`);
        } catch (error) {
          console.error('[Driver] 更新離線狀態失敗:', error);
          console.log(`[Driver] ${driverId} 已離線`);
        }
        break;
      }
    }

    // 移除乘客socket映射
    for (const [passengerId, socketId] of passengerSockets.entries()) {
      if (socketId === socket.id) {
        passengerSockets.delete(passengerId);
        console.log(`[Passenger] ${passengerId} 已離線`);
        break;
      }
    }
  });
});

// 管理後台 SPA 路由處理（必須放在最後）
app.get('/admin{/*path}', (req, res) => {
  res.sendFile(path.join(adminPanelPath, 'index.html'));
});

// 啟動伺服器
httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   花蓮計程車司機端 Server 已啟動            ║
║                                            ║
║   HTTP: http://localhost:${PORT}            ║
║   WebSocket: ws://localhost:${PORT}         ║
║   管理後台: http://localhost:${PORT}/admin  ║
║   派單系統: V2 (智能分層派單)               ║
║   環境: ${process.env.NODE_ENV || 'development'}                ║
╚════════════════════════════════════════════╝
  `);
});

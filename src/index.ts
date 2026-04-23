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
import adminLandmarksRouter from './api/admin-landmarks';
import adminAddressFailuresRouter from './api/admin-address-failures';
import landmarksSyncRouter from './api/landmarks';
import ratingsRouter from './api/ratings';
import whisperRouter from './api/whisper';
import configRouter from './api/config';
import phoneCallsRouter from './api/phone-calls';
import lineWebhookRouter from './api/line-webhook';
import lineLiffRouter from './api/line-liff';
import { middleware as lineMiddleware } from '@line/bot-sdk';
import { setSocketIO, driverSockets, passengerSockets, adminSockets } from './socket';
import { onDriverOnline } from './services/OrderDispatcher';
import { initSmartDispatcherV2, getSmartDispatcherV2 } from './services/SmartDispatcherV2';
import { initETAService } from './services/ETAService';
import { initRejectionPredictor } from './services/RejectionPredictor';
import { initWhisperService } from './services/WhisperService';
import { initPhoneCallProcessor } from './services/PhoneCallProcessor';
import { initLineMessageProcessor } from './services/LineMessageProcessor';
import { initLineNotifier } from './services/LineNotifier';
import { initScheduledOrderService } from './services/ScheduledOrderService';
import { hualienAddressDB } from './services/HualienAddressDB';
import pool from './db/connection';

// 載入環境變數
dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // 開發階段允許所有來源，生產環境要改
    methods: ['GET', 'POST']
  },
  pingInterval: 25000,   // 每 25 秒 ping
  pingTimeout: 20000,    // 20 秒內沒回應才斷開
});

const PORT = process.env.PORT || 3000;

// LIFF 靜態頁面（在 Helmet 之前掛載，跳過 CSP 限制）
const liffPath = path.join(__dirname, '../public/liff');
app.use('/liff', express.static(liffPath));

// 隱私政策頁面（Google Play / App Store 需求）
app.get('/privacy', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/privacy.html'));
});

// 刪除帳戶頁面（Google Play Data Safety 必填）
app.get('/delete-account', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/delete-account.html'));
});

// Helmet 安全頭 - 配置適合管理後台的 CSP
// 已加 Google Maps JS SDK 白名單（Admin Panel 地標管理頁面用）
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'", "'unsafe-inline'", "'unsafe-eval'",
        "https://maps.googleapis.com",
        "https://maps.gstatic.com",
      ],
      styleSrc: [
        "'self'", "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://maps.googleapis.com",
      ],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      imgSrc: [
        "'self'", "data:", "https:", "http:",
        "https://maps.googleapis.com",
        "https://maps.gstatic.com",
        "https://*.googleapis.com",
        "https://*.gstatic.com",
      ],
      connectSrc: [
        "'self'", "ws:", "wss:", "http:", "https:",
        "https://maps.googleapis.com",
        "https://*.googleapis.com",
      ],
      frameSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"],
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

// LINE Webhook 必須在 express.json() 之前掛載（LINE SDK 需要 raw body 驗證簽名）
const lineChannelSecret = process.env.LINE_CHANNEL_SECRET;
if (lineChannelSecret) {
  app.use('/api/line/webhook', lineMiddleware({ channelSecret: lineChannelSecret }));
}

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

// 初始化電話叫車處理管線
try {
  initPhoneCallProcessor(pool);
  console.log('[系統] 電話叫車處理管線已初始化');
} catch (error) {
  console.warn('[系統] 電話叫車處理管線初始化失敗（需要 OPENAI_API_KEY）:', (error as Error).message);
}

// 初始化 LINE 叫車處理引擎
if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET) {
  try {
    initLineMessageProcessor(pool);
    initLineNotifier(pool);
    initScheduledOrderService(pool);
    console.log('[系統] LINE 叫車處理引擎已初始化（含預約排程）');

    // LINE 對話超時清理（每 10 分鐘掃描一次，超過 30 分鐘未更新的對話重置為 IDLE）
    setInterval(async () => {
      try {
        const result = await pool.query(`
          UPDATE line_users
          SET conversation_state = 'IDLE', conversation_data = '{}'
          WHERE conversation_state != 'IDLE'
            AND updated_at < NOW() - INTERVAL '30 minutes'
          RETURNING line_user_id
        `);
        if (result.rowCount && result.rowCount > 0) {
          console.log(`[LINE] 已清理 ${result.rowCount} 個超時對話`);
        }
      } catch (err) {
        console.error('[LINE] 對話超時清理失敗:', err);
      }
    }, 10 * 60 * 1000);
  } catch (error) {
    console.warn('[系統] LINE 叫車處理引擎初始化失敗:', (error as Error).message);
  }
} else {
  console.log('[系統] LINE 未設定（需要 LINE_CHANNEL_ACCESS_TOKEN + LINE_CHANNEL_SECRET）');
}

console.log('[系統] 智能派單系統 V2 已初始化');
console.log('[系統] Whisper 語音服務已初始化');

// API路由
app.use('/api/auth', authRouter);
app.use('/api/admin/landmarks', adminLandmarksRouter);
app.use('/api/admin/address-failures', adminAddressFailuresRouter);
app.use('/api/admin', adminRouter);
app.use('/api/landmarks', landmarksSyncRouter);
app.use('/api/drivers', driversRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/dispatch', dispatchRouter);
app.use('/api/dispatch/v2', dispatchV2Router);
app.use('/api/passengers', passengersRouter);
app.use('/api/earnings', earningsRouter);
app.use('/api/ratings', ratingsRouter);
app.use('/api/whisper', whisperRouter);
app.use('/api/config', configRouter);
app.use('/api/phone-calls', phoneCallsRouter);
app.use('/api/line', lineWebhookRouter);
app.use('/api/line/liff', lineLiffRouter);

// Haversine 公式計算兩點間距離（公尺）
function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // 地球半徑（公尺）
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

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

      // 檢查待派發的電話訂單（30分鐘內）
      try {
        const pendingPhoneOrders = await query(`
          SELECT order_id FROM orders
          WHERE status = 'PENDING' AND source = 'PHONE'
            AND created_at > NOW() - INTERVAL '30 minutes'
          ORDER BY created_at ASC LIMIT 1
        `);
        if (pendingPhoneOrders.rows.length > 0) {
          const pendingOrderId = pendingPhoneOrders.rows[0].order_id;
          console.log(`[Driver] 有待派發電話訂單: ${pendingOrderId}，延遲 2 秒後重新派單`);
          setTimeout(async () => {
            try {
              const dispatcher = getSmartDispatcherV2();
              const orderResult = await query(`
                SELECT * FROM orders WHERE order_id = $1
              `, [pendingOrderId]);
              if (orderResult.rows.length > 0) {
                const order = orderResult.rows[0];
                await dispatcher.startDispatch({
                  orderId: order.order_id,
                  passengerId: order.passenger_id,
                  passengerName: order.passenger_id,
                  passengerPhone: order.customer_phone || '',
                  pickup: {
                    lat: parseFloat(order.pickup_lat),
                    lng: parseFloat(order.pickup_lng),
                    address: order.pickup_address || ''
                  },
                  destination: order.dest_lat ? {
                    lat: parseFloat(order.dest_lat),
                    lng: parseFloat(order.dest_lng),
                    address: order.dest_address || ''
                  } : null,
                  paymentType: order.payment_type || 'CASH',
                  createdAt: new Date(order.created_at).getTime(),
                  source: 'PHONE'
                });
                console.log(`[Driver] 電話訂單 ${pendingOrderId} 重新派單成功`);
              }
            } catch (err) {
              console.error(`[Driver] 重新派單失敗:`, err);
            }
          }, 2000);
        }
      } catch (pendingErr) {
        console.error('[Driver] 檢查待派發電話訂單失敗:', pendingErr);
      }
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

      // 【關鍵】查找該司機是否有進行中的訂單，並轉發位置給乘客
      const activeOrderResult = await query(`
        SELECT order_id, passenger_id, pickup_lat, pickup_lng
        FROM orders
        WHERE driver_id = $1 AND status IN ('ACCEPTED', 'ARRIVED', 'PICKED_UP', 'ON_TRIP')
        LIMIT 1
      `, [driverId]);

      if (activeOrderResult.rows.length > 0) {
        const activeOrder = activeOrderResult.rows[0];
        const passengerSocketId = passengerSockets.get(activeOrder.passenger_id);

        if (passengerSocketId) {
          // 計算司機到上車點的距離（公尺）
          const pickupLat = parseFloat(activeOrder.pickup_lat);
          const pickupLng = parseFloat(activeOrder.pickup_lng);
          const distanceToPickup = calculateDistance(lat, lng, pickupLat, pickupLng);

          // 估算 ETA（假設平均時速 30km/h）
          const etaMinutes = Math.ceil(distanceToPickup / 1000 / 30 * 60);

          io.to(passengerSocketId).emit('driver:location', {
            orderId: activeOrder.order_id,
            driverId,
            lat,
            lng,
            speed: speed || 0,
            bearing: bearing || 0,
            distanceToPickup: Math.round(distanceToPickup),
            etaMinutes,
            timestamp: Date.now()
          });
          console.log(`[Location] 已轉發司機 ${driverId} 位置給乘客 ${activeOrder.passenger_id}，距離: ${Math.round(distanceToPickup)}m, ETA: ${etaMinutes}分`);
        }
      }
    } catch (error) {
      console.error('[Location] 更新數據庫失敗:', error);
    }

    // 立即廣播給所有在線乘客
    broadcastNearbyDrivers();
  });

  // 電話叫車：司機確認/修改目的地
  socket.on('order:destination-confirm', async (data) => {
    console.log('[PhoneOrder] 司機確認目的地:', data);

    const { orderId, driverId, confirmedAddress, confirmedLat, confirmedLng } = data;

    try {
      const { query } = require('./db/connection');

      // 更新訂單目的地
      if (confirmedLat && confirmedLng) {
        await query(`
          UPDATE orders
          SET dropoff_final = $1,
              dest_lat = $2,
              dest_lng = $3,
              dest_address = $1,
              destination_confirmed = TRUE
          WHERE order_id = $4
        `, [confirmedAddress, confirmedLat, confirmedLng, orderId]);
      } else {
        await query(`
          UPDATE orders
          SET dropoff_final = $1,
              destination_confirmed = TRUE
          WHERE order_id = $2
        `, [confirmedAddress || '司機已確認', orderId]);
      }

      console.log(`[PhoneOrder] 訂單 ${orderId} 目的地已確認: ${confirmedAddress || '原目的地'}`);

      // 回覆確認結果給司機
      socket.emit('order:destination-confirmed', {
        orderId,
        success: true,
        confirmedAddress: confirmedAddress || '已確認'
      });
    } catch (error) {
      console.error('[PhoneOrder] 確認目的地失敗:', error);
      socket.emit('order:destination-confirmed', {
        orderId,
        success: false,
        error: '確認失敗'
      });
    }
  });

  // 語音對講：轉發語音訊息
  socket.on('voice:message', async (data) => {
    console.log('[VoiceChat] 收到語音訊息:', data);

    const { orderId, senderId, senderType, senderName, messageText, messageId, timestamp } = data;

    try {
      // 根據訂單找到對方
      const { query } = require('./db/connection');
      const result = await query(`
        SELECT driver_id, passenger_id FROM orders WHERE order_id = $1
      `, [orderId]);

      if (result.rows.length === 0) {
        console.error('[VoiceChat] 訂單不存在:', orderId);
        return;
      }

      const order = result.rows[0];
      let recipientSocketId: string | undefined;
      let recipientType: string;

      // 判斷接收方
      if (senderType === 'driver') {
        // 發送者是司機，接收者是乘客
        recipientSocketId = passengerSockets.get(order.passenger_id);
        recipientType = 'passenger';
        console.log(`[VoiceChat] 司機 ${senderName} → 乘客 ${order.passenger_id}`);
      } else {
        // 發送者是乘客，接收者是司機
        recipientSocketId = driverSockets.get(order.driver_id);
        recipientType = 'driver';
        console.log(`[VoiceChat] 乘客 ${senderName} → 司機 ${order.driver_id}`);
      }

      if (recipientSocketId) {
        // 轉發訊息給對方
        io.to(recipientSocketId).emit('voice:message', {
          messageId: messageId || Date.now().toString(),
          orderId,
          senderId,
          senderType,
          senderName,
          messageText,
          timestamp: timestamp || Date.now()
        });
        console.log(`[VoiceChat] ✅ 訊息已轉發給 ${recipientType}`);
      } else {
        console.log(`[VoiceChat] ⚠️ ${recipientType} 不在線，無法轉發`);
      }
    } catch (error) {
      console.error('[VoiceChat] 轉發訊息失敗:', error);
    }
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

  // 管理員上線（需驗證 JWT token）
  socket.on('admin:online', (data) => {
    const { adminId, token } = data;
    if (!token) {
      console.warn(`[Admin] admin:online 缺少 token，拒絕: ${socket.id}`);
      return;
    }
    try {
      const jwt = require('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      if (decoded.adminId !== adminId) {
        console.warn(`[Admin] token adminId 不符: ${decoded.adminId} !== ${adminId}`);
        return;
      }
      adminSockets.set(adminId, socket.id);
      console.log(`[Admin] ${adminId} 已上線（已驗證），Socket: ${socket.id}`);
    } catch (err) {
      console.warn(`[Admin] admin:online token 驗證失敗:`, err);
    }
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

    // 移除管理員socket映射
    for (const [adminId, socketId] of adminSockets.entries()) {
      if (socketId === socket.id) {
        adminSockets.delete(adminId);
        console.log(`[Admin] ${adminId} 已離線`);
        break;
      }
    }
  });
});

// 管理後台 SPA 路由處理（必須放在最後）
app.get('/admin{/*path}', (req, res) => {
  res.sendFile(path.join(adminPanelPath, 'index.html'));
});

// ============================================================
// Process-level error handlers — last resort 防護網
// ============================================================
// 為什麼需要：Node 預設 uncaughtException → exit。某些 module（例如 ioredis 的
// redis-parser）會 throw 而非 emit 'error' event，繞過 cache.ts 的 redis.on('error')
// 攔截，把整個 server 帶倒。pm2 會 restart 但會在短時間內反覆崩潰（已觀察到 7 小時
// 重啟 48 次）。
//
// 策略：log 完整錯誤但不 exit，讓 server 繼續運作。若狀態真的損毀，pm2 會偵測
// 健康檢查失敗才介入 restart。SIGTERM / SIGINT 則正常處理 graceful shutdown。
//
// 注意：這只是 Layer 1 防護。長期應該每個 Redis 客戶端（cache.ts、queue.ts、
// circuit-breaker.ts）都加 try/catch + Redis 不可用時退化。Layer 2 留 TODO。
process.on('uncaughtException', (err) => {
  console.error('[Process] ⚠️ uncaughtException:', err);
  console.error('[Process] Stack:', err.stack);
  // 不 exit — 讓 server 繼續運作
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] ⚠️ unhandledRejection at:', promise);
  console.error('[Process] Reason:', reason);
  // 不 exit
});

// 啟動前先從 DB 載入地標索引（失敗則以空索引啟動，LINE/電話/語音叫車會降級到 Google API）
hualienAddressDB.rebuildIndex()
  .then(() => console.log('[系統] 地標索引初始化完成'))
  .catch((err) => console.error('[系統] 地標索引初始化失敗:', err));

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

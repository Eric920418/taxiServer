import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import driversRouter from './api/drivers';
import ordersRouter from './api/orders';
import passengersRouter from './api/passengers';
import earningsRouter from './api/earnings';
import dispatchRouter from './api/dispatch';
import authRouter from './api/auth';
import { setSocketIO, driverSockets, passengerSockets } from './socket';

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

// Middleware
app.use(cors());
app.use(express.json());

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

// 初始化Socket.io模組
setSocketIO(io);

// API路由
app.use('/api/auth', authRouter);
app.use('/api/drivers', driversRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/dispatch', dispatchRouter);
app.use('/api/passengers', passengersRouter);
app.use('/api/earnings', earningsRouter);

// Socket.io 連接處理
io.on('connection', (socket) => {
  console.log(`[Socket] 新連接: ${socket.id}`);

  // 司機上線
  socket.on('driver:online', (data) => {
    console.log('[Driver] 上線:', data);
    const { driverId } = data;

    // 加入司機房間
    socket.join(`driver:${driverId}`);

    // 記錄司機socket
    driverSockets.set(driverId, socket.id);

    console.log(`[Driver] ${driverId} 已上線，Socket: ${socket.id}`);
  });

  // 司機定位更新
  socket.on('driver:location', (data) => {
    console.log('[Location]', data);

    const { driverId, lat, lng, speed, bearing } = data;

    // 儲存司機位置
    const { driverLocations, broadcastNearbyDrivers } = require('./socket');
    driverLocations.set(driverId, {
      driverId,
      lat,
      lng,
      speed: speed || 0,
      bearing: bearing || 0,
      timestamp: Date.now()
    });

    // 定期廣播附近司機給所有乘客（每5秒一次）
    // 實際應該用更智能的方式，這裡先簡單實作
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
  socket.on('disconnect', () => {
    console.log(`[Socket] 斷線: ${socket.id}`);

    // 移除司機socket映射
    for (const [driverId, socketId] of driverSockets.entries()) {
      if (socketId === socket.id) {
        driverSockets.delete(driverId);
        console.log(`[Driver] ${driverId} 已離線`);
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

// 啟動伺服器
httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   花蓮計程車司機端 Server 已啟動            ║
║                                            ║
║   HTTP: http://localhost:${PORT}            ║
║   WebSocket: ws://localhost:${PORT}         ║
║   環境: ${process.env.NODE_ENV || 'development'}                ║
╚════════════════════════════════════════════╝
  `);
});

import { Server } from 'socket.io';

// Socket.io實例（將由index.ts設置）
let io: Server;

// 儲存司機socket映射 { driverId: socketId }
export const driverSockets = new Map<string, string>();

// 儲存乘客socket映射 { passengerId: socketId }
export const passengerSockets = new Map<string, string>();

// 儲存司機當前位置 { driverId: location }
interface DriverLocation {
  driverId: string;
  lat: number;
  lng: number;
  speed: number;
  bearing: number;
  timestamp: number;
}
export const driverLocations = new Map<string, DriverLocation>();

/**
 * 設置Socket.io實例
 */
export function setSocketIO(ioInstance: Server) {
  io = ioInstance;
}

/**
 * 取得Socket.io實例
 */
export function getSocketIO(): Server {
  if (!io) {
    throw new Error('Socket.io尚未初始化');
  }
  return io;
}

/**
 * 推播訂單給所有上線司機
 */
export function broadcastOrderToDrivers(order: any) {
  const onlineDriverCount = driverSockets.size;
  console.log(`[Order] 推播訂單給 ${onlineDriverCount} 位在線司機`);

  const offeredDrivers: string[] = [];

  driverSockets.forEach((socketId, driverId) => {
    io.to(socketId).emit('order:offer', order);
    console.log(`[Order] 已推播訂單 ${order.orderId} 給司機 ${driverId}`);
    offeredDrivers.push(driverId);
  });

  return offeredDrivers;
}

/**
 * 推播訂單狀態更新給乘客
 */
export function notifyPassengerOrderUpdate(passengerId: string, order: any) {
  const socketId = passengerSockets.get(passengerId);

  if (socketId) {
    io.to(socketId).emit('order:update', order);
    console.log(`[Passenger] 通知乘客 ${passengerId} 訂單更新:`, order.status);
    return true;
  } else {
    console.log(`[Passenger] 乘客 ${passengerId} 不在線，無法推播`);
    return false;
  }
}

/**
 * 推播司機位置給乘客
 */
export function notifyPassengerDriverLocation(passengerId: string, driverLocation: any) {
  const socketId = passengerSockets.get(passengerId);

  if (socketId) {
    io.to(socketId).emit('driver:location', driverLocation);
    return true;
  }
  return false;
}

/**
 * 廣播附近司機給所有在線乘客
 */
export function broadcastNearbyDrivers() {
  const nearbyDrivers = Array.from(driverLocations.values()).map(loc => ({
    driverId: loc.driverId,
    location: {
      lat: loc.lat,
      lng: loc.lng
    },
    timestamp: loc.timestamp
  }));

  passengerSockets.forEach((socketId, passengerId) => {
    io.to(socketId).emit('nearby:drivers', nearbyDrivers);
  });
}

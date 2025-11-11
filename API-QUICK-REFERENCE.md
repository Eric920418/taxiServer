# 花蓮計程車系統 - API 速查表

## 基礎資訊

**伺服器地址**：http://54.180.244.231:3000
**開發環境**：http://localhost:3000
**文檔版本**：v1.0.0-MVP

---

## 認證 API `/api/auth`

### 1. 司機登入
```http
POST /api/auth/phone-verify-driver
Content-Type: application/json

{
  "phone": "0912345678",
  "firebaseUid": "firebase_uid_from_client"
}

响應 200:
{
  "success": true,
  "token": "token_D001_1762768193719",
  "driverId": "D001",
  "name": "王大明",
  "phone": "0912345678",
  "plate": "ABC-1234",
  "availability": "OFFLINE",
  "rating": 5,
  "totalTrips": 0
}
```

### 2. 乘客登入/註冊
```http
POST /api/auth/phone-verify-passenger
Content-Type: application/json

{
  "phone": "0911111111",
  "firebaseUid": "firebase_uid_from_client",
  "name": "測試乘客A"  // 可選
}

响應 200:
{
  "success": true,
  "passengerId": "PASS001",
  "phone": "0911111111",
  "name": "測試乘客A",
  "totalRides": 0,
  "rating": 5.0
}
```

---

## 司機管理 API `/api/drivers`

### 1. 查詢司機資訊
```http
GET /api/drivers/:driverId

例: GET /api/drivers/D001

响應 200:
{
  "driverId": "D001",
  "name": "王大明",
  "phone": "0912345678",
  "plate": "ABC-1234",
  "availability": "AVAILABLE",
  "currentLocation": {
    "lat": 23.98,
    "lng": 121.60
  },
  "rating": 4.8,
  "totalTrips": 42,
  "totalEarnings": 12500,
  "acceptanceRate": 95.2
}
```

### 2. 更新司機狀態
```http
PATCH /api/drivers/:driverId/status
Content-Type: application/json

{
  "availability": "AVAILABLE"  // OFFLINE | REST | AVAILABLE | ON_TRIP
}

响應 200:
{
  "driverId": "D001",
  "name": "王大明",
  "availability": "AVAILABLE"
}
```

### 3. 更新司機位置
```http
PATCH /api/drivers/:driverId/location
Content-Type: application/json

{
  "lat": 23.9845,
  "lng": 121.6082,
  "speed": 30,      // km/h
  "bearing": 45     // 0-360度
}

响應 200:
{
  "success": true
}
```

---

## 訂單管理 API `/api/orders`

### 1. 建立訂單
```http
POST /api/orders
Content-Type: application/json

{
  "passengerName": "測試乘客",
  "passengerPhone": "0900123456",
  "pickupLat": 23.9845,
  "pickupLng": 121.6082,
  "pickupAddress": "花蓮市中心",
  "destLat": 23.99,
  "destLng": 121.61,
  "destAddress": "火車站",
  "paymentType": "CASH"  // CASH | LOVE_CARD_PHYSICAL | OTHER
}

响應 200:
{
  "success": true,
  "order": {
    "orderId": "ORD1730768193719",
    "passengerId": "PASS123",
    "status": "OFFERED",
    "pickup": {...},
    "destination": {...},
    "paymentType": "CASH"
  },
  "offeredTo": ["D001", "D002", "D003"]  // 推送給的司機清單
}
```

### 2. 查詢訂單列表
```http
GET /api/orders?status=DONE&driverId=D001&limit=50&offset=0

参数：
  - status: PENDING | OFFERED | ACCEPTED | ARRIVED | ON_TRIP | SETTLING | DONE | CANCELLED
  - driverId: 司機ID（可選）
  - limit: 每頁筆數（預設100）
  - offset: 偏移量（預設0）

响應 200:
{
  "orders": [...],
  "total": 42
}
```

### 3. 查詢單一訂單
```http
GET /api/orders/:orderId

例: GET /api/orders/ORD1730768193719

响應 200:
{
  "orderId": "ORD1730768193719",
  "passengerId": "PASS001",
  "driverId": "D001",
  "status": "ACCEPTED",
  "pickup": {
    "lat": 23.9845,
    "lng": 121.6082,
    "address": "花蓮市中心"
  },
  "destination": {...},
  "paymentType": "CASH",
  "meterAmount": 250,
  "createdAt": "2025-11-11T10:30:00Z",
  "acceptedAt": "2025-11-11T10:32:15Z",
  "completedAt": null
}
```

### 4. 司機接單
```http
PATCH /api/orders/:orderId/accept
Content-Type: application/json

{
  "driverId": "D001",
  "driverName": "王大明"
}

响應 200:
{
  "success": true,
  "message": "接單成功",
  "order": {
    "orderId": "ORD1730768193719",
    "passengerId": "PASS001",
    "driverId": "D001",
    "status": "ACCEPTED",
    "acceptedAt": "2025-11-11T10:32:15Z"
  }
}
```

### 5. 司機拒單
```http
PATCH /api/orders/:orderId/reject
Content-Type: application/json

{
  "driverId": "D001",
  "reason": "司機忙碌"  // 可選
}

响應 200:
{
  "success": true,
  "message": "已拒絕訂單"
}
```

### 6. 更新訂單狀態
```http
PATCH /api/orders/:orderId/status
Content-Type: application/json

{
  "status": "ON_TRIP",  // 見上方狀態列表
  "driverId": "D001"    // 可選
}

响應 200:
{
  "success": true,
  "order": {
    "orderId": "ORD1730768193719",
    "status": "ON_TRIP"
  }
}
```

### 7. 提交車資
```http
PATCH /api/orders/:orderId/fare
Content-Type: application/json

{
  "meterAmount": 280,        // 跳表金額
  "distance": 2.45,          // 實際距離(km)
  "duration": 15,            // 實際時間(分鐘)
  "photoUrl": "https://..."  // 跳表照片URL（可選）
}

响應 200:
{
  "success": true,
  "order": {
    "orderId": "ORD1730768193719",
    "status": "SETTLING",
    "meterAmount": 280
  }
}
```

---

## 乘客管理 API `/api/passengers`

### 1. 查詢附近司機
```http
GET /api/passengers/nearby-drivers?lat=23.9845&lng=121.6082&radius=5000

参数：
  - lat: 乘客緯度（必須）
  - lng: 乘客經度（必須）
  - radius: 搜尋半徑，公尺（預設5000）

响應 200:
{
  "success": true,
  "drivers": [
    {
      "driverId": "D001",
      "name": "王大明",
      "plate": "ABC-1234",
      "location": {
        "lat": 23.9845,
        "lng": 121.6082
      },
      "rating": 4.8,
      "distance": 450,   // 公尺
      "eta": 9           // 預估分鐘數
    }
  ],
  "count": 3
}
```

### 2. 叫車請求
```http
POST /api/passengers/request-ride
Content-Type: application/json

{
  "passengerId": "PASS001",
  "passengerName": "測試乘客A",
  "passengerPhone": "0911111111",
  "pickupLat": 23.9845,
  "pickupLng": 121.6082,
  "pickupAddress": "花蓮火車站",
  "destLat": 23.99,
  "destLng": 121.61,
  "destAddress": "遠百花蓮店",
  "paymentType": "CASH"
}

响應 200:
{
  "success": true,
  "order": {...},
  "message": "叫車請求已發送，等待司機接單"
}
```

### 3. 取消訂單
```http
POST /api/passengers/cancel-order
Content-Type: application/json

{
  "orderId": "ORD1730768193719",
  "passengerId": "PASS001",
  "reason": "改變主意"  // 可選
}

响應 200:
{
  "success": true,
  "message": "訂單已取消"
}
```

### 4. 查詢訂單歷史
```http
GET /api/passengers/:passengerId/orders?status=DONE&limit=50&offset=0

参数：
  - status: 狀態篩選（可選）
  - limit: 每頁筆數（預設50）
  - offset: 偏移量（預設0）

响應 200:
{
  "success": true,
  "orders": [
    {
      "orderId": "ORD1730768193719",
      "driverId": "D001",
      "driverName": "王大明",
      "driverPlate": "ABC-1234",
      "pickup": {...},
      "destination": {...},
      "status": "DONE",
      "paymentType": "CASH",
      "meterAmount": 250,
      "createdAt": "2025-11-11T10:30:00Z",
      "completedAt": "2025-11-11T10:45:30Z"
    }
  ],
  "total": 42
}
```

---

## 收入統計 API `/api/earnings`

### 1. 收入排行榜
```http
GET /api/earnings/leaderboard?period=today

参数：
  - period: today | week | month（預設today）

响應 200:
{
  "success": true,
  "period": "today",
  "leaderboard": [
    {
      "rank": 1,
      "driverId": "D001",
      "name": "王大明",
      "plate": "ABC-1234",
      "orderCount": 15,
      "totalEarnings": 4500
    }
  ]
}
```

### 2. 司機收入統計
```http
GET /api/earnings/:driverId?period=today

参数：
  - period: today | week | month（預設today）

响應 200:
{
  "success": true,
  "driverId": "D001",
  "earnings": {
    "period": "today",
    "totalAmount": 4500,
    "orderCount": 15,
    "totalDistance": 42.5,
    "totalDuration": 6.5,      // 小時
    "averageFare": 300,
    "orders": [                 // period=today 時才有
      {
        "orderId": "ORD001",
        "fare": 280,
        "distance": 2.45,
        "duration": 15,         // 分鐘
        "completedAt": 1730768190000
      }
    ],
    // 或 dailyBreakdown（period=week）
    // 或 weeklyBreakdown（period=month）
  }
}
```

### 3. 司機訂單明細
```http
GET /api/earnings/:driverId/orders?status=DONE&startDate=2025-11-01&endDate=2025-11-30&limit=50&offset=0

参数：
  - status: 狀態篩選（可選）
  - startDate: 開始日期 YYYY-MM-DD（可選）
  - endDate: 結束日期 YYYY-MM-DD（可選）
  - limit: 每頁筆數（預設50）
  - offset: 偏移量（預設0）

响應 200:
{
  "success": true,
  "orders": [
    {
      "orderId": "ORD001",
      "passengerId": "PASS001",
      "passengerName": "測試乘客A",
      "passengerPhone": "0911111111",
      "pickup": {...},
      "destination": {...},
      "status": "DONE",
      "paymentType": "CASH",
      "fare": 280,
      "distance": 2.45,
      "duration": 15,
      "createdAt": "2025-11-11T10:30:00Z",
      "completedAt": "2025-11-11T10:45:30Z"
    }
  ],
  "total": 42
}
```

---

## 派單 API `/api/dispatch`

### 1. 智能派單
```http
POST /api/dispatch/smart
Content-Type: application/json

{
  "orderId": "ORD1730768193719",
  "pickupLat": 23.9845,
  "pickupLng": 121.6082,
  "destLat": 23.99,
  "destLng": 121.61,
  "passengerId": "PASS001"
}

响應 200:
{
  "success": true,
  "data": {
    "recommendedDrivers": ["D001", "D002"],
    "reason": "熱區優先派單 - 東大門夜市",
    "predictedETA": 8,      // 分鐘
    "score": 95.5
  }
}
```

### 2. 派單統計
```http
GET /api/dispatch/stats

响應 200:
{
  "success": true,
  "data": {
    "totalDispatches": 1250,
    "successRate": 92.3,
    "averageAcceptTime": 12,  // 秒
    "averageRejectCount": 2.1,
    "peakHour": 19,
    "hotZoneDistribution": {...}
  }
}
```

### 3. 熱區資訊
```http
GET /api/dispatch/hot-zones

响應 200:
{
  "success": true,
  "currentHour": 19,
  "hotZones": [
    {
      "name": "東大門夜市",
      "lat": 23.9986,
      "lng": 121.6083,
      "active": true,
      "weight": 1.5
    },
    {
      "name": "花蓮火車站",
      "lat": 23.9933,
      "lng": 121.6011,
      "active": false,
      "weight": 1.3
    }
  ]
}
```

### 4. 司機收入監控
```http
GET /api/dispatch/driver-earnings

响應 200:
{
  "success": true,
  "data": {
    "drivers": [
      {
        "driver_id": "D001",
        "name": "王大明",
        "today_earnings": 4500,
        "today_trips": 15,
        "current_status": "AVAILABLE"
      }
    ],
    "statistics": {
      "average": 3200,
      "minimum": 800,
      "maximum": 5200,
      "gap": 4400  // 收入差距
    }
  }
}
```

### 5. 模擬派單（測試用）
```http
POST /api/dispatch/simulate
Content-Type: application/json

{
  "count": 10  // 模擬派單數量
}

响應 200:
{
  "success": true,
  "simulationCount": 10,
  "results": [...]
}
```

---

## 系統狀態 API

### 1. 健康檢查
```http
GET /health

响應 200:
{
  "status": "healthy"
}
```

### 2. Socket.io 狀態
```http
GET /socket/health

响應 200:
{
  "status": "ok",
  "socketio": {
    "running": true,
    "engine": "active"
  },
  "connections": {
    "total": 42,
    "drivers": 25,
    "passengers": 17
  },
  "locations": {
    "tracked_drivers": 23
  },
  "timestamp": "2025-11-11T10:30:00.000Z"
}
```

---

## WebSocket 事件

### 客戶端 → 伺服器

#### 司機上線
```javascript
socket.emit('driver:online', {
  driverId: 'D001'
});
```

#### 司機位置更新
```javascript
socket.emit('driver:location', {
  driverId: 'D001',
  lat: 23.9845,
  lng: 121.6082,
  speed: 30,
  bearing: 45
});
```

#### 乘客上線
```javascript
socket.emit('passenger:online', {
  passengerId: 'PASS001'
});
```

### 伺服器 → 客戶端

#### 派單通知
```javascript
socket.on('order:offer', (data) => {
  // {
  //   orderId: string,
  //   passengerId: string,
  //   passengerName: string,
  //   passengerPhone: string,
  //   pickup: { lat, lng, address },
  //   destination: { lat, lng, address },
  //   status: string,
  //   paymentType: string,
  //   createdAt: timestamp
  // }
});
```

#### 訂單狀態更新
```javascript
socket.on('order:update', (data) => {
  // { orderId, status }
});
```

#### 司機位置廣播
```javascript
socket.on('driver:location', (data) => {
  // { driverId, lat, lng, speed, bearing }
});
```

#### 附近司機列表
```javascript
socket.on('nearby:drivers', (data) => {
  // [{ driverId, location: { lat, lng }, timestamp }]
});
```

---

## 錯誤碼參考

| 代碼 | 含義 | 處理方式 |
|------|------|---------|
| 200 | 成功 | - |
| 400 | 請求錯誤（缺少參數或格式錯誤） | 檢查請求格式 |
| 404 | 資源不存在 | 檢查ID是否正確 |
| 410 | API 已停用 | 使用新的 API 端點 |
| 500 | 伺服器錯誤 | 檢查伺服器日誌 |

### 常見錯誤响應
```json
{
  "error": "DRIVER_NOT_FOUND",
  "message": "此手機號碼尚未註冊為司機，請聯繫管理員"
}
```

---

## 測試帳號

### 司機帳號
| ID | 手機 | 姓名 | 車牌 |
|----|----|------|------|
| D001 | 0912345678 | 王大明 | ABC-1234 |
| D002 | 0987654321 | 李小華 | XYZ-5678 |
| D003 | 0965432100 | 陳建國 | DEF-9012 |

### 乘客帳號
| ID | 手機 | 姓名 |
|----|----|------|
| PASS001 | 0911111111 | 測試乘客A |
| PASS002 | 0922222222 | 測試乘客B |

---

## 測試工具

### curl 範例
```bash
# 查詢司機
curl -X GET http://localhost:3000/api/drivers/D001

# 建立訂單
curl -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "passengerName": "測試",
    "pickupLat": 23.9845,
    "pickupLng": 121.6082,
    "pickupAddress": "花蓮市"
  }'

# 接單
curl -X PATCH http://localhost:3000/api/orders/ORD123/accept \
  -H "Content-Type: application/json" \
  -d '{
    "driverId": "D001",
    "driverName": "王大明"
  }'
```

### Postman 集合
建議使用 Postman 導入此 API 文件進行測試

---

**最後更新**：2025-11-11
**API 版本**：v1.0.0

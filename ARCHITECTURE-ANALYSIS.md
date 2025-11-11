# 花蓮計程車系統後端架構分析報告
**分析日期：2025-11-11**
**系統版本：v1.0.0-MVP**

---

## 目錄
1. [執行摘要](#執行摘要)
2. [現有功能概覽](#現有功能概覽)
3. [詳細技術分析](#詳細技術分析)
4. [管理後台評估](#管理後台評估)
5. [安全性與權限分析](#安全性與權限分析)
6. [改進建議](#改進建議)

---

## 執行摘要

### 項目現狀
- **系統類型**：自建後端計程車派單系統（非Firebase）
- **技術棧**：Node.js + TypeScript + Express.js + PostgreSQL + Socket.io
- **代碼規模**：約2,486行 TypeScript
- **核心功能**：訂單管理、司機狀態、實時派單、位置追蹤、收入統計
- **部署環境**：VPS（IP: 54.180.244.231）+ 本地開發

### 管理後台現狀
⚠️ **目前不存在管理後台Web UI**，所有系統操作均依賴：
- REST API 調用
- 直接數據庫查詢
- 第三方客戶端（Android App）

---

## 現有功能概覽

### 1. 認證系統 ✅
**現有實現**：
```
方式：Firebase Phone Authentication（簡訊驗證）
端點：
  - POST /api/auth/phone-verify-driver
  - POST /api/auth/phone-verify-passenger
機制：
  1. 前端通過 Firebase 驗證手機號碼
  2. 獲取 firebaseUid
  3. 發送至後端進行身份確認
特點：
  - ✅ 自動乘客註冊
  - ✅ Firebase UID 存儲在數據庫
  - ⚠️ 缺少刷新令牌機制
  - ⚠️ Token 為簡易格式（`token_driverId_timestamp`），非JWT
```

### 2. API 路由結構

#### 認證模塊 (`/api/auth`)
```typescript
POST /api/auth/phone-verify-driver      // 司機登入
POST /api/auth/phone-verify-passenger   // 乘客登入/註冊
```

#### 司機管理 (`/api/drivers`)
```typescript
GET    /api/drivers/:driverId            // 查詢司機資訊
PATCH  /api/drivers/:driverId/status     // 更新上線狀態
PATCH  /api/drivers/:driverId/location   // 更新位置
```

#### 訂單管理 (`/api/orders`)
```typescript
GET    /api/orders                       // 查詢訂單（支持篩選）
POST   /api/orders                       // 建立訂單
GET    /api/orders/:orderId              // 查詢單一訂單
PATCH  /api/orders/:orderId/accept       // 司機接單
PATCH  /api/orders/:orderId/reject       // 司機拒單
PATCH  /api/orders/:orderId/status       // 更新狀態
PATCH  /api/orders/:orderId/fare         // 提交車資
```

#### 乘客管理 (`/api/passengers`)
```typescript
GET    /api/passengers/nearby-drivers    // 查詢附近司機
POST   /api/passengers/request-ride      // 請求叫車
POST   /api/passengers/cancel-order      // 取消訂單
GET    /api/passengers/:passengerId/orders  // 查詢訂單歷史
```

#### 收入統計 (`/api/earnings`)
```typescript
GET    /api/earnings/leaderboard         // 收入排行榜
GET    /api/earnings/:driverId           // 司機收入統計（含周期篩選）
GET    /api/earnings/:driverId/orders    // 司機訂單明細
```

#### 派單系統 (`/api/dispatch`)
```typescript
POST   /api/dispatch/smart               // 智能派單
GET    /api/dispatch/stats               // 派單統計
GET    /api/dispatch/hot-zones           // 熱區資訊
GET    /api/dispatch/driver-earnings     // 司機收入監控
POST   /api/dispatch/simulate            // 模擬派單（測試用）
```

### 3. 數據庫架構

#### 核心數據表（5張表）
```
✅ drivers (司機)
  - driver_id (PK)
  - phone, firebase_uid, name, plate
  - availability (OFFLINE|REST|AVAILABLE|ON_TRIP)
  - current_lat, current_lng, last_heartbeat
  - total_trips, total_earnings, rating, acceptance_rate, cancel_rate
  - created_at, updated_at

✅ passengers (乘客)
  - passenger_id (PK)
  - phone, firebase_uid, name
  - total_rides, total_spent, rating
  - created_at, updated_at

✅ orders (訂單 - AI訓練核心)
  - order_id (PK)
  - passenger_id, driver_id (FKs)
  - status (8狀態值)
  - pickup_lat, pickup_lng, pickup_address
  - dest_lat, dest_lng, dest_address
  - meter_amount, actual_distance_km, actual_duration_min
  - payment_type (CASH|LOVE_CARD_PHYSICAL|OTHER)
  - 時間字段：created_at, offered_at, accepted_at, arrived_at, started_at, completed_at, cancelled_at
  - AI特徵：hour_of_day, day_of_week, is_holiday, weather
  - offered_to_count, reject_count

✅ driver_locations (位置歷史)
  - location_id (SERIAL PK)
  - driver_id (FK)
  - lat, lng, speed, bearing
  - on_trip, order_id
  - recorded_at

✅ daily_earnings (每日收入統計)
  - earning_id (SERIAL PK)
  - driver_id (FK)
  - date (DATE)
  - total_trips, total_earnings, total_distance_km, total_duration_min, online_hours
  - created_at
```

#### 數據庫優化
- 15個索引（訂單查詢、位置查詢、收入統計、身份查詢）
- 3個自動更新觸發器（updated_at 字段）
- DECIMAL 精度設置（金額、距離、速度）

### 4. WebSocket 實時通訊

#### 事件類型
```javascript
// 客戶端 → 伺服器
'driver:online'         // 司機上線
'driver:location'       // 定位更新
'passenger:online'      // 乘客上線
'disconnect'            // 斷線

// 伺服器 → 客戶端
'order:offer'           // 派單通知
'order:update'          // 訂單狀態更新
'driver:location'       // 司機位置更新
'nearby:drivers'        // 附近司機列表
```

#### 實現機制
- 使用 Map 存儲 socket 映射
  - `driverSockets`: { driverId → socketId }
  - `passengerSockets`: { passengerId → socketId }
  - `driverLocations`: { driverId → {lat, lng, speed, bearing, timestamp} }
- 司機位置存儲在內存中
- 位置更新時同步至數據庫（`current_lat`, `current_lng`, `last_heartbeat`）

### 5. 派單系統

#### 支持的派單模式
1. **廣播派單**（當前）：推給所有在線司機
2. **智能派單**（SmartDispatcher）：基於規則引擎選擇最優司機

#### 智能派單規則
```typescript
// 熱區加權
const HOT_ZONES = {
  '東大門夜市': { weight: 1.5, peakHours: [18-22] },
  '花蓮火車站': { weight: 1.3, peakHours: [6-9, 17-18] },
  '遠百花蓮店': { weight: 1.2, peakHours: [15-20] },
  '太魯閣國家公園': { weight: 1.8, peakHours: [8-10, 15-16] }
}

// 黃金時段激勵
const GOLDEN_HOURS = {
  19: { revenueBoost: 1.5, priority: 'HIGH' },
  15: { revenueBoost: 1.4, priority: 'HIGH' },
  ...
}

// 司機類型分類
enum DriverType {
  FAST_TURNOVER,   // 快速週轉型
  LONG_DISTANCE,   // 長距離專家
  HIGH_VOLUME      // 訂單量大
}

// 派單評分
score = distance_score(50%) + acceptance_rate(30%) + rating(20%)
```

---

## 詳細技術分析

### 1. 技術棧

| 層級 | 選項 | 版本 |
|------|------|------|
| **運行環境** | Node.js | v20+ |
| **語言** | TypeScript | v5.9.3 |
| **Web框架** | Express.js | v5.1.0 |
| **實時通訊** | Socket.io | v4.8.1 |
| **資料庫** | PostgreSQL | v15+ |
| **緩存** | Redis | 配置中（未完成） |
| **HTTP客戶端** | axios | v1.12.2 |
| **開發工具** | ts-node, nodemon | 已配置 |

### 2. 項目結構

```
src/
├── index.ts                          # 主入口（6.4KB）
│   ├── Express 應用初始化
│   ├── Socket.io 連接處理
│   ├── 健康檢查端點
│   └── WebSocket 事件監聽
│
├── api/                              # REST API 路由
│   ├── auth.ts          (4.7KB)      # 認證（Firebase Phone Auth）
│   ├── drivers.ts       (3.5KB)      # 司機管理
│   ├── orders.ts        (12.1KB)     # 訂單管理（最複雜）
│   ├── passengers.ts    (8.2KB)      # 乘客管理
│   ├── earnings.ts      (8.8KB)      # 收入統計
│   └── dispatch.ts      (7.1KB)      # 派單 API
│
├── services/                         # 業務邏輯層
│   ├── dispatcher.ts    (1.5KB)      # 派單演算法（簡易版）
│   └── ai-dispatcher.ts (複雜邏輯)    # 智能派單引擎
│
├── db/                               # 數據庫層
│   ├── connection.ts    (1.7KB)      # 連接池管理
│   ├── init.ts         (2.0KB)      # Schema 初始化與種子數據
│   ├── migrate.ts      (0.9KB)      # Migration 執行
│   ├── schema.sql                   # 完整 Schema（198行）
│   └── migrations/
│       └── add-firebase-uid.sql     # Firebase UID 遷移
│
├── socket.ts           (2.6KB)      # Socket.io 事件管理
└── types/
    └── index.ts        (0.6KB)      # TypeScript 類型定義
```

### 3. 通訊流程圖

```
司機側：
  1. Android App → Firebase Phone Auth → 獲得 firebaseUid
  2. App 發送 POST /api/auth/phone-verify-driver
  3. 後端驗證 phone + firebaseUid → 返回 token
  4. App 連接 WebSocket: socket.emit('driver:online')
  5. 後端：DB 更新 availability='AVAILABLE'
  6. 定位每5秒：socket.emit('driver:location', {driverId, lat, lng})
  7. 後端：內存更新 + DB 更新（current_lat, current_lng）
  8. 廣播給所有在線乘客：socket.emit('nearby:drivers')

乘客側：
  1. App 發送 POST /api/auth/phone-verify-passenger
  2. 若無帳戶自動建立
  3. 返回 passengerId
  4. 連接 WebSocket: socket.emit('passenger:online')
  5. 發起叫車：POST /api/passengers/request-ride 或 POST /api/orders
  6. 後端：廣播訂單給所有在線司機（socket.emit('order:offer')）
  7. 司機接單：PATCH /api/orders/:orderId/accept
  8. 派單完成，乘客可實時看到司機位置
```

### 4. 數據流向

```
訂單生命周期：
  PENDING → OFFERED → ACCEPTED → ARRIVED → ON_TRIP → SETTLING → DONE
  或在任何階段 → CANCELLED

位置更新流：
  GPS (Android) 
    → WebSocket 'driver:location' 
    → 內存 Map: driverLocations 
    → DB: drivers.current_lat/lng 
    → 廣播給乘客

派單流程：
  乘客叫車
    → POST /api/orders
    → broadcastOrderToDrivers() (WebSocket)
    → 所有在線司機收到 'order:offer'
    → 或調用 /api/dispatch/smart (SmartDispatcher)
    → 智能選擇最優司機
    → socket.to('driver-X').emit('new-order')

收入計算：
  訂單完成
    → PATCH /api/orders/:orderId/fare (提交meter_amount)
    → UPDATE drivers.total_earnings += meterAmount
    → daily_earnings 表記錄（未自動化）
```

---

## 管理後台評估

### 當前現狀

❌ **沒有Web管理界面**

所有管理操作目前通過以下方式進行：
1. **REST API 直接調用**（curl/Postman）
2. **SQL 直接查詢**（psql 命令行）
3. **第三方應用調用**（Android App）

### 缺失的管理功能

| 功能 | 優先級 | 現狀 |
|------|--------|------|
| **司機管理面板** | 🔴 高 | ❌ 無 |
| - 司機列表、在線狀態 | | |
| - 司機停權/啟用 | | |
| - 司機業績查看 | | |
| **乘客管理面板** | 🔴 高 | ❌ 無 |
| - 乘客黑名單管理 | | |
| - 投訴處理 | | |
| **訂單管理面板** | 🔴 高 | ⚠️ API存在但無UI |
| - 訂單查看/搜尋 | | ✅ API: GET /api/orders |
| - 糾紛申訴處理 | | ❌ 無 |
| **財務管理面板** | 🟡 中 | ⚠️ API存在但無UI |
| - 司機收入統計 | | ✅ API: GET /api/earnings |
| - 每日報表 | | ⚠️ 數據表存在但查詢有限 |
| **派單監控面板** | 🟡 中 | ⚠️ 部分API存在 |
| - 派單成功率 | | ✅ API: GET /api/dispatch/stats |
| - 熱區實時分析 | | ✅ API: GET /api/dispatch/hot-zones |
| **系統監控面板** | 🟡 中 | ⚠️ 部分實現 |
| - 在線司機/乘客數 | | ✅ API: GET /socket/health |
| - 伺服器性能 | | ⚠️ 基礎實現 |
| **用戶帳號管理** | 🟡 中 | ❌ 無 |
| - 角色權限管理 | | |
| - 管理員帳號管理 | | |

---

## 安全性與權限分析

### 現有安全機制

#### 認證層
```typescript
// ✅ Firebase Phone Authentication
- 手機號碼簡訊驗證
- firebaseUid 存儲在數據庫
- 免密碼登入

// ⚠️ 簡易 Token
- 格式: "token_driverId_timestamp"
- 沒有簽名/加密
- 沒有有效期設置
- 容易被偽造

// ❌ 缺少 JWT
- 沒有使用業界標準 JWT
- 無法驗證令牌真實性
```

#### 授權層
```typescript
// ❌ 沒有權限控制
- 所有 API 端點都可以公開訪問
- 沒有驗證用戶身份的中間件
- 司機可以訪問其他司機的數據
- 沒有管理員角色

// ⚠️ 基礎驗證
- 部分 API 檢查傳入參數中的 driverId/passengerId
- 但沒有驗證該用戶是否有權限訪問
```

#### 數據保護
```typescript
// ✅ 數據庫層安全
- 使用連接池（max: 20 連接）
- 參數化查詢（防 SQL Injection）
- 唯一約束（phone, firebase_uid）

// ⚠️ API 安全
- CORS 設置為允許所有來源：cors({ origin: '*' })
- 沒有 Rate Limiting
- 沒有 HTTPS 強制
- 沒有 API 版本控制

// ❌ 敏感數據
- phone 號碼存儲在明文
- 沒有加密存儲
- logs 中可能包含敏感信息
```

### 權限架構建議

```typescript
// 建議角色模型
enum UserRole {
  PASSENGER = 'PASSENGER',      // 乘客
  DRIVER = 'DRIVER',            // 司機
  OPERATOR = 'OPERATOR',        // 運營人員（禁令司機、處理糾紛）
  ADMIN = 'ADMIN',              // 系統管理員
  SUPER_ADMIN = 'SUPER_ADMIN'   // 超級管理員
}

// 建議權限模型
interface Permission {
  resource: string;     // 'orders', 'drivers', 'earnings'
  action: string;       // 'read', 'create', 'update', 'delete'
  conditions?: object;  // 附加條件（如: { ownResource: true }）
}
```

---

## 改進建議

### 優先級 1 - 立即實施（管理後台核心）

#### 1.1 搭建管理後台 Web UI
```
技術建議：
- 前端框架：React.js / Next.js / Vue 3
- UI 組件庫：Ant Design / Material-UI
- 狀態管理：Redux / Zustand / Pinia
- 圖表庫：ECharts / Recharts
- 地圖庫：react-leaflet (與 Android App 一致)

核心頁面：
1. 儀表板 (Dashboard)
   - 實時在線司機/乘客數量
   - 今日訂單統計
   - 派單成功率
   - 系統健康度

2. 司機管理 (Driver Management)
   - 司機列表 (搜尋、篩選、排序)
   - 司機詳情 (訂單歷史、評分、收入)
   - 狀態管理 (停權、啟用、刪除)
   - 位置實時追蹤

3. 乘客管理 (Passenger Management)
   - 乘客列表
   - 投訴記錄
   - 黑名單管理

4. 訂單管理 (Order Management)
   - 訂單列表 (多維度篩選)
   - 訂單詳情
   - 糾紛處理
   - 導出報表

5. 財務管理 (Financial Dashboard)
   - 收入統計 (日/周/月)
   - 司機排行榜
   - 收益分析圖表
   - 結算記錄

6. 派單監控 (Dispatch Monitor)
   - 實時派單追蹤
   - 派單成功率分析
   - 熱區分布地圖
   - 派單日誌查看
```

#### 1.2 升級認證與授權系統
```typescript
// 實施 JWT Token
import jwt from 'jsonwebtoken';

interface TokenPayload {
  userId: string;
  userType: 'DRIVER' | 'PASSENGER' | 'ADMIN';
  role: string;
  permissions: string[];
  iat: number;
  exp: number;
}

// 刷新令牌機制
router.post('/refresh-token', (req, res) => {
  const refreshToken = req.body.refreshToken;
  // 驗證並生成新的 accessToken
});

// 權限中間件
function authorize(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!allowedRoles.includes(decoded.role)) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }
    req.user = decoded;
    next();
  };
}

// API 保護
router.get('/admin/stats', authorize('ADMIN', 'SUPER_ADMIN'), (req, res) => {
  // 只有管理員可以訪問
});
```

#### 1.3 實現基於角色的訪問控制 (RBAC)
```sql
-- 新增表
CREATE TABLE roles (
  role_id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT
);

CREATE TABLE permissions (
  permission_id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  resource VARCHAR(50),
  action VARCHAR(50)
);

CREATE TABLE role_permissions (
  role_id INT REFERENCES roles(role_id),
  permission_id INT REFERENCES permissions(permission_id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE admin_users (
  admin_id SERIAL PRIMARY KEY,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id INT REFERENCES roles(role_id),
  status VARCHAR(20) DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 優先級 2 - 短期實施（功能完善）

#### 2.1 完善派單系統
```typescript
// 當前問題
- 廣播派單不智能，導致拒單率高
- 沒有考慮司機當前收入差距
- 沒有熱區配額機制

// 改進方向
1. 熱區配額管理
   - 定義熱區、配額數量、獲得條件
   - 司機在熱區內接單時扣減配額
   - 配額用盡後無法在熱區接單

2. 收入平衡派單
   - 優先推給收入低於平均水平的司機
   - 高收入司機 → 推送長距離高端單

3. ETA 精確預測
   - 集成 Google Maps API
   - 考慮當前交通狀況
   - 準確度 > 90%

4. 拒單分析
   - 追蹤每位司機的拒單率
   - 拒單原因分類
   - 持續高拒單率的司機降低優先級
```

#### 2.2 實現數據分析模塊
```typescript
// 新增分析維度
1. 派單效率分析
   - 派單成功率、平均拒單次數、平均接受時間

2. 司機行為分析
   - 工作時段分布、活躍區域、訂單類型偏好

3. 訂單模式分析
   - 熱區出行時段、平均距離、平均車資

4. 收入分析
   - 司機收入分布、時間段收入對比
   - 長尾司機識別（收入過低的司機）

// 新增 API
GET /api/analytics/dispatch-efficiency
GET /api/analytics/driver-behavior/:driverId
GET /api/analytics/order-patterns
GET /api/analytics/earnings-distribution
```

#### 2.3 改進訂單糾紛處理
```typescript
// 新增表
CREATE TABLE disputes (
  dispute_id SERIAL PRIMARY KEY,
  order_id VARCHAR(50) REFERENCES orders(order_id),
  initiator_id VARCHAR(50),  -- 司機 or 乘客 ID
  initiator_type ENUM('DRIVER', 'PASSENGER'),
  category VARCHAR(50),  -- 'FARE_DISPUTE', 'SAFETY_ISSUE', 'LOST_ITEM', etc.
  description TEXT,
  evidence_urls TEXT[],  -- 圖片證據 URL
  status VARCHAR(20) DEFAULT 'PENDING',  -- PENDING, INVESTIGATING, RESOLVED, REJECTED
  resolution TEXT,
  resolved_by VARCHAR(50),  -- 管理員 ID
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP
);

// 新增 API
POST   /api/disputes              -- 提交糾紛
GET    /api/disputes/:disputeId   -- 查看糾紛詳情
PATCH  /api/disputes/:disputeId   -- 管理員處理
```

### 優先級 3 - 中期實施（功能拓展）

#### 3.1 實現 Redis 緩存層
```typescript
// 優化數據庫查詢
import Redis from 'ioredis';

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT
});

// 緩存司機位置（實時性要求高）
// 緩存熱區配額（更新頻率低）
// 緩存收入排行榜（查詢頻度高但更新頻率低）

// 示例
async function getNearbyDrivers(lat: number, lng: number) {
  // 先查 Redis
  const cacheKey = `nearby_drivers:${Math.floor(lat*100)}_${Math.floor(lng*100)}`;
  let drivers = await redis.get(cacheKey);
  
  if (!drivers) {
    // 查數據庫
    drivers = await queryMany(`SELECT * FROM drivers WHERE ...`);
    // 存入 Redis，30 秒過期
    await redis.setex(cacheKey, 30, JSON.stringify(drivers));
  }
  
  return JSON.parse(drivers);
}
```

#### 3.2 心跳監控與健康度系統
```typescript
// 訂閱 driver:location 事件
// 如果 5 分鐘內沒有收到更新 → 標記為 OFFLINE
// 如果 24 小時內都沒有上線 → 可能是閒置司機

// 新增表
CREATE TABLE driver_health (
  driver_id VARCHAR(50) REFERENCES drivers(driver_id),
  last_heartbeat_at TIMESTAMP,
  is_online BOOLEAN DEFAULT FALSE,
  offline_hours INTEGER DEFAULT 0,
  status VARCHAR(20),  -- ACTIVE, IDLE, INACTIVE
  updated_at TIMESTAMP
);

// 新增 API
GET /api/drivers/health-status  -- 查看所有司機健康度
GET /api/drivers/:driverId/health-history  -- 查看司機健康度歷史
```

#### 3.3 訂單 OCR + 語音助理（Phase 2）
```typescript
// 跳表 OCR 識別
import Tesseract from 'tesseract.js';

async function recognizeMeterPhoto(imageUrl: string) {
  const result = await Tesseract.recognize(imageUrl, 'chi_tra');
  const meterAmount = extractMeterAmount(result.data.text);
  return { meterAmount, confidence: result.data.confidence };
}

// 語音轉文字（Whisper API）
async function transcribeVoiceOrder(audioUrl: string) {
  const formData = new FormData();
  formData.append('file', await fetch(audioUrl).then(r => r.blob()));
  formData.append('model', 'whisper-1');
  
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: formData
  });
  
  return response.json();
}
```

### 優先級 4 - 長期實施（系統優化）

#### 4.1 性能優化
```
1. 數據庫優化
   - 實施分表策略（按日期/司機分區）
   - 添加更多索引（查詢性能）
   - 檔案化舊數據（保留 6 個月或 1 年）

2. API 優化
   - 實施分頁（防止一次性返回超大數據集）
   - GraphQL 查詢（替代 REST，減少數據傳輸）
   - API 端點速率限制

3. WebSocket 優化
   - 實施房間管理（區域性廣播，減少消息量）
   - 消息壓縮（特別是位置數據）
   - 心跳檢測（檢測「幽靈連接」）
```

#### 4.2 日誌與監控
```typescript
// 統一日誌系統
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// 應用性能監控 (APM)
// 集成 Datadog / New Relic
// 監控指標：
// - API 響應時間
// - 數據庫查詢時間
// - WebSocket 消息延遲
// - 內存/CPU 使用率
```

#### 4.3 容量規劃與擴展
```
當前架構限制：
- PostgreSQL 單機（最多支持 ~1000 TPS）
- Redis 單機（限制實時數據大小）
- WebSocket 單伺服器（限制併發連接）

擴展方案：
1. 數據庫
   - 主從複製（讀寫分離）
   - 分片（按地區分片）
   - Redis 集群

2. 應用服務器
   - 負載均衡（Nginx / HAProxy）
   - 多伺服器部署（3 ~ 5 台）
   - 消息隊列（RabbitMQ / Redis）

3. 實時通訊
   - Redis Pub/Sub（跨伺服器消息轉發）
   - Socket.io Adapter（使用 Redis）
```

---

## 建議實施路線圖

### 第 1 阶段（1-2 個月）
```
✓ 實施管理後台 Web UI
✓ 升級認證系統（JWT）
✓ 實現 RBAC 權限管理
✓ 強化 API 安全（Rate Limiting, CORS）
```

### 第 2 阶段（2-3 個月）
```
✓ 完善派單演算法（熱區配額、收入平衡）
✓ 實現數據分析模塊
✓ 訂單糾紛處理系統
✓ Redis 緩存層整合
```

### 第 3 阶段（3-6 個月）
```
✓ 心跳監控與健康度系統
✓ OCR + 語音助理（Phase 2）
✓ 性能優化與容量規劃
✓ 日誌與監控系統
```

---

## 代碼品質評估

### 優點 ✅
1. **架構清晰**：分層設計（API → Service → DB）
2. **類型安全**：使用 TypeScript
3. **代碼組織**：按功能模塊分組
4. **數據庫設計**：合理的 Schema 和索引
5. **文檔齊全**：README、部署指南
6. **參數化查詢**：防止 SQL 注入

### 不足 ⚠️
1. **缺少單元測試**：沒有測試文件（test 目錄只有 1 個測試文件）
2. **錯誤處理不一致**：部分地方使用 try-catch，部分沒有
3. **日誌不統一**：使用 console.log，沒有結構化日誌
4. **硬編碼配置**：某些值寫死在代碼中（如熱區座標）
5. **缺乏中間件**：沒有統一的驗證、錯誤處理中間件

### 改進建議
```typescript
// 1. 添加統一的錯誤處理中間件
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error(err);
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'production' ? 'Server error' : err.message
  });
});

// 2. 添加請求驗證中間件
import { body, validationResult } from 'express-validator';

router.post('/orders', [
  body('pickupLat').isFloat({ min: -90, max: 90 }),
  body('pickupLng').isFloat({ min: -180, max: 180 }),
  // ...
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  // 業務邏輯
});

// 3. 使用結構化日誌
import winston from 'winston';
logger.info('Order created', { orderId, passengerId, status: 'success' });
```

---

## 成本分析

### 當前成本
```
| 項目 | 用量 | 成本 |
|------|------|------|
| VPS (Hetzner) | 2核 4GB RAM | €4.15/月 |
| 域名 | 1 個 | ~$12/年 |
| SSL 證書 | Let's Encrypt | 免費 |
| Google Maps API | 500次/天 | ~$75/月 |
| 合計 | - | ~$80/月 |
```

### 優化建議
```
1. 減少 Google Maps API 呼叫
   - 實施快取策略（30秒）
   - 先用 Haversine 公式篩選
   - 減少 50% API 呼叫 → ~$37/月

2. 自託管地圖
   - OpenStreetMap (免費)
   - 減少 Google Maps 依賴

3. 監控成本
   - 建立成本告警
   - 每月成本報表
```

---

## 總結

### 現狀評分
```
功能完整性：   ⭐⭐⭐⭐☆ (80%)
代碼質量：     ⭐⭐⭐☆☆ (60%)
安全性：       ⭐⭐☆☆☆ (40%)
可維護性：     ⭐⭐⭐☆☆ (65%)
文檔完整性：   ⭐⭐⭐⭐☆ (80%)
```

### 關鍵建議
1. **立即開發管理後台** - 運營必需
2. **強化安全體系** - 生產環境必須
3. **實施權限控制** - 風險管理
4. **優化派單算法** - 提升用戶體驗
5. **建立監控系統** - 系統穩定性

此系統目前適合**MVP / Beta 測試階段**，生產部署前需完成上述改進。

---

**報告生成日期**：2025-11-11
**分析者**：Claude Code
**系統版本**：v1.0.0-MVP

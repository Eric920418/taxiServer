# 花蓮計程車司機端 - 後端伺服器

> **HualienTaxiServer** - 桌面自建後端系統
> 版本：v1.0.0-MVP
> 更新日期：2025-11-11

## 📝 最新修改（2025-11-11）
- ✅ 實作乘客叫車推送給司機端（broadcastOrderToDrivers）
- ✅ 修復接單 API 返回完整訂單資料（含時間戳轉換）
- ✅ 修復 updateOrderStatus API 返回完整訂單資料
- ✅ 修復 submitFare API 返回完整訂單資料
- ✅ 新增 POST /api/orders/:orderId/fare 路由支援（Android 客戶端使用）

---

## 📋 專案概述

這是一個**成本控制導向**的計程車派單系統後端，採用桌面自建架構（非Firebase），API成本控制在**每月 < $100 USD**。

### 核心特色
- ✅ **桌面部署**：跑在本地或VPS，資料完全自主掌控
- ✅ **即時通訊**：Socket.io實現派單與定位廣播
- ✅ **成本最小化**：避免Firebase高昂費用
- ✅ **跳表為準**：不處理金流，僅記錄車資

---

## 🏗️ 技術架構

### 技術棧
```
後端框架：Node.js v20+ + TypeScript
HTTP Server：Express.js v5
即時通訊：Socket.io v4
資料庫：PostgreSQL (MVP階段可用SQLite)
快取層：Redis (心跳/健康度/配額)
地圖API：Google Maps (Directions/Distance Matrix)
語音轉文字：OpenAI Whisper API (Phase 2)
```

### 系統架構圖
```
┌─────────────────┐
│  Android App    │ (司機端)
│  (Kotlin)       │
└────────┬────────┘
         │ HTTPS + WebSocket
         ▼
┌─────────────────────────────┐
│   HualienTaxiServer         │
│   (Express + Socket.io)     │
├─────────────────────────────┤
│  REST API  │  WebSocket     │
│  (/api/*)  │  (即時派單)    │
└──────┬──────────────┬───────┘
       │              │
       ▼              ▼
┌─────────────┐  ┌──────────┐
│ PostgreSQL  │  │  Redis   │
│ (訂單/司機) │  │ (心跳)   │
└─────────────┘  └──────────┘
       │
       ▼
┌────────────────────────────┐
│  外部API (後端代理)         │
│  - Google Maps Directions  │
│  - Distance Matrix         │
│  - OpenAI Whisper          │
└────────────────────────────┘
```

---

## 📁 目錄結構

```
HualienTaxiServer/
├── src/
│   ├── index.ts              # 主程式入口
│   ├── api/                  # REST API路由
│   │   ├── orders.ts         # 訂單CRUD
│   │   ├── drivers.ts        # 司機狀態管理
│   │   └── earnings.ts       # 收入統計
│   ├── socket/               # WebSocket處理
│   │   ├── dispatch.ts       # 派單邏輯
│   │   └── location.ts       # 定位廣播
│   ├── db/                   # 資料庫層
│   │   ├── models.ts         # 資料模型
│   │   ├── migrations/       # Schema遷移
│   │   └── connection.ts     # DB連線池
│   ├── services/             # 業務邏輯
│   │   ├── dispatcher.ts     # 派單演算法
│   │   ├── maps.ts           # Google Maps代理
│   │   └── stt.ts            # Whisper STT代理
│   └── utils/                # 工具函數
│       ├── geo.ts            # 地理計算
│       └── logger.ts         # 日誌
├── config/
│   └── tariff.json           # 費率設定
├── .env                      # 環境變數 (不進git)
├── .env.example              # 環境變數範例
├── tsconfig.json             # TypeScript設定
├── package.json
└── README.md
```

---

## 🔑 測試帳號

### 生產環境 API 地址
```
http://54.180.244.231
```

### 司機帳號（測試用）

**註：已改用 Firebase Phone Authentication，不再使用密碼登入**

| 司機ID | 手機號碼 | 姓名 | 車牌 |
|--------|----------|------|------|
| D001 | 0912345678 | 王大明 | ABC-1234 |
| D002 | 0987654321 | 李小華 | XYZ-5678 |
| D003 | 0965432100 | 陳建國 | DEF-9012 |

### 乘客帳號（測試用）

| 乘客ID | 手機號碼 | 姓名 |
|--------|----------|------|
| PASS001 | 0911111111 | 測試乘客A |
| PASS002 | 0922222222 | 測試乘客B |

### 測試登入範例

**司機登入（Firebase Phone Auth）**：
```bash
# 第一步：前端使用 Firebase Phone Auth 驗證手機號碼，獲得 firebaseUid
# 第二步：將 phone 和 firebaseUid 發送到後端
curl -X POST http://54.180.244.231/api/auth/phone-verify-driver \
  -H "Content-Type: application/json" \
  -d '{"phone":"0912345678","firebaseUid":"firebase_uid_from_client"}'
```

成功回應：
```json
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

**乘客登入（Firebase Phone Auth）**：
```bash
curl -X POST http://54.180.244.231/api/auth/phone-verify-passenger \
  -H "Content-Type: application/json" \
  -d '{"phone":"0911111111","firebaseUid":"firebase_uid_from_client","name":"測試乘客A"}'
```

---

## 🚀 快速開始

### 1. 安裝依賴
```bash
cd ~/Desktop/HualienTaxiServer
pnpm install
```

### 2. 環境設定
複製環境變數範例：
```bash
cp .env.example .env
```

編輯 `.env`：
```env
PORT=3000
NODE_ENV=development

# 資料庫
DB_HOST=localhost
DB_PORT=5432
DB_NAME=hualien_taxi
DB_USER=postgres
DB_PASSWORD=your_password

# API Keys (選填，MVP不需要)
GOOGLE_MAPS_API_KEY=
OPENAI_API_KEY=
```

### 3. 設定 PostgreSQL 資料庫

#### 安裝 PostgreSQL
```bash
# macOS
brew install postgresql@15
brew services start postgresql@15

# Ubuntu/Debian
sudo apt update
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
```

#### 初始化資料庫
```bash
# 方法 1: 使用自動化腳本（推薦）
cd scripts
chmod +x db-setup.sh
./db-setup.sh

# 方法 2: 手動執行
createdb hualien_taxi
psql -d hualien_taxi -f src/db/schema.sql
pnpm exec ts-node src/db/init.ts
```

### 4. 啟動開發伺服器
```bash
pnpm dev
```

應該會看到：
```
╔════════════════════════════════════════════╗
║   花蓮計程車司機端 Server 已啟動            ║
║   HTTP: http://localhost:3000              ║
║   WebSocket: ws://localhost:3000           ║
║   環境: development                        ║
╚════════════════════════════════════════════╝
[DB] PostgreSQL 連接成功
```

### 5. 測試API
```bash
curl http://localhost:3000/health
# 回應: {"status":"healthy"}
```

---

## 🔌 API文件

### REST API

#### 健康檢查
```http
GET /health
回應: {"status": "healthy"}
```

#### 訂單管理 (Phase 1)
```http
GET    /api/orders              # 取得訂單列表
POST   /api/orders              # 建立訂單
GET    /api/orders/:id          # 取得單一訂單
PATCH  /api/orders/:id/status   # 更新訂單狀態
```

#### 認證（Firebase Phone Auth）
```http
POST   /api/auth/phone-verify-driver     # 司機手機驗證登入
POST   /api/auth/phone-verify-passenger  # 乘客手機驗證登入/註冊
```

#### 司機管理
```http
GET    /api/drivers/:id         # 取得司機資訊
PATCH  /api/drivers/:id/status  # 更新上線狀態
PATCH  /api/drivers/:id/location # 更新司機位置
GET    /api/drivers/:id/earnings # 取得收入統計
```

### WebSocket事件

#### 客戶端 → 伺服器
```javascript
// 司機上線
socket.emit('driver:online', {
  driverId: 'D001',
  location: { lat: 23.98, lng: 121.60 }
});

// 定位更新 (每5秒)
socket.emit('driver:location', {
  driverId: 'D001',
  lat: 23.98,
  lng: 121.60,
  speed: 0,
  bearing: 90
});

// 接單
socket.emit('order:accept', { orderId: 'ORD123' });
```

#### 伺服器 → 客戶端
```javascript
// 派單通知
socket.on('order:offer', (data) => {
  // { orderId, pickup, destination, eta }
});

// 訂單狀態更新
socket.on('order:status', (data) => {
  // { orderId, status: 'ACCEPTED' | 'CANCELLED' }
});
```

---

## 🗄️ 資料庫架構

### 資料表清單

1. **drivers** - 司機帳號與統計
2. **passengers** - 乘客資料
3. **orders** - 訂單完整記錄（AI訓練核心）
4. **driver_locations** - 司機位置歷史（熱區分析）
5. **daily_earnings** - 每日收入統計

### 核心資料表結構

#### orders (訂單表 - AI 訓練關鍵)
```sql
- order_id (PK)
- passenger_id (FK)
- driver_id (FK)
- status (WAITING | OFFERED | ACCEPTED | ARRIVED | ON_TRIP | SETTLING | DONE | CANCELLED)

-- 地點資訊
- pickup_lat, pickup_lng, pickup_address
- dest_lat, dest_lng, dest_address

-- 車資資訊
- meter_amount (跳表金額 - 最權威)
- actual_distance_km, actual_duration_min
- photo_url (跳表照片)

-- 時間追蹤（AI 關鍵特徵）
- created_at, offered_at, accepted_at
- arrived_at, started_at, completed_at

-- AI 特徵
- hour_of_day (0-23)
- day_of_week (0-6)
- is_holiday, weather
```

#### drivers (司機表)
```sql
- driver_id (PK)
- phone, firebase_uid, name, plate
- availability (OFFLINE | REST | AVAILABLE | ON_TRIP)
- current_lat, current_lng
- total_trips, total_earnings
- rating, acceptance_rate, cancel_rate
```

詳細 Schema 請查看：`src/db/schema.sql`

---

## 🎯 MVP範圍 (Phase 1，3個月目標)

### ✅ 包含功能
- [x] **PostgreSQL 資料庫**：完整 Schema + 連接池
- [x] **REST API**：訂單CRUD、司機狀態、乘客管理
- [x] **WebSocket**：即時派單、定位廣播
- [x] **訂單流程**：完整狀態機（WAITING → DONE）
- [x] **司機管理**：登入、狀態切換、位置追蹤
- [x] **乘客管理**：自動註冊、附近司機查詢
- [x] **車資結算**：手動輸入跳表金額
- [ ] 基礎派單演算法（目前廣播給所有在線司機）
- [ ] 收入統計 API
- [ ] 車資拍照功能

### ❌ 不包含 (Phase 2+)
- AI自動接單
- 熱區配額管理
- 心跳健康度監控
- OCR跳表辨識
- 語音助理 (Whisper STT)
- 聊天式UI
- BLE/USB跳表整合

---

## 🔐 安全性

### MVP階段
- Firebase Phone Authentication（手機號碼簡訊驗證）
- CORS設定（僅允許App來源）
- 環境變數保護API Key

### 生產環境 (TODO)
- HTTPS (Let's Encrypt)
- Rate Limiting (防DDoS)
- SQL Injection防護 (Parameterized Query)
- 定位防偽造檢測

---

## 🌐 部署選項

### 選項1：桌面電腦 (開發/測試)
```bash
# 使用Cloudflare Tunnel (免費)
pnpm global add cloudflared
cloudflared tunnel --url http://localhost:3000
# 會得到公開URL: https://xxx.trycloudflare.com
```

### 選項2：VPS (生產)
推薦平台：
- **Hetzner**：€4.15/月 (2核4GB，德國)
- **Vultr**：$6/月 (1核1GB，東京)
- **Oracle Cloud**：免費 (4核24GB，限額)

部署步驟：
```bash
# SSH到VPS
ssh user@your-vps-ip

# 安裝Node.js
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 20

# 安裝pnpm
npm install -g pnpm

# Clone專案
git clone <your-repo>
cd HualienTaxiServer

# 安裝依賴
pnpm install

# 設定環境變數
nano .env

# 使用PM2管理程序
pnpm add -g pm2
pm2 start dist/index.js --name taxi-server
pm2 startup  # 開機自啟
```

---

## 📊 成本估算 (每月)

| 項目 | 用量 | 單價 | 成本 (USD) |
|------|------|------|-----------|
| **VPS** | Hetzner CX21 | €4.15/月 | ~$4.5 |
| **Google Directions** | 500次/天 (後端代理+快取) | $0.005/req | ~$75 |
| **OpenAI Whisper** | Phase 2才需要 | $0.006/min | $0 |
| **總計** | - | - | **< $80** |

💡 **省錢技巧**：
- 快取Directions結果30秒
- 優先用直線距離預篩司機，再呼叫Matrix API
- 自己實作簡易路徑估算（Haversine + 路網係數1.3）

---

## 🔧 最近更新

### 2025-11-11 - 修復實時位置系統

#### **問題 1：乘客端無法看到司機位置**
**根本原因**：
1. ❌ **司機端 App 沒有建立 WebSocket 連接** - 登入後從未調用 `connectWebSocket()`
2. ❌ 司機位置只存內存，沒有寫入數據庫
3. ❌ 司機上線/離線狀態沒有同步到數據庫

**修復內容**：
- ✅ **Android App（司機端）**：
  - `HomeScreen.kt:76-84` - 添加 `connectWebSocket()` 調用
  - `SeniorFriendlyHomeScreen.kt:91-99` - 添加 `connectWebSocket()` 調用
  - `SimplifiedDriverScreen.kt:99-107` - 添加 `connectWebSocket()` 調用
  - `WS_URL` 修正為 `http://54.180.244.231`（透過 Nginx 反向代理）

- ✅ **服務器端**：
  - `driver:online` → 更新數據庫狀態為 `AVAILABLE`（`index.ts:73-86`）
  - `driver:location` → 寫入 `current_lat`、`current_lng`、`last_heartbeat`（`index.ts:93-108`）
  - `disconnect` → 更新數據庫狀態為 `OFFLINE`（`index.ts:160-173`）
  - 實時廣播司機位置給所有在線乘客（`index.ts:108`）

#### **問題 2：司機標記不清楚（像 Uber）**
**根本原因**：
1. ❌ 使用默認藍色標記，不夠明顯
2. ❌ 實時位置沒有更新到地圖標記

**修復內容**：
- ✅ **Android App（乘客端）**：
  - 創建自定義計程車圖標 `ic_taxi.xml`（黃色車身 + 橘色車頂標誌）
  - `PassengerViewModel.kt:159-193` - 實現實時位置更新邏輯
  - `PassengerHomeScreen.kt` - 使用自定義圖標替換默認標記
  - 添加 `vectorToBitmap()` 輔助函數

**部署注意事項**：
- ✅ 服務器已通過 Nginx 反向代理，WebSocket 正常工作
- 🔄 Android App 需要重新編譯並安裝

---

## 🐛 常見問題

### Q: Port 3000被佔用？
```bash
lsof -i :3000
kill -9 <PID>
# 或修改 .env 的 PORT
```

### Q: 如何切換資料庫？
```bash
# 開發：SQLite (無需安裝)
pnpm add better-sqlite3

# 生產：PostgreSQL
brew install postgresql  # macOS
sudo apt install postgresql  # Ubuntu
```

### Q: 如何查看logs？
```bash
# 開發模式：即時顯示在終端
pnpm dev

# 生產模式：PM2管理
pm2 logs taxi-server
```

### Q: TypeScript編譯錯誤（找不到模組導出）？
如果遇到類似 `Module declares 'xxx' locally, but it is not exported` 的錯誤：
```bash
# 清理TypeScript緩存
rm -rf node_modules/.cache dist .tsbuildinfo
pnpm dev
```

---

## 📝 開發規範

### Git Commit格式
```
feat: 新增訂單API
fix: 修正派單距離計算錯誤
docs: 更新README部署說明
refactor: 重構WebSocket連接邏輯
```

### 分支策略
```
main        # 穩定版本
develop     # 開發主線
feature/*   # 新功能分支
```

---

## 🗺️ Roadmap

### Phase 1 (Month 1-3) - MVP ⬅️ 當前
- [x] Server基礎架構
- [x] 訂單CRUD API
- [x] WebSocket派單（即時推播）
- [x] 簡易派單演算法（廣播給所有在線司機）
- [x] Android App整合（完整訂單流程）

### Phase 2 (Month 4-6)
- [ ] Whisper語音助理
- [ ] OCR跳表辨識
- [ ] 改進派單演算法 (ETA + 拒單率)

### Phase 3 (Month 7-9)
- [ ] AI自動接單
- [ ] 熱區配額
- [ ] 聊天式UI

### Phase 4 (Month 10-12)
- [ ] 乘客端App (React Native)
- [ ] 生產環境部署
- [ ] 壓力測試與優化

---

## 📞 聯絡資訊

- 專案負責人：Eric
- 開發環境：macOS + Android Studio
- 部署位置：桌面 (`~/Desktop/HualienTaxiServer`)

---

**永遠只有一份文檔** - 如有更新請直接編輯本README

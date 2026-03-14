# 花蓮計程車司機端 - 後端伺服器

> **HualienTaxiServer** - 桌面自建後端系統
> 版本：v1.5.3-MVP
> 更新日期：2026-03-14

## 📝 最新修改（2026-03-14）- 修復司機端目的地顯示為「花蓮縣花蓮市」

### 問題
電話訂單的目的地在司機端永遠顯示「花蓮縣花蓮市」。根因是 Geocoding 後的 `formattedAddress` 被 Google 回傳為模糊行政區名，而非客人口述的具體地名。

### 修復
- `PhoneCallProcessor.ts`：目的地文字優先使用 GPT 提取的原始地址，座標仍用 Geocoding 結果
- `orders.ts`：API 回應加入 `getDestAddress()` helper，電話訂單優先用 `dropoff_original`，補救 DB 中已存的模糊地址

---

## 📝 歷史修改（2026-03-14）- Voice Barge-in 語音打斷功能

### 背景
原本 `Playback()` 是阻塞式播放，播完整段 greeting (~4 秒) 才進下一步。客人一聽到「大豐你好」就開始報地址，但系統繼續播語音蓋過客人聲音，導致錄音中系統語音和客人語音重疊，Whisper STT 轉錄品質下降。

### 解決方案
實作語音打斷（barge-in）— 客人在 greeting 播放期間開口，系統立即停止播放，開始聽客人說話。使用 Asterisk `BackgroundDetect()` 取代 `Playback()`。

### 語音流程（新）
```
來電 → 接聽 → 錄音開始 → BackgroundDetect 播歡迎語
  ├─ 路徑 A（客戶插話）→ 系統停止播放 → 跳 talk extension → 等說完 → 掛斷 → webhook
  └─ 路徑 B（客戶沒插話）→ WaitForNoise 等開口 → WaitForSilence 等說完 → 掛斷 → webhook
```

### 修改檔案
| 檔案 | 變更 |
|------|------|
| `config/asterisk/extensions_taxi.conf` | `Playback` → `BackgroundDetect`，新增 `talk` extension，移除 beep |
| `scripts/generate-greeting.js` | 歡迎語縮短為「大豐您好，請說在哪裡搭車。」(~2 秒) |
| `src/services/PhoneCallProcessor.ts` | Whisper prompt 更新，告知問候語可能被打斷不完整 |

### BackgroundDetect 參數
```
BackgroundDetect(custom/taxi-greeting, 1000, 200, 10000)
  sil=1000  → 語音後靜音 1 秒判定結束
  min=200   → 最低 200ms 語音才觸發（過濾噪音）
  max=10000 → 安全上限
```

### 關鍵設計決策
1. **移除 `Playback(beep)`** — 像真人接電話，不需嗶聲
2. **路徑 B 加 `WaitForNoise(300,1,15)`** — 避免 greeting 播完後立刻偵測到靜音就結束通話
3. **`WaitForSilence` iterations 從 2 改 1** — 路徑 A 客人已在說話，路徑 B 有 WaitForNoise 確保開口
4. **`talk` extension 共用** — `_X.` 和 `s` 都跳同一個 talk，channel variables 持續有效

### 部署步驟
```bash
# VPS: git pull
# VPS: node scripts/generate-greeting.js        # 重新生成縮短版歡迎語
# VPS: sudo cp config/asterisk/extensions_taxi.conf /etc/asterisk/
# VPS: sudo asterisk -rx 'dialplan reload'
# VPS: source ~/.nvm/nvm.sh && cd /var/www/taxiServer && npm run build && pm2 restart taxiserver
```

### 驗證步驟
1. **Barge-in 測試**：撥入 → 聽到「大豐您好」立刻說地址 → 確認系統語音停止 → Asterisk CLI 顯示 `Barge-in!`
2. **正常流程測試**：撥入 → 聽完 greeting → 再說地址 → 確認正常錄到
3. **靜音測試**：撥入 → 不說話 → 15 秒後自動掛斷 → webhook 仍觸發
4. **端到端**：`pm2 logs` 確認 transcript 正確、GPT 解析地址成功、訂單建立

---

## 📝 歷史修改（2026-03-11）- 花蓮地址資料庫 + 台語別名支援

### 背景
Whisper STT 在台語腔調下會把「慈濟」聽成「祠際」，舊系統 16 筆靜態地標完全無法命中，直接
fallback 到 Google API，精度不穩定且浪費配額。

### 新增功能
- **`HualienAddressDB.ts`** - 88 筆人工驗證花蓮地標資料庫
  - 分類：交通(11)、醫療(11)、學校(11)、商業(9)、政府(10)、景點(13)、飯店(10)、鄉鎮(13)
  - 支援台語腔調別名（祠際→慈濟、文諾→門諾、飛機場→花蓮航空站等）
  - 啟動時預建索引，O(1) 查詢
  - 涵蓋花蓮縣全部 13 鄉鎮市（含新城鄉）

### 修改檔案
| 檔案 | 變更 |
|------|------|
| `src/services/HualienAddressDB.ts` | **新建**：88 筆地標 + lookup/resolveAliases/getCoords |
| `src/services/PhoneCallProcessor.ts` | 移除 LANDMARK_COORDS、整合 DB 四層 Geocoding、加 Redis 快取 |
| `src/services/CallFieldExtractor.ts` | 移除 HUALIEN_LANDMARKS、委派 resolveAliases、補地標上下文 prompt |

### Geocoding 四層流程（新）
```
① HualienAddressDB.lookup()     → 88 筆本地比對（含台語別名），命中快取 24h
② Google Geocoding API          → 街道地址精確定位，結果快取 1h
③ Google Places Text Search     → 景點/地標模糊搜尋
④ 花蓮市中心預設座標            → 失敗保底
```

### 台語別名對照
| 標準名 | 台語別名 |
|--------|---------|
| 花蓮慈濟醫院 | 祠際、磁際、資際、茲際 |
| 門諾醫院 | 文諾醫院 |
| 花蓮火車站 | 火車頭、車頭 |
| 東大門夜市 | 暗市仔 |
| 花蓮市場 | 菜市仔 |
| 花蓮航空站 | 飛機場 |

### 驗證方式
1. `pm2 logs taxiserver` → 看到 `[HualienAddressDB] 命中: 慈濟 → 花蓮慈濟醫院` 表示 DB 生效
2. 看到 `[PhoneCallProcessor] Geocoding 快取命中` 表示 Redis 快取生效
3. 打電話說「去祠際醫院」→ 確認訂單上車地點是慈濟醫院正確座標

---

## 📝 歷史修改（2026-02-27）- Asterisk 語音歡迎引導升級

### 背景
來電叫車從「嗶一聲 → 等 60 秒」升級為自然語音引導流程，客戶不再困惑。

### 語音流程
```
來電 → 接聽 → 「大豐，你好！請問哪裡搭車？嗶聲之後，請說出上車地點跟目的地，說完直接掛斷就可以囉！」
→ 嗶聲 → 錄音（靜音 3 秒自動結束，最長 30 秒） → 掛斷 → webhook → Whisper STT → 建立訂單
```

### 新增/修改檔案
```
scripts/generate-greeting.js                  # 一次性 TTS 腳本（OpenAI tts-1 + nova）
config/asterisk/extensions_taxi.conf          # Asterisk Dialplan 配置
/var/lib/asterisk/sounds/custom/taxi-greeting.wav  # TTS 產生的歡迎語音（EC2 上）
```

### 關鍵設計
- **MixMonitor 在 greeting 之後才啟動** → 錄音不含歡迎語，Whisper STT 更乾淨
- **WaitForSilence(3000,2,30)** → iterations=2：第一段靜音（等客戶開口前）+ 第二段靜音（說完後沉默 3 秒）= 自動結束
- **StopMixMonitor** → 確保錄音檔正確關閉
- 客戶主動掛斷也觸發 `h` extension → webhook 正常運作
- 語速 0.95（稍慢），讓長輩聽清楚

### 部署步驟（EC2 上執行）
```bash
# 1. 安裝 sox（如果還沒裝）
sudo apt-get install sox libsox-fmt-mp3

# 2. 生成 TTS 語音檔
cd /var/www/taxiServer
node scripts/generate-greeting.js

# 3. 更新 Asterisk Dialplan
sudo cp config/asterisk/extensions_taxi.conf /etc/asterisk/extensions_taxi.conf
sudo asterisk -rx 'dialplan reload'

# 4. 驗證
sudo asterisk -rx 'dialplan show from-phone'
```

### 驗證步驟
1. 用 Zoiper 撥打測試 → 聽到「大豐，你好！…」→ 嗶聲
2. 說「我在火車站，要去東大門」→ 停頓 3 秒 → 自動掛斷
3. 確認 webhook 觸發 → `phone_calls` 表有新記錄 → STT 轉錄正確（不含歡迎語）
4. 確認訂單建立成功

---

## 📝 歷史修改（2025-12-31）- AI 自動接單 + 熱區配額系統

### 新增功能

#### 1. AI 自動接單系統
- ✅ **AutoAcceptService** - 基於 RejectionPredictor 擴展的自動接單服務
- ✅ **五維度評分計算** - 拒單預測(40%) / 距離(20%) / 車資(15%) / 時間(15%) / 司機偏好(10%)
- ✅ **風控機制**：
  - 每日自動接單上限（預設 30 單）
  - 連續自動接單冷卻時間（預設 5 分鐘）
  - 連續自動接單上限（預設 5 單）
  - 完成率檢查（低於 60% 自動停用）
- ✅ **司機個人化設定**：
  - 最大接送距離 / 最低車資 / 最短行程
  - 啟用時段 / 黑名單區域

#### 2. 熱區配額管理系統
- ✅ **HotZoneQuotaService** - 熱區流量控管服務
- ✅ **混合模式**：
  - 配額使用 80% → 啟動動態加價（最高 1.5x）
  - 配額使用 100% → 進入排隊系統
- ✅ **即時配額追蹤** - 每小時配額自動重置
- ✅ **排隊管理** - FIFO 排隊、預估等待時間
- ✅ **預設熱區**：東大門夜市、花蓮火車站、遠百花蓮店、太魯閣國家公園

### 新增檔案
```
src/services/AutoAcceptService.ts      # AI 自動接單服務
src/services/HotZoneQuotaService.ts    # 熱區配額管理
src/db/migrations/002-auto-accept-tables.sql    # 自動接單資料表
src/db/migrations/003-hot-zone-quota-tables.sql # 熱區配額資料表
```

### API 變更

#### 司機端 API（drivers.ts）
```
GET  /api/drivers/:driverId/auto-accept-settings   # 取得自動接單設定
PUT  /api/drivers/:driverId/auto-accept-settings   # 更新自動接單設定
GET  /api/drivers/:driverId/auto-accept-stats      # 取得自動接單統計
```

#### 管理端 API（admin.ts）
```
GET  /api/admin/hot-zones                 # 列出所有熱區
GET  /api/admin/hot-zones/status          # 取得所有熱區配額狀態
GET  /api/admin/hot-zones/:zoneId/quota   # 取得單一熱區配額
GET  /api/admin/hot-zones/:zoneId/stats   # 取得熱區統計
POST /api/admin/hot-zones                 # 新增熱區
PUT  /api/admin/hot-zones/:zoneId         # 更新熱區
GET  /api/admin/hot-zones/stats/overview  # 總覽統計
```

### WebSocket 事件變更

`order:offer` 事件新增欄位：
```typescript
{
  // ... 原有欄位
  finalFare: number,          // 最終車資（含加價）
  hotZone: {
    zoneName: string,
    surgeMultiplier: number   // 加價倍率
  } | null,
  autoAccept: {
    score: number,            // 自動接單分數 (0-100)
    allowed: boolean,         // 是否允許自動接單
    blockReason: string | null
  }
}
```

乘客端新增 `QUEUED` 狀態：
```typescript
{
  dispatchStatus: 'QUEUED',
  queuePosition: number,
  estimatedWait: number,      // 預估等待分鐘
  hotZoneInfo: { ... }
}
```

### 資料庫變更
- 新增 `driver_auto_accept_settings` 表
- 新增 `auto_accept_logs` 表
- 新增 `daily_auto_accept_stats` 表
- 新增 `hot_zone_configs` 表
- 新增 `hot_zone_quotas` 表
- 新增 `hot_zone_queue` 表
- 新增 `hot_zone_orders` 表
- 新增 SQL 函數：`calculate_surge_multiplier()`, `get_or_create_hourly_quota()`

---

## 📝 歷史修改（2025-12-12）- 智能派單系統 V2

### 新增功能
- ✅ **SmartDispatcherV2** - 分層派單引擎（每批 3 位司機，20 秒超時，最多 5 批）
- ✅ **ETAService** - 混合 ETA 策略（< 3km 估算，≥ 3km Google Distance Matrix API）
- ✅ **RejectionPredictor** - TensorFlow.js ML 拒單預測模型
- ✅ **六維度評分系統** - 距離/ETA/收入均衡/接單預測/效率匹配/熱區加成
- ✅ **強制拒單原因** - TOO_FAR/LOW_FARE/UNWANTED_AREA/OFF_DUTY/OTHER
- ✅ **派單監控 API** - `/api/dispatch/v2/*`（統計/行為模式/拒單分析）

### 新增檔案
```
src/services/SmartDispatcherV2.ts    # 核心分層派單引擎
src/services/ETAService.ts           # 混合 ETA 服務
src/services/RejectionPredictor.ts   # ML 拒單預測
src/api/dispatch-v2.ts               # 監控 API
src/db/migrations/001-smart-dispatch-tables.sql  # 資料庫遷移
```

### 資料庫變更
- 新增 `dispatch_logs` 表（派單決策日誌）
- 新增 `order_rejections` 表（詳細拒單記錄）
- 新增 `driver_patterns` 表（司機行為模式/ML特徵）
- 新增 `eta_cache` 表（ETA 快取）
- `orders` 表新增：dispatch_batch, dispatch_method, estimated_fare, google_eta_seconds, cancel_reason
- `drivers` 表新增：driver_type, preferred_zones, total_rejections

---

## ⚠️ 部署前必做（Next Steps）

### 1. 安裝 TensorFlow.js
```bash
cd ~/Desktop/HualienTaxiServer
pnpm add @tensorflow/tfjs-node
```

### 2. 執行資料庫遷移
```bash
npx ts-node src/db/migrate.ts smart-dispatch
```

### 3. 設定 Google Maps API Key
編輯 `.env`：
```env
GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
```

### 4. Android 端整合
在 `HomeScreen.kt` / `SimplifiedDriverScreen.kt` 中使用 `RejectOrderDialog`：
```kotlin
// 拒單時顯示原因選擇對話框
RejectOrderDialog(
    orderId = order.orderId,
    distanceToPickup = order.distanceToPickup,
    estimatedFare = order.estimatedFare,
    onDismiss = { showRejectDialog = false },
    onConfirm = { reason ->
        viewModel.rejectOrder(order.orderId, reason.code)
    }
)
```

---

## 📝 歷史修改（2025-11-12）
- ✅ **新增 WebSocket 即時通知機制（完整實作）**
  - 司機接單時即時通知乘客（PATCH /api/orders/:orderId/accept）
  - 訂單狀態更新時即時通知乘客（PATCH /api/orders/:orderId/status）
  - 提交車資時訂單直接完成並即時通知乘客（POST /api/orders/:orderId/fare）
  - 支援所有狀態：ACCEPTED（已接單）、ARRIVED（已抵達）、ON_TRIP（行程中）、DONE（已完成）
- ✅ **優化訂單流程**
  - 司機提交車資後訂單直接完成（狀態從 SETTLING 改為 DONE）
  - 自動記錄完成時間（completed_at）
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
│   ├── tariff.json           # 費率設定
│   └── asterisk/
│       └── extensions_taxi.conf  # Asterisk Dialplan 配置
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

### Phase 1 (Month 1-3) - MVP ✅ 完成
- [x] Server基礎架構
- [x] 訂單CRUD API
- [x] WebSocket派單（即時推播）
- [x] 簡易派單演算法（廣播給所有在線司機）
- [x] Android App整合（完整訂單流程）

### Phase 2 (Month 4-6) ⬅️ 當前
- [x] Whisper語音助理
- [ ] OCR跳表辨識
- [x] **改進派單演算法 (ETA + 拒單率)** - SmartDispatcherV2 ✅

### Phase 3 (Month 7-9)
- [ ] AI自動接單（基於 RejectionPredictor 擴展）
- [ ] 熱區配額

### Phase 4 (Month 10-12)
- [ ] 壓力測試與優化

---

## 📞 聯絡資訊

- 專案負責人：Eric
- 開發環境：macOS + Android Studio
- 部署位置：桌面 (`~/Desktop/HualienTaxiServer`)

---

**永遠只有一份文檔** - 如有更新請直接編輯本README

# 花蓮計程車司機端 - 後端伺服器

> **HualienTaxiServer** - 桌面自建後端系統
> 版本：v1.7.0-MVP
> 更新日期：2026-05-05

## 📝 最新修改（2026-05-05）- LINE 對話加付款方式選擇 + showConfirmCard 改 orchestrator

### 解決的問題
LINE 對話流程舊流程：pickup → dest → confirm，**付款方式硬寫 `payment_type='CASH'`**。
後果：
- 客人想用愛心卡 / 敬老卡完全沒處輸入
- 司機端訂單卡 SubsidyTag 永遠不會亮 → 司機接單後才發現要刷卡，但有些車沒刷卡機 → 載客糾紛
- LIFF 流程有完整 radio 選擇，跟 LINE 對話資料不一致

### 設計
**LINE 對話加一步 AWAITING_PAYMENT**（介於目的地後、確認前）：
1. AWAITING_PICKUP → AWAITING_DESTINATION → **AWAITING_PAYMENT** → AWAITING_CONFIRM
2. 三個 Quick Reply 按鈕：💵 現金 / ❤️ 愛心卡 / 👴 敬老卡
3. mirror LIFF 編碼：
   - 現金 → `payment_type=CASH, subsidy_type=NONE`
   - 愛心卡 → `payment_type=LOVE_CARD_PHYSICAL, subsidy_type=LOVE_CARD`
   - 敬老卡 → `payment_type=CASH, subsidy_type=SENIOR_CARD`（敬老仍收現金，只是有補貼）

### showConfirmCard 改成 orchestrator
原本 showConfirmCard 是 leaf method 直接顯示確認卡。現在改成 chained checks：

```
showConfirmCard(data):
  if pickupNote && !acked → AWAITING_PICKUP_NOTE_ACK
  if !paymentType → AWAITING_PAYMENT
  if RESERVE && !scheduledAt → AWAITING_SCHEDULE_TIME
  else → AWAITING_CONFIRM (orderConfirmCard)
```

各 postback handler（ACK_PICKUP_NOTE / PICK_PAYMENT）只負責改 data，
**re-call showConfirmCard 重新評估還缺什麼**。新增步驟未來只要加一個 if，
不用每處 handler 都改。

### orderConfirmCard 顯示付款方式
原 `orderConfirmCard(pickup, dest, fare)` 加兩個 optional 參數
`paymentType, subsidyType`，在卡片中間插入「付款方式：[現金/愛心卡/敬老卡]」一行。
新增 helper `paymentLabel()` 統一翻譯。

### Android 司機 App 零工作量
Order.kt 已有 `subsidyType` 欄位、SubsidyTag 已實裝、OrderTagRowLarge 已串好。
LINE 新訂單寫入正確 subsidy_type → SimplifiedDriverScreen 自動顯示 Tag。**不需發新 APK**。

### 影響檔案
- `src/services/LineMessageProcessor.ts` — ConversationData 加 paymentType/subsidyType/pickupNoteAcked，showConfirmCard 改 orchestrator，新 PICK_PAYMENT postback handler，createLineOrder + createScheduledOrder 用 data 取代硬寫 CASH，dispatch 也帶上 subsidyType
- `src/services/LineFlexTemplates.ts` — 新增 askPaymentTypeMessage、orderConfirmCard 加 paymentType/subsidyType 參數+顯示行，新增 paymentLabel helper

### 驗證
1. LINE 傳「叫車」→ 選 pickup → 選 dest → **應出現付款方式選擇**（4 個 Quick Reply）
2. 按「愛心卡」→ 確認卡顯示「付款方式：愛心卡」+ 司機 App 訂單卡顯示紅色「愛心卡」Tag
3. 按「敬老卡」→ 同上但顯示紫色「敬老卡」Tag
4. 按「現金」→ 確認卡顯示「現金」+ 司機端**沒 Tag**（NONE 不顯示，省 visual noise）
5. RESERVE 模式：選 pickup/dest 後也走付款 → 預約時間 → 確認，順序正確

### 設計決策
- **Quick Reply 而非 Flex Card 三按鈕**：付款方式只有 3 + 取消 4 個選項，Quick Reply 簡潔（小圖示 + 文字），不佔螢幕空間。Flex Card 適合需要副標的選項。
- **subsidyType=NONE 司機端不顯示 Tag**：現金訂單 ≈ 大部分。預設 + 例外的設計 — 司機看到 Tag 就要刷卡，沒 Tag 就是現金。
- **showConfirmCard orchestrator 模式**：未來加新步驟（例：行動不便服務、寵物攜帶等）只要加一個 if，不用每處改。

---

## 📝 歷史修改（2026-05-03 #2）- 地標上車提示備註 + 兩段確認 UI

### 解決的問題
某些地標（如慈濟醫院多個出入口、無障礙上車區）需要 admin 給客人具體位置指示「請站在 X 等」。
之前 admin 把這類提示誤塞進 `address` 欄位，造成客人看到亂七八糟的「到放輪椅的地方等...」。
現在開新欄位 `pickup_note` 專門承載，並設計兩段確認 UI 強制客人讀過再確認叫車。

### 設計
1. **DB schema**：landmarks 加 `pickup_note TEXT` 欄位（migration 016，nullable，沿用 IF NOT EXISTS）
2. **HualienAddressDB**：LandmarkEntry 加 `pickupNote`，rebuildIndex 容錯三新欄位是否存在
3. **LineMessageProcessor**：GeocodingResult / ConversationData 加 `pickupNote`，從 DB lookup 命中傳下來
4. **新確認流程**（`showConfirmCard()` 分流）：
   - 沒備註 → 直接 `orderConfirmCard`（既有行為，不變）
   - 有備註 → 先 `pickupNoteAckCard`（黃底警示卡 + 「我知道了，繼續叫車」按鈕） → 按了再進 `orderConfirmCard`
5. **新 postback action**：`ACK_PICKUP_NOTE` → 對應 `AWAITING_PICKUP_NOTE_ACK` 對話狀態
6. **admin form**：新增獨立區塊「📣 上車提示（給 LINE 客人看）」+ Antd `Input.TextArea` (200 字 maxLength + showCount)
7. **admin Table**：新欄位顯示 🟠「有」 Tag (hover 看內容) 或 「—」

### 為什麼不複用 address / aliases
- `address` 是行政地址用作派車基準，**機器讀**
- `aliases` 是 lookup 用的別名，**搜尋匹配**
- `pickup_note` 是給人類客人看的指示，**完全顯示用**

三者用途完全不重疊。混用就是上次「到放輪椅的地方等」的根源。

### 影響檔案
- `src/db/migrations/016-landmark-pickup-note.sql` — 新增
- `src/db/migrate.ts` — 註冊 016
- `src/services/HualienAddressDB.ts` — LandmarkEntry + rebuildIndex
- `src/services/LineMessageProcessor.ts` — interface 擴充 + showConfirmCard 分流 + ACK_PICKUP_NOTE handler
- `src/services/LineFlexTemplates.ts` — 新增 `pickupNoteAckCard()`
- `src/api/admin-landmarks.ts` — LandmarkInput + validateInput + INSERT/UPDATE/SELECT
- `admin-panel/src/services/api.ts` — Landmark / LandmarkInput interface
- `admin-panel/src/pages/Landmarks.tsx` — Form Item + Table column

### 部署步驟
```bash
cd /var/www/taxiServer
git pull
pnpm install
pnpm build
cd admin-panel && pnpm build && cd ..
pnpm migrate pickup-note
pm2 restart taxiserver
```

### 驗證
1. admin 編輯地標 → 看到「📣 上車提示」區塊 + 200 字 textarea
2. 填一個地標的 pickup_note 例如「請至大廳右側電梯旁」
3. LINE 傳該地標名稱（例「慈濟門診」）→ 應收到黃色警示卡 + 「我知道了」按鈕
4. 按「我知道了」 → 才進原本的「確認叫車資訊」卡
5. 沒填 pickup_note 的地標叫車流程不變（單卡確認）

### 設計決策
- **2 段卡 (ack → confirm)** 而非單卡黃框：強制 friction 確保客人真的讀過。要點 2 次才能下單，慢一點但更安全。
- **pickup_note 是 free-text 不限格式**：admin 比較好用、LINE Flex `wrap: true` 自動換行。沒像 address 那樣加正規化規則。
- **ack 後的 conversation_state = AWAITING_PICKUP_NOTE_ACK**：跟 AWAITING_CONFIRM 區分，避免狀態跳躍時誤判。

---

## 📝 歷史修改（2026-05-03）- LINE 叫車 NL 入口 + 地標資料品質大修

### 解決的問題（生產回報）
1. 客人傳「民國路 7-11 超商」→ 系統回「輸入叫車...」沒觸發叫車（要打「...到車站」才會）
2. 客人傳「慈濟輪椅」→ 顯示「中山路一段3巷138號」（錯地址，那是別棟樓）
3. 客人傳「慈濟門診輪椅」→ 顯示「**到放輪椅的地方等** 花蓮市中央路三段707號」（admin 把備註塞進 address 欄位，原文回給客人看）

### 根因
1. **NL 入口太嚴**：handleNaturalLanguage 全靠 GPT 判定意圖，「裸地名」被視為非叫車意圖。
2. **DB 資料髒**：7 筆 landmark 的 `address` 欄位被 admin 誤填動詞性備註、地名複製、typo（138號**號**）等。
3. **常用 alias 缺**：id=196「民國路7-ELEVEn 愛民門市」沒設「民國路7-11」這種自然講法的別名，DB lookup 必失敗。

### 修復（5 段一起上）

#### B3 + B4：NL 入口加 DB-first fast path
`src/services/LineMessageProcessor.ts` — `handleNaturalLanguage()` 進 GPT 之前先試
`hualienAddressDB.lookup()`，命中 EXACT/ALIAS/TAIGI 高信心結果即直接進 AWAITING_DESTINATION。
GPT prompt 也補上「使用者只給單一地點時也視為 CALL_TAXI」的判斷規則。
SUBSTRING 命中仍走 GPT（避免子字串多筆平手誤判，如「慈濟」命中 13 個 candidate）。

#### B1：admin Landmarks form 加 address 校驗
`admin-panel/src/pages/Landmarks.tsx` — Form Item rules 加：
- `address` 不可等於 `name`
- 不可含「到 X 的地方等」「請 X 等」「放 X 的地方」這類動詞備註
- 不可含 emoji、長度 6-100 字、結尾不可重複「號號」

#### B2：後端 admin-landmarks 寫入前 sanitize address
`src/api/admin-landmarks.ts` — 新增 `sanitizeAddress(input)` helper（log warning 但不擋），
在 `validateInput` 開頭呼叫。defense in depth：前端校驗擋使用者錯誤、後端 sanitize 兜底自動清。
另加 length 100 + name=address 後端校驗。

#### A1：fix-landmark-addresses.ts（一次性腳本）
`scripts/fix-landmark-addresses.ts` — 對指定 IDs `[23, 164, 165, 166, 167, 168, 236]`
用 Google Reverse Geocoding 重抓 formatted_address 寫回 DB。預設 dry-run、加 `--apply` 才寫。
部署後執行一次。

#### A2：add-common-aliases.ts（一次性腳本）
`scripts/add-common-aliases.ts` — 補幾組常用查詢 alias：
- id=196 加「民國路7-11」「民國路超商」「愛民7-11」等
- id=234 加「慈濟急診」「慈濟醫院急診室」
- id=236 加「慈濟門診」「慈院門診」「慈濟輪椅出入口」

UNIQUE 衝突 catch 跳過，冪等。

### 部署步驟

```bash
cd /var/www/taxiServer
git pull
pnpm install
pnpm build
cd admin-panel && pnpm build && cd ..
pm2 restart taxiserver

# 一次性腳本（需 GOOGLE_MAPS_API_KEY）
pnpm ts-node scripts/fix-landmark-addresses.ts            # dry-run 先看
pnpm ts-node scripts/fix-landmark-addresses.ts --apply    # 確認 OK 寫 DB
pnpm ts-node scripts/add-common-aliases.ts

pm2 restart taxiserver   # 讓 hualienAddressDB 重 build index
```

### 驗證
1. LINE 傳「民國路 7-11 超商」→ 應直接進「請輸入目的地」
2. LINE 傳「慈濟輪椅」→ 應顯示乾淨的地址（無「到放輪椅的地方等」前綴）
3. admin 編輯地標 → address 填「慈濟」(== name) 應被前端擋下
4. admin 編輯地標 → address 填「到放東西的地方等中央路 707」存檔 → 後端 log 警告，DB 存「中央路 707」

### 設計決策
- **DB-first fast path 只信高信心命中**：SUBSTRING 仍走 GPT，避免「慈濟」這種短詞 substring 命中錯
- **後端 sanitize 只清不擋**：admin 偶爾貼錯系統自動清；故意違規時前端擋下提供回饋
- **fix 腳本不寫進 migrate.ts**：依賴 Google API 且只跑一次，跟 schema migration 性質不同

---

## 📝 歷史修改（2026-05-01）- 地標 priority 欄位 UX 重設計（連續 0-10 → 三段語意化）

### 解決的問題
昨天（2026-04-26）替「優先級 (0-10)」加了 Tooltip 心法（9-10 / 6-8 / 5 / 2-3）後，
使用者仍反映「太複雜了根本不知道怎麼用」。本質問題：**0-10 連續數字是後端演算法
做大小比較用的內部實作，不該當業務概念暴露給管理員**。每次新增地標都要思考
「這個值該填多少」是不必要的決策疲勞 — 多數使用者真實需求只是「這個地標重不重要」，
並不需要 11 個檔位。

### 重設計：3 段 Segmented Control，純 UI 重構
把 `<InputNumber min={0} max={10}>` 換成 Antd `<Segmented>`，三個按鈕：

| 選項 | 寫入 DB priority | 對應使用情境 |
|------|------------------|----------------|
| 🔝 **主要** | 8 | 火車站、機場、慈濟、大景點 — 同名衝突要勝出 |
| ◎ **一般** | 5（預設） | 絕大多數地標都選這個 |
| ▪ **次要** | 2 | 冷門地標（補完整性，怕誤判） |

**完全不動後端、Schema、演算法**。DB 仍是 SMALLINT 0-10、HualienAddressDB 仍照數字大小排序。
UI 只是把連續值「降維投影」到 3 段 — 寫入時正規化為 8/5/2，讀取時把任意 0-10 數字
反推回三段顯示（≥7 主要、3-6 一般、≤2 次要）。

### Table 顯示
原本的數字欄位改用彩色 Tag：🔝 主要（金）、◎ 一般（藍）、▪ 次要（灰）。
排序仍按 DB 數字大小。

### 影響檔案（只動 1 個）
- `admin-panel/src/pages/Landmarks.tsx` — Form Item / Table column 改用 Segmented + Tag；
  新增 `normalizePriority()` helper、`PRIORITY_PRIMARY/NORMAL/MINOR` 常數；
  setFieldsValue 載入既有資料時先正規化以匹配 Segmented value。

### 既有資料如何處理
**不做 migration**。寫入時自然正規化：
- 編輯既有 priority=7 → 顯示「主要」→ 不改其他欄位存檔 → 變 8
- 編輯既有 priority=4 → 顯示「一般」→ 存檔變 5
- 6 和 7 在使用者心智中沒差別，正規化反而讓 DB 更乾淨

### 為什麼是 3 段不是 5 段
每多一個選項認知負擔翻倍。3 段已是甜蜜點；多一段使用者又開始猶豫「中等到底是中還是中高」。
真正需要精細調控的是極少數 power user，可走 SQL 後路。

### 部署步驟
純前端改動：
```bash
cd /var/www/taxiServer
git pull
cd admin-panel && pnpm build  # 不需重啟 pm2
```

### 驗證
1. 開 `https://api.hualientaxi.taxi/admin/landmarks` → 點「新增地標」→ Form 看到 3 個按鈕（預設「一般」）
2. 編輯既有 priority=7 的地標 → 表單顯示「主要」選中
3. Table 列表的「重要程度」欄變成彩色 Tag
4. 新增「主要」地標 → 後端 DB 應寫入 priority=8

---

## 📝 歷史修改（2026-04-26）- 花蓮火車站禁止上車區引導機制

### 解決的問題
花蓮火車站上方（站體周圍計程車排班區外）依當地計程車管理規定**禁止載客**，違規會被開罰／驅趕。
但客人會自然地說「到花蓮火車站」、在地圖選火車站位置，舊系統會直接接單派車 → 司機到場才發現不能載客。

### 解法：三管道（LIFF / LINE / 電話）攔截 + 4 個合法替代上車點
landmarks 表加兩個欄位（`is_forbidden_pickup`、`alternative_pickup_landmark_ids`），
seed 一次性把花蓮火車站標記禁止 + 4 個替代點：花蓮轉運站 / 轉運站7-11 / 回瀾青年旅館 / 阿美麻糬。
三個入口的 `geocodeAddress()` 命中禁止地標時，回傳 `forbiddenPickup` 欄位，呼叫端：
- **LIFF（booking.html）**：Modal 強制覆蓋確認鍵，4 個替代點按鈕，點擊後地圖移動 + pickup 替換
- **LINE 對話**：Flex Message 紅底警示 + 4 Quick Reply 按鈕，postback `PICK_ALTERNATIVE&landmarkId=N`
- **電話**：客人沒法即時點選 → 標 `processing_status='NEEDS_REVIEW'`，operator 撥回提供替代點

### 影響檔案（9 個）
- `src/db/migrations/015-forbidden-pickup-zones.sql` — **新增**
  - landmarks 加 `is_forbidden_pickup BOOLEAN`、`alternative_pickup_landmark_ids INTEGER[]`
  - 部分索引 `idx_landmarks_forbidden_pickup` 只索引被禁止的地點
- `scripts/seed-forbidden-pickup-zones.ts` — **新增**
  - 用 Google Geocoding API + Places fallback 抓 3 個新地標座標（含 Hualien bounds 驗證）
  - 冪等：依 `name` 跳過已存在；別名衝突自動跳過
  - 設定花蓮火車站 forbidden + alternatives = [花蓮轉運站, 7-11, 回瀾, 阿美麻糬]
- `src/db/migrate.ts` — **註冊** `forbidden-pickup` migration key
- `src/services/HualienAddressDB.ts` — **擴充**
  - `LandmarkEntry` 加 `id`、`isForbiddenPickup`、`alternativePickupLandmarkIds`
  - 新增 `idIndex: Map<number, LandmarkEntry>` 給 alternative lookup
  - `rebuildIndex()` 帶欄位存在性檢查（容錯：runtime 在 migration 015 跑之前 / 之後都不會炸）
  - 新方法 `findNearbyForbidden(lat, lng, radius)` — 座標反查（半徑 100m）
  - 新方法 `getForbiddenAlternatives(landmarkName)` — 從 idIndex 回傳替代地標
- `src/services/LineMessageProcessor.ts` — **三入口攔截**
  - `GeocodingResult` 加可選 `forbiddenPickup` 欄位
  - `geocodeAddress()` DB lookup 分支 + Google API 結果分支都套 `buildForbiddenPickupByCoords`
  - **不快取 forbiddenPickup 結果**（每次都要攔截）
  - `interceptForbiddenPickup()` helper 把替代點塞進 `conversation_data.forbiddenAlternatives`、回 forbiddenPickupCard、保持 AWAITING_PICKUP
  - 套用到 `handleAddressInput` / `handleLocationMessage` / `handleNaturalLanguage` 三個入口
  - 新 postback action `PICK_ALTERNATIVE&landmarkId=N` → `handlePickAlternative()` 把選中的替代點寫進 pickup → 前進 AWAITING_DESTINATION
- `src/services/PhoneCallProcessor.ts` — **電話端攔截**
  - 同樣擴充 `GeocodingResult` 介面 + `buildForbiddenPickup` / `buildForbiddenPickupByCoords`
  - `geocodeAddress()` DB / Geocoding API / Places Search 三條路徑都套；命中時 skip Redis cache
  - `handleNewOrder()` 偵測 `pickupGeo.forbiddenPickup` → 改走新方法 `handleForbiddenPickupCall()`
  - `handleForbiddenPickupCall` 標 `NEEDS_REVIEW` + `error_message` 帶禁止地點 + 替代點清單；推 `phone:forbidden_pickup` socket 事件
- `src/services/LineFlexTemplates.ts` — **新增** `forbiddenPickupCard(matchedLandmark, alternatives)`
  - 紅底 header「⚠️ {地名}不可上車」+ 4 個 primary button (footer vertical)
  - postback data: `action=PICK_ALTERNATIVE&landmarkId=N`
  - label 超過 12 字自動截斷（LINE 按鈕標籤限制）
- `src/api/line-liff.ts` — **新增** `GET /api/line/liff/check-pickup`（公開無 auth）
  - 接受 `lat+lng` 或 `address` 任一
  - 回 `{ forbidden, matchedLandmark?, alternatives? }`
- `public/liff/booking.html` — **新增 Modal + 拓展 updateLocation**
  - `updateLocation()` 在 pickup 步驟呼叫 `checkForbiddenPickup()`，命中即跳 Modal
  - 新增 `forbiddenModal` overlay（紅底警示 + 4 個按鈕，直接刻 inline style）
  - `pickAlternativeLocation(alt)` 替換 pickup 並把地圖移到該點
  - 用 DOM API 建按鈕（textContent / appendChild）避免 XSS
  - 用 `lastForbiddenCheckKey` 去重，避免 `map.idle` 重複觸發

### 部署步驟
```bash
cd /var/www/taxiServer
git pull
pnpm install
pnpm build
# 跑 migration（idempotent）
pnpm migrate forbidden-pickup
# 抓 3 個替代地標座標 + 設定花蓮火車站 forbidden（需 GOOGLE_MAPS_API_KEY）
pnpm ts-node scripts/seed-forbidden-pickup-zones.ts
pm2 restart taxiserver
pm2 logs taxiserver --lines 30 --nostream
```

### 驗證
1. **LINE 對話**：傳「花蓮火車站」→ 收到紅色 Flex Message 4 個按鈕，點轉運站 → 流程繼續到目的地
2. **LIFF 搜尋**：地圖搜尋「花蓮火車站」→ 跳 Modal 4 個按鈕；點 7-11 → pickup 替換 + 地圖移動
3. **LIFF 拖曳**：把 marker 拖到火車站位置 → 也跳 Modal（座標反查命中 100m 範圍）
4. **電話訂單**：模擬「我在花蓮火車站」→ phone_calls 應 `NEEDS_REVIEW`，admin 後台收到 `phone:forbidden_pickup` 推送
5. **舊資料**：歷史訂單不受影響（migration 只加 schema 不動 orders）

### 設計決策
- **不做派單前最後 50m 防線**：三層攔截已夠；過度設計
- **不做 admin UI 編輯禁止 flag**：目前只 1 個禁止點，硬編 seed 即可；未來多禁止點再做地標管理頁 toggle
- **不做乘客 App 端**：花蓮業務主要走 LINE / LIFF / 電話三管道
- **forbiddenPickup 結果不快取**：每次都要攔截，避免某客人「曾通過」讓後面客人也通過

---

## 📝 歷史修改（2026-04-24）- PR2 客人反向通知分派層（灰度 flag 預設關閉）

### 解決的問題
PR1 已把 SmsNotifier、migration、customer_notifications 表、feature flag 都建好，
但 `84219a6` commit 為了快速 ship no-show 流程，在 3 個地方**直接呼叫 LINE** 繞過
尚未存在的分派層：
- `orders.ts:395-401` PATCH /accept 接單推 LINE
- `orders.ts:645-651` PATCH /status 的 ARRIVED/DONE/CANCELLED 推 LINE
- `SmartDispatcherV2.ts:1002-1009` 派單失敗推 LINE

問題是這些 shortcut：
- 電話叫車客人（無 LINE）**完全收不到通知** — 核心業務痛點仍未解
- 不寫 `customer_notifications` 表 → admin 後台看不到通知歷史
- 無去重、無 feature flag 可秒級關閉、無失敗追蹤

### 本次改動（PR2 — 接入分派層，範圍收斂到 3 個事件）
新增 `CustomerNotificationService`（LINE 優先、SMS 備援的分派核心），並 refactor
3 個掛鉤點從直接呼叫 LineNotifier 改為走分派層。**刻意收斂範圍**：
- ✅ **PR2 範圍**（走分派層，含 SMS 降級）：`DRIVER_ACCEPTED` / `DRIVER_ARRIVED` / `DISPATCH_FAILED`
- ❌ **保留 84219a6 shortcut**（LINE-only）：`DONE` (trip completion) / `CANCELLED` (含 NO_SHOW) / `DRIVER_WAITING` (no-show 倒數)
- 📅 **PR2.5 規劃**：NO_SHOW 也補 SMS 降級（需新 migration 擴充 event CHECK）

### Feature flag 控制
部署後預設 `CUSTOMER_NOTIFICATION_ENABLED=false`，**分派層完全 noop、行為等同
84219a6 時期**。觀察 1 小時無異常後手動切 `true` 啟用 SMS 降級。出問題可秒級關閉。

### 影響檔案
- `src/services/CustomerNotificationService.ts` — **新增**
  - 3 個 public method：`notifyDriverAccepted` / `notifyDriverArrived` / `notifyDispatchFailed`
  - dispatch 核心：feature flag 檢查 → 去重查詢 → 查訂單 → LINE 優先 → SMS 備援
  - 自動寫入 `customer_notifications` 表 + 更新 `orders.notification_channel`
  - 單例管理（與 LineNotifier / SmsNotifier 風格一致）
  - 預留 3 個決策點 TODO：
    - ★ A: SMS 模板文案（已給安全預設值可直接上線）
    - ★ B: LINE 失敗降級策略（預設不降級最保守）
    - ★ C: 手機正規化擴充（PR1 已有最小實作）
- `scripts/test-customer-notification.ts` — **新增**
  - 8 個 test case：feature flag / LINE 優先 / SMS 備援 / 兩者皆無 / 去重 /
    LINE 失敗不降級 / SMS 失敗寫 FAILED / 訂單不存在
  - 結果：**28/28 pass**
- `src/index.ts` — **修改**
  - 追加 `initSmsNotifier()`（MITAKE_* env 檢查 + try/catch）
  - 追加 `initCustomerNotificationService()`（依賴 LINE + SMS 都 init 成功才啟用）
  - 啟動 log 顯示 feature flag 狀態
- `src/api/orders.ts` — **修改 2 個掛鉤點**
  - L395 PATCH /accept：`ACCEPTED` 優先走分派層，分派層未啟用時 fallback 舊 shortcut
  - L645 PATCH /status 萬用 endpoint：拆分 `ARRIVED` (走分派層) vs `DONE/CANCELLED` (保留 shortcut)
  - 新增 `import { getCustomerNotificationService }`
- `src/services/SmartDispatcherV2.ts` — **修改 L1002-1013**
  - `handleNoDriversAvailable` 的 LINE shortcut 改走分派層
  - 保留 late-binding `require()` + try/catch 防禦模式（LineNotifier 原本的設計）
  - 分派層未 init 時 fallback 到舊 LineNotifier 行為

### 部署步驟（灰度流程）
```bash
cd /var/www/taxiServer
git pull
pnpm install
pnpm build
pm2 restart taxiserver
pm2 logs taxiserver --lines 30 --nostream
# 確認 log 出現：
# [系統] SMS 通知服務已初始化（三竹 Mitake）     ← 若 MITAKE_* 已設
# [系統] 客人反向通知分派層已初始化（feature flag: DISABLED）

# 觀察 1 小時無異常後切 feature flag
sed -i 's/CUSTOMER_NOTIFICATION_ENABLED=false/CUSTOMER_NOTIFICATION_ENABLED=true/' /var/www/taxiServer/.env
pm2 restart taxiserver
# 預期 log：feature flag: ENABLED

# 出問題秒級關閉
sed -i 's/CUSTOMER_NOTIFICATION_ENABLED=true/CUSTOMER_NOTIFICATION_ENABLED=false/' /var/www/taxiServer/.env
pm2 restart taxiserver
```

### 驗證
```bash
# 1. 本地：跑測試腳本
pnpm ts-node scripts/test-customer-notification.ts
# 預期：28 pass / 0 fail

# 2. 本地：型別檢查
npx tsc --noEmit
# 預期：0 error

# 3. Server：切 flag=true 後跑真實訂單測試（LINE 訂單）
#    接單 → 查 customer_notifications 應有 DRIVER_ACCEPTED / LINE / SENT 紀錄
sudo -u postgres psql -d hualien_taxi -c \
  "SELECT order_id, event, channel, status, sent_at FROM customer_notifications ORDER BY sent_at DESC LIMIT 5"

# 4. 去重驗證：同訂單重複 PATCH /accept → 第二次無新紀錄
```

### 成本監控（SQL query，放 admin 後台儀表板）
```sql
-- 今日 SMS 成本估算（三竹 NT$0.7/則）
SELECT
  DATE(sent_at) AS day,
  COUNT(*) FILTER (WHERE channel = 'SMS' AND status = 'SENT') AS sms_sent,
  COUNT(*) FILTER (WHERE channel = 'LINE' AND status = 'SENT') AS line_sent,
  COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
  COUNT(*) FILTER (WHERE channel = 'SMS' AND status = 'SENT') * 0.7 AS sms_cost_ntd
FROM customer_notifications
WHERE sent_at >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY DATE(sent_at)
ORDER BY day DESC;
```

### 注意事項
- PR2 部署後若 `CUSTOMER_NOTIFICATION_ENABLED=false`（預設），**整個分派層 noop、
  行為等同 84219a6** — 司機接單 / 到達 / 派單失敗走的是 LineNotifier 舊 shortcut
- 切 `true` 後才會啟用 SMS 降級、`customer_notifications` 表才有紀錄
- 三竹帳號若未設 `MITAKE_*` env，SmsNotifier 不會初始化 → CustomerNotificationService
  不會初始化 → flag 即使 true 也會 fallback 回舊 shortcut（安全降級）
- 三個決策點的 TODO 位置已標記在 `CustomerNotificationService.ts`，你可隨時 override

---

## 📝 歷史修改（2026-04-24）- PR1 客人反向通知基礎建設（尚未接入流程）

### 解決的問題（規劃中）
電話叫車 / LINE 叫車的客人目前**完全收不到主動通知**：
- 長輩打電話叫車後不確定有沒有叫到車，會重複打第二通第三通佔用客服線
- 司機到達上車點時客人沒下樓 → 平均多等 2-4 分鐘、車隊週轉率下降
- 派單無車可接時客人呆等 → 產生客訴

`LineNotifier.notifyOrderStatusChange()` 已寫好（handles ACCEPTED / DONE / CANCELLED），
但**接單 / 抵達 / 失敗這三個時機都沒有人呼叫它**；SMS 通道則完全未建置。

### 本次改動（PR1 — 基礎建設，零行為變化）
新增通知分派所需的 **資料表 / SMS 服務類別 / 環境變數**，但**尚未接入任何現有流程**，
因此部署後不會有任何對外通知發送。接入流程於 PR2 完成。

### 影響檔案
- `src/db/migrations/012-customer-notifications.sql` — 新增
  - `orders` 表：`notification_channel` / `line_notification_sent_at` / `sms_sent_at` 三欄（冪等 ALTER）
  - 新建 `customer_notifications` 表（通知歷史，含 order_id / event / status / error_code 等，
    遵守「錯誤完整顯示」原則，ON DELETE CASCADE 到 orders）
  - 4 個索引（order_id、status+event、sent_at、dedupe 用 order_id+event+status）
- `src/services/SmsNotifier.ts` — 新增
  - 串三竹 Mitake HTTP API（純文字回應，內建 statuscode 對照表）
  - Node 18+ 內建 `fetch` + `AbortController` 實作 10 秒 timeout（不裝 axios）
  - in-memory rate limit（每手機每小時 3 則，多節點部署再升級 Redis）
  - `normalizeTaiwanMobile()` 支援格式：`0912345678` / `0912-345-678` / `0912 345 678`
    / `(0912)345-678` / `+886912345678` / `886912345678`；市話、缺 0、位數錯誤回 `null`
    （此函式標註為 **決策點 C**，可依實際客人輸入習慣擴充）
  - 單例管理 `initSmsNotifier()` / `getSmsNotifier()`（與 `LineNotifier` 風格一致）
- `scripts/test-sms-notifier.ts` — 新增
  - 本地測試 `normalizeTaiwanMobile` 13 個 case（無需 API）
  - 三竹**測試端點**（`SmSendGetSim.asp`，不扣費）整合測試
  - 格式錯誤不扣 rate limit 額度驗證
  - `FORCE_REAL_SEND=1` 防呆：發現正式端點 URL 時要求額外旗標才送
- `.env.example` — 新增
  - `MITAKE_SMS_USERNAME` / `MITAKE_SMS_PASSWORD` / `MITAKE_SMS_API_URL`
  - `CUSTOMER_SERVICE_PHONE`（通知訊息變數）
  - `CUSTOMER_NOTIFICATION_ENABLED=false`（feature flag，PR2 生效，秒級可關）
  - `TEST_PHONE` / `FORCE_REAL_SEND` 測試變數

### 部署步驟
```bash
cd /var/www/taxiServer
git pull
pnpm install
# 執行 migration
sudo -u postgres psql -d hualien_taxi -f src/db/migrations/012-customer-notifications.sql
pnpm build
pm2 restart taxiserver
# 確認無錯誤
pm2 logs taxiserver --lines 30
```

### 驗證
```bash
# 1. Migration 冪等測試（可重複執行不報錯）
sudo -u postgres psql -d hualien_taxi -f src/db/migrations/012-customer-notifications.sql

# 2. 表結構確認
sudo -u postgres psql -d hualien_taxi -c "\d customer_notifications"
sudo -u postgres psql -d hualien_taxi -c "\d orders" | grep -E "notification_channel|line_notification|sms_sent"

# 3. SmsNotifier 本地邏輯測試（無需三竹帳號）
pnpm ts-node scripts/test-sms-notifier.ts
# 預期：normalizeTaiwanMobile 13 個 case 全 pass，三竹 API 測試跳過（無帳號）

# 4. 申請三竹帳號後於 .env 填入 username/password 並再跑一次測試腳本
```

### 注意
- 本 PR **不接入任何現有流程**：`SmartDispatcherV2` / `orders.ts` 完全未動
- `CUSTOMER_NOTIFICATION_ENABLED` 預設為 `false`，PR2 部署時保持 `false` 驗證後再切 `true`
- 三竹帳號申請：https://sms.mitake.com.tw/ （企業方案每則 NT$0.7，月結）
- 三個業務決策點（通知文案、LINE 失敗降級策略、手機格式擴充）留至 PR2 實作

---

## 📝 歷史修改（2026-04-24）- 防護網雙層 + Bull → BullMQ 遷移 + dead code 清理

### 解決的問題
- pm2 觀察到 7 小時內重啟 48 次 — 多數是 **Bull queue 內部 floating promise rejection**：
  ioredis 的 `client.subscribe`/`client setname` 失敗時 throw 而非 emit 'error'，
  繞過 cache.ts 的 `redis.on('error')` 攔截，整個 server process 倒掉。
- queue.ts 5 queue + aggregator.ts 整檔是 **dead code**（grep 確認 0 callers），
  仍在 production 跑著浪費 20 個 Redis connection 並產生噪音 log。
- 時區：本機 dev (Asia/Taipei) 寫的 `getHours()` 邏輯部署到 production (UTC) 後夜費率失效。

### 三層防護架構
1. **Layer 1 process-level 防護**（`src/index.ts`）：
   `process.on('uncaughtException' / 'unhandledRejection')` 接住所有漏網錯誤，
   log 但不 exit — 讓 server 即使遇到 module 內部 floating promise 也不會被 pm2 連鎖重啟。
2. **Layer 2 service-level 防護**：
   - `cache.ts` 14 個 export function 已全部 try/catch + return null/false（既存）
   - `circuit-breaker.ts` 已有 `redisCircuitBreaker` with `() => null` fallback（既存）
   - `services/queue.ts`、`services/ScheduledOrderService.ts` 加 `.on('error'/'failed')` 健康追蹤
   - `middleware/security.ts` rate limiter / IP blacklist 包 try/catch + **fail-open**
     （Redis 失敗時讓 request 過，避免整個 site 503）
3. **BullMQ migration**：移除 Bull 套件，從根源消除 floating promise 噪音來源。

### Bull → BullMQ 遷移（Option B → 簡化收尾）
- 新增抽象層 `src/services/queue/IQueueAdapter.ts` + `BullMQAdapter.ts`
  （為未來新增 queue 預備乾淨介面）
- `ScheduledOrderService` 從 Bull 遷到 BullMQAdapter — 預約訂單派單 / 提醒邏輯不變，
  Redis 連線錯誤不再 leak 為 unhandledRejection
- 規劃 Phase 2 時 grep callers 發現 `queue.ts` 與 `aggregator.ts` 整體 dead：
  | 元素 | Callers |
  |------|---------|
  | orderQueue / notificationQueue / batchUpdateQueue / locationTrackingQueue | 0 |
  | analyticsQueue | 唯一 caller 是 dead 的 aggregator.ts |
  | setupScheduledJobs / getQueueStats / cleanQueues / closeQueues | 0 |
  | aggregator.ts 4 class + 2 instance + scheduleDailyAggregation | 0 |
- **直接刪除取代漸進遷移** — 1220 行 dead code 一次性清掉，`pnpm remove bull`。
- 結果：原 5-7 天的 Bull → BullMQ 遷移 → **1 小時收工**。

### 時區修正
`FareConfigService.calculateFare()` 之前用 `at.getHours()` 取本地小時。
本機 dev macOS 系統時區是 Asia/Taipei 看似正常；部署到 production UTC server 後
「23:00 +08:00」進來變 UTC 15:00 → `getHours()` 回 15 → 不算夜時段 → 夜費率永遠不生效。
新增 `toTaipei(at)` helper 手算 UTC + 8 偏移（台北無夏令時，固定 +8 比 Intl.DateTimeFormat 更可靠）。

### 影響檔案
- `src/index.ts` — Layer 1 process handler + 註解更新
- `src/services/queue/IQueueAdapter.ts` — 新增抽象介面（5-10 method）
- `src/services/queue/BullMQAdapter.ts` — 新增 BullMQ 實作（Queue + Worker + QueueEvents 三件套）
- `src/services/ScheduledOrderService.ts` — 改用 BullMQAdapter
- `src/services/cache.ts` — 既有 try/catch（無改動，僅確認）
- `src/middleware/security.ts` — rate limiter / IP blacklist fail-open
- `src/services/FareConfigService.ts` — toTaipei() helper
- `src/services/queue.ts` 🗑️ 刪除（dead code）
- `src/services/aggregator.ts` 🗑️ 刪除（dead code）
- `src/services/queue/BullAdapter.ts` 🗑️ 刪除（Phase 0 wrapper，dead 後不需）
- `package.json` — pnpm remove bull 4.16.5

### 部署步驟
```bash
cd /var/www/taxiServer
git pull
pnpm install        # 移除 bull、保留 bullmq
pnpm build          # tsc → dist/
pm2 restart taxiserver
pm2 logs taxiserver --lines 50   # 確認 [ScheduledOrderService] 預約排程服務已初始化（BullMQ）
```

### 驗證效果
- ✅ `unhandledRejection` 從每次啟動 2-4 個 → **0**
- ✅ Codebase 少 **1220 行**（commit diff `+7 / -1227`）
- ✅ Production memory 預期下降（少 20 個閒置 Redis connection）
- ✅ Bootstrap log 少 6 行 queue init 訊息
- 🔬 觀察點：pm2 ↺ 重啟頻率應從 6.8/hr 降到接近 0

---

## 📝 歷史修改（2026-04-22）- 費率對齊花蓮縣府公告 + admin schema 重構

### 解決的問題
- Admin Settings 費率頁面架構是「單組費率 + `nightSurchargeRate=0.2` 百分比加成」，**與花蓮縣政府公告的「日夜雙組獨立跳距」結構不相容**。直接套公告數字會導致夜間加成被算兩次。
- 缺：低速計時欄位、春節加成欄位、admin UI 顯示愛心卡補貼欄位。
- bug：`FareConfigService.saveToEnv()` 的 regex template literal `${key}` 不見了，按儲存會把 `.env` 寫壞。

### 重構
- **Schema 從扁平改為巢狀**：`day` / `night` / `springFestival` / `loveCardSubsidyAmount`，**移除 `nightSurchargeRate`**（不留向下相容 shim）。
- **持久化從 `.env` 改為 `config/fareConfig.json`**：JSON 天然吻合巢狀結構，避免 `FARE_DAY_*` 前綴 hack。
- **`calculateFare(distanceMeters, at?, slowTrafficSeconds?)`**：時間判斷優先級為「春節 → 夜間 → 日間」（春節期間強制套夜費率，吻合公告「全日套夜間費率」）。
- **Admin UI 重構為四區**：日費率 / 夜費率 / 春節加成 / 愛心卡補貼，每區有即時試算 Alert。
- **春節日期採 admin 手動設定**（DatePicker），不引入農曆函式庫。

### 預設值（對齊花蓮縣府公告）
| 區段 | 起跳價 | 起跳距離 | 每跳價 | 每跳距離 | 低速計時 | 低速金額 |
|------|------|------|------|------|------|------|
| 日費率 | 100 元 | 1000 m | 5 元 | 230 m | 120 秒 | 5 元 |
| 夜費率 (22:00–06:00) | 100 元 | 834 m | 5 元 | 192 m | 100 秒 | 5 元 |
| 春節加成 | — | — | — | — | — | 每趟 +50 元，全日套夜費率 |
| 愛心卡補貼 | — | — | — | — | — | 每趟 73 元 |

> **低速計時功能**：欄位已存於 schema，但 GPS 計時整合（追蹤車輛靜止時間）為下階段獨立 feature。目前計算傳入 `slowTrafficSeconds = 0`。

### 修改檔案
- `src/services/FareConfigService.ts` — 全部重寫（schema、calculateFare、persist）
- `src/api/config.ts` — 新巢狀 PUT、calculate 加 `at` 參數
- `admin-panel/src/pages/Settings.tsx` — UI 重構為四區
- `config/fareConfig.json` — 新建（取代 `.env` 持久化）
- Android 同步：`data/remote/dto/FareConfigDto.kt`、`utils/FareCalculator.kt`、`ui/screens/passenger/PassengerHomeScreen.kt`、`viewmodel/HomeViewModel.kt`

### 部署步驟
```bash
cd /var/www/taxiServer
git pull
pnpm install
cd admin-panel && pnpm install && pnpm build
cd ..
pm2 restart taxi-server
# 首次啟動會自動建立 config/fareConfig.json（用內建預設值）
# 確認 .env 不再有 FARE_NIGHT_SURCHARGE_RATE 等舊變數（無則無事）
```

### 驗證步驟
```bash
# 日 1km — 預期 100
curl -X POST http://localhost:3000/api/config/fare/calculate \
  -H "Content-Type: application/json" \
  -d '{"distanceMeters":1000,"at":"2026-04-22T14:00:00+08:00"}'

# 日 2km — 預期 100 + ceil(1000/230)*5 = 100 + 25 = 125
curl -X POST http://localhost:3000/api/config/fare/calculate \
  -H "Content-Type: application/json" \
  -d '{"distanceMeters":2000,"at":"2026-04-22T14:00:00+08:00"}'

# 夜 1km (23:00) — 預期 100 + ceil(166/192)*5 = 105
curl -X POST http://localhost:3000/api/config/fare/calculate \
  -H "Content-Type: application/json" \
  -d '{"distanceMeters":1000,"at":"2026-04-22T23:00:00+08:00"}'

# 春節 + 1km (需先在 admin UI 啟用春節並設定日期) — 預期 105 + 50 = 155
curl -X POST http://localhost:3000/api/config/fare/calculate \
  -H "Content-Type: application/json" \
  -d '{"distanceMeters":1000,"at":"2026-02-17T14:00:00+08:00"}'
```

---

## 📝 歷史修改（2026-04-21）- 後台白屏 `Cannot GET /login` 根治

### 解決的問題
後台使用中按瀏覽器**返回鍵 / 刷新鍵**偶發白屏，網址列變成 `https://api.hualientaxi.taxi/login`（**沒有 `/admin` 前綴**），頁面顯示 `Cannot GET /login`。此問題存在已久，只在 token 過期（1 小時）時觸發，所以不易複現但用久必踩。

### 根因
`admin-panel/src/services/api.ts` 的 axios 401 攔截器使用 `window.location.href = '/login'` 跳轉，**繞過了 React Router 的 `basename="/admin"`**。瀏覽器直接打伺服器的裸 `/login`，Express 的 SPA catch-all（`app.get('/admin{/*path}', ...)`）不接這條路徑，所以回 `Cannot GET /login`，且這個壞網址會寫進瀏覽器歷史，之後任何返回/刷新都重現。

另外 `admin-panel/src/pages/Dashboard.tsx` 的 `<a href="/orders">` 也有同樣繞過 basename 的問題（點「查看全部」會整頁打到裸 `/orders`）。

### 修改檔案
- `admin-panel/src/services/api.ts` — 401 攔截器的跳轉路徑改為完整 `/admin/login`
- `admin-panel/src/pages/Dashboard.tsx` — `<a href="/orders">` 改為 `<Link to="/orders">`（`react-router-dom`），自動套 basename 且為 SPA 切換不整頁刷新

### 為什麼不在 Express 加「裸 `/login` 重定向」
伺服器層補丁會把前端責任漏進 API 命名空間，未來若再有其他路徑漏前綴（例：`/orders`、`/dashboard`）就要一條條補，防不勝防。從源頭修前端是唯一根本解。

### 部署步驟

```bash
# 在 Lightsail 15.164.245.47
cd /var/www/taxiServer/admin-panel
git pull
pnpm install
pnpm build
# Server 不需重啟（只改了前端靜態檔案），但若要保險也可 pm2 restart
```

### 驗證步驟
1. 登入後台，DevTools 把 `localStorage.admin_token` 改成無效字串
2. 操作任一頁觸發 API 呼叫 → 應自動跳到 `https://api.hualientaxi.taxi/admin/login`（**不是裸 `/login`**）
3. 按返回鍵、按刷新鍵 → 不再出現 `Cannot GET /login` 白屏
4. Dashboard 點「查看全部」→ 網址 `/admin/orders`，且無整頁刷新（SPA 切換）

### 開發規範（往後新增代碼請遵守）
- **後台前端禁止使用 `window.location.href = '/xxx'` 跳到內部頁面** — interceptor 等非 React 環境也必須寫完整路徑 `/admin/xxx`
- **`<a href>` 連到後台內部頁面一律改用 `<Link to="xxx">`** — 否則繞過 basename + 失去 SPA 體驗

---

## 📝 歷史修改（2026-04-19）- 地標管理後台 + App 端動態同步

### 解決的問題
LINE / 電話 / App 語音叫車常遇到「找不到地點」— 以前要工程師改 `HualienAddressDB.ts` 與 Android `HualienLocalAddressDB.kt`（兩份 hardcoded）再重新部署 + 發 APK，運營沒辦法自己維護，變成「打地鼠」。

### 功能
1. **Admin Panel 新增兩個頁面**：
   - 「地標管理」：列表 / 搜尋（名稱+別名）/ 分類篩選 / Leaflet 地圖點選座標 / 別名 Tag 管理 / 軟刪除+還原 / 審計歷史
   - 「待補齊地標」：系統自動收集 LINE/電話/App 叫車時匹配失敗的查詢（含 Google 補救座標），按次數排序，一鍵轉為新地標
2. **資料庫化**：`HualienAddressDB.ts` 原本 hardcoded 的 98 筆地標搬到 PostgreSQL `landmarks` + `landmark_aliases` 表；啟動時 load 進記憶體，Admin 儲存後自動原子重建索引（不需重啟 Server）
3. **App 端動態同步**：App 啟動時呼叫 `GET /api/landmarks/sync`，把最新地標合併到 `HualienLocalAddressDB` 的動態索引；hardcoded 永遠保留作為離線 fallback
4. **審計與安全**：所有寫入有 `before`/`after` JSONB diff；軟刪除可還原；座標強制花蓮縣地理圍籬驗證；角色權限（ADMIN 才能寫，OPERATOR 只能讀）

### 新增檔案
- `src/db/migrations/009-landmarks.sql` — landmarks / landmark_aliases / landmark_audit 表
- `src/db/migrations/010-address-failures.sql` — address_lookup_failures 表
- `src/db/landmarks_seed_data.ts` — 原 98 筆 LANDMARKS 資料，供 seed 使用
- `src/db/seed_landmarks.ts` — 首次資料匯入腳本（冪等，ON CONFLICT DO NOTHING）
- `src/services/AddressFailureLogger.ts` — 兩段式記錄器（recordFailedQuery + attachGoogleResult）
- `src/api/admin-landmarks.ts` — Admin CRUD（掛在 `/api/admin/landmarks`）
- `src/api/admin-address-failures.ts` — 待補齊地標 API
- `src/api/landmarks.ts` — App 同步 API（`/api/landmarks/sync`，公開讀）
- `admin-panel/src/pages/Landmarks.tsx` + `admin-panel/src/pages/AddressFailures.tsx`
- `admin-panel/src/components/LandmarkMapPicker.tsx` — Leaflet 原生整合（免 Google Maps key）

### 修改檔案
- `src/services/HualienAddressDB.ts` — 移除 hardcoded LANDMARKS[]，改從 DB 載入，新增 `rebuildIndex()` 公開方法（原子替換 Map 參照，lookup 併發安全）
- `src/services/LineMessageProcessor.ts`、`src/services/PhoneCallProcessor.ts` — 在 `geocodeAddress` 中掛 fire-and-forget 失敗記錄
- `src/api/admin.ts` — export `AdminRole` 供新 router 使用
- `src/db/migrate.ts` — 新增兩個 migration 路徑
- `src/index.ts` — 掛新 router + 啟動時 `hualienAddressDB.rebuildIndex()`
- `admin-panel/src/services/api.ts` — 新增 `landmarkAPI` / `addressFailureAPI`
- `admin-panel/src/layouts/MainLayout.tsx` + `admin-panel/src/App.tsx` — 加入側邊選單與路由

### 部署步驟

```bash
# 1. 跑新 migrations（冪等）
pnpm tsx src/db/migrate.ts landmarks
pnpm tsx src/db/migrate.ts address-failures

# 2. 首次匯入 98 筆地標（冪等，已存在會跳過）
pnpm tsx src/db/seed_landmarks.ts

# 3. Admin Panel 依賴
cd admin-panel && pnpm install && pnpm build

# 4. 重啟 Server
pnpm dev   # 或 pm2 restart
```

### 驗證步驟

**地標管理**：
1. 登入 Admin Panel → 側邊「地標管理」
2. 看到 98 筆現有資料
3. 點「新增地標」→ 在地圖上點一個點（花蓮市範圍內）→ 填名稱、別名 → 儲存
4. 不重啟 Server，用 `curl /api/admin/landmarks?q=新地標名` 驗證索引已包含
5. 編輯同一筆，改座標 → 儲存後看「審計歷史」Drawer 有完整 before/after diff

**失敗佇列**：
1. 用 LINE 或 Asterisk 電話模擬叫車「我要從未收錄的 XYZ 到花蓮火車站」
2. Admin Panel → 側邊「待補齊地標」→ 看到該查詢
3. 同一查詢再做一次 → `hit_count` = 2
4. 點「轉為地標」→ 預填 Modal（已自動帶入 Google 猜測座標）→ 儲存 → 狀態變「已處理」

**App 同步**：
1. Admin Panel 新增「ZZZ 測試館」座標在花蓮
2. App 完全重啟 → `adb logcat -s LandmarkSync` 看到 `同步完成：收到 N 筆`
3. App 語音搜尋「ZZZ 測試館」應直接本地命中，不呼叫 Google
4. App 斷網重啟 → 仍可搜到原有 hardcoded 地標（fallback 正常）

### 注意事項
- **hardcoded 永遠不刪**：App 端保留 `LANDMARKS` 常數作為離線 fallback；同名時 Server 版本 override
- **非 ADMIN 無寫權**：OPERATOR 只能讀，但可以看到失敗佇列並提醒 ADMIN 處理
- **台語別名**：Server 端獨有（Whisper STT 容錯），App 不需要（App 無 Whisper）
- **索引重建成本**：100 筆重建 < 10ms，Admin 高頻修改也不會造成壓力

---

## 📝 歷史修改（2026-03-26）- LINE Messaging API 叫車串接

### 功能
客戶可以透過 LINE Official Account 進行叫車、取消、預約叫車。

### 三種叫車管道
| 管道 | 觸發方式 | source 欄位 |
|------|---------|------------|
| APP | 乘客端 Android App | `APP` |
| 電話 | 3CX Webhook → Whisper → GPT | `PHONE` |
| **LINE** | LINE Webhook → 狀態機 + GPT fallback | `LINE` |

### 新增檔案
| 檔案 | 用途 |
|------|------|
| `src/api/line-webhook.ts` | LINE Webhook 路由（簽名驗證 + 事件分派） |
| `src/services/LineMessageProcessor.ts` | LINE 對話狀態機（叫車/取消/預約流程） |
| `src/services/LineNotifier.ts` | 訂單狀態 Push Message 推播 |
| `src/services/LineFlexTemplates.ts` | Flex Message 模板集 |
| `src/services/ScheduledOrderService.ts` | BullMQ 預約排程（提前5分鐘派單、15分鐘提醒） |
| `src/db/migrations/006-line-integration.sql` | DB Migration（line_users, line_messages, orders 擴展） |
| `scripts/setup-line-richmenu.ts` | Rich Menu 設定腳本 |

### 修改檔案
| 檔案 | 變更 |
|------|------|
| `src/index.ts` | LINE middleware 掛載（在 express.json 之前）、初始化 LINE 服務、對話超時清理 |
| `src/api/orders.ts` | accept/fare 端點加入 LINE Push 通知 |
| `src/services/SmartDispatcherV2.ts` | 無司機時推播 LINE 通知 |
| `src/db/migrate.ts` | 新增 `line-integration` migration |
| `.env` | 新增 `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET` |

### LINE 對話流程
```
叫車：「叫車」→ 傳送位置 → 選目的地 → 確認 → 建單派單
預約：「預約」→ 傳送位置 → 選目的地 → 選日期時間 → 確認 → BullMQ 排程
取消：「取消」→ 顯示活動訂單 → 確認取消
GPT：直接輸入「我在火車站要去太魯閣」→ GPT 解析 → 確認
```

### 推播成本優化
- Reply Message（對話互動）：免費
- Push Message（狀態推播）：只推 ACCEPTED + DONE，每單約 2 則
- 預估 1000 單/月 ≈ 2000 則 Push

### 部署步驟
```bash
# 1. 安裝依賴
pnpm add @line/bot-sdk

# 2. 設定 .env
LINE_CHANNEL_ACCESS_TOKEN=your_token
LINE_CHANNEL_SECRET=your_secret

# 3. 執行 DB Migration
npx ts-node src/db/migrate.ts line-integration

# 4. 設定 Rich Menu（可選）
npx ts-node scripts/setup-line-richmenu.ts

# 5. 在 LINE Developers Console 設定 Webhook URL
# URL: https://your-domain/api/line/webhook

# 6. 重新啟動伺服器
pnpm run build && pm2 restart taxiserver
```

### 注意事項
- LINE Webhook 要求 HTTPS，需確認伺服器有 SSL 證書
- 預約功能依賴 Redis（BullMQ），已確認伺服器 Redis 運行中
- 對話超時清理：30 分鐘未操作自動重置為 IDLE

---

## 📝 歷史修改（2026-03-14）- 修復司機端目的地顯示為「花蓮縣花蓮市」

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
│   ├── fareConfig.json       # 費率設定（巢狀：day / night / springFestival / loveCardSubsidyAmount）
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

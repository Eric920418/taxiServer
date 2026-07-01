# 花蓮計程車司機端 - 後端伺服器

> **HualienTaxiServer** - 桌面自建後端系統
> 版本：v1.7.1-MVP
> 更新日期：2026-07-01

## 📝 最新修改（2026-07-01）- 電話 AI 對話提速 + 結尾自動掛斷（bridge.mjs）

### 目標
把叫車流程縮到 ~35-40 秒、更像真人、降低語音生成/Token/通話成本、提升同時接聽量。純 bridge（box）改動、不動 dialplan/後端。

### 改動（`realtime-bridge/bridge.mjs`，已部署 box + commit）
- **prompt 話術**：① 地址**確認一次就好**（客人回「對」即進下一步、不重複確認）；② **不要每句都用「好」開頭**；③ **目的地確認+付款合併同一句**（「好，目的地花蓮火車站，請問付現還是刷卡？」）；④ 結尾精簡成「已幫您叫車，最近車輛約 N 分鐘抵達，抵達時會再通知您，謝謝。」+ 客人已說謝謝就別長篇、別搶話。
- **新增 `end_call` tool + 結尾自動掛斷**：AI 講完結尾道別後呼叫 `end_call` → bridge 等結尾音播完 → **2.5 秒 grace**（客人在此又開口 `speech_started` → 取消掛斷、繼續對話）→ 關 AudioSocket。dialplan `taxi-ai` 現成處理：`/transfer-target` 空 → `Hangup()`（**不需改 dialplan**）。複用 `flushThenTransfer` 的「等音排空再關 socket」範式。
- 正確性不打折（township 反問、check_address、outOfServiceArea、ROAD_MISMATCH、forbidden、no-drivers、transfer 分支全保留）。
- 部署：`node --check` OK → 經反向隧道換上 `/opt/taxi-ai-bridge/bridge.mjs` + `systemctl restart taxi-ai-bridge`（md5 30c09d0）。**待實撥活測**（計時、確認四點、結尾掛斷、grace 不誤掛）。

## 📝 最新修改（2026-06-30）- 地名匹配「回饋迴路」：司機真實上車點揪出 AI 配錯 → 待辦一鍵轉地標

### 目標（不打地鼠）
前一筆「路名對不上拒收 + 反問鄉鎮」是砍掉一類，但底層仍是「語音×模糊 geocode」、近似錯會穿過去。本次讓系統用 **ground-truth 自己揪出下一個配錯**，進「待補齊地標」待辦、ops 一鍵以正確座標轉地標、`rebuildIndex` 即時生效 → 永久不再錯。

### 設計（v1，純後端 + additive migration，重用現成後台）
核心：**司機按「開始行程」(ON_TRIP) 當下的位置 ≈ 真正上車點**，和 AI 定位的 `pickup_lat/lng` 比距離。
- **migration 033（additive）**：`orders.actual_pickup_lat/lng`、`address_lookup_failures.geocode_mismatch`+`sample_order_id`（皆 NULL/FALSE 預設、不碰既有資料/約束）。
- **`orders.ts` updateOrderStatus**：ON_TRIP 時記司機實際位置到 `actual_pickup_*`；對 PHONE/LINE 單算 haversine，**> 500m（起手門檻）→ 進待辦**（fire-and-forget，無新鮮 GPS/未超門檻安全略過）。
- **`AddressFailureLogger.recordGeocodeMismatch()`**：upsert `address_lookup_failures`，把**司機實際座標（正確答案）**寫進 `google_result`+`final_coords`、`geocode_mismatch=true`。**副效益**：覆蓋掉先前可能被塞的 Google 錯答案，修掉「ops 一鍵反而加錯」的現有地雷。
- **重用現成後台**（零前端改動）：admin「待補齊地標」頁出現該地址、`google_result` 已是正確座標 → 「轉為地標」預填即對 → `rebuildIndex` 熱抽換即時生效。
- 選配 v2：admin-panel 加「⚠️ AI 配錯」badge/篩選；納入 no-show GPS；配錯比率告警。

### 部署
v1 純後端（不需動 box、不需 build admin-panel）：`deploy-no-confirm.sh` + ssh `npx ts-node src/db/migrate.ts geocode-audit`（migration 全 additive）。

## 📝 電話叫車地名匹配：路名對不上就拒收 + 同名路反問鄉鎮（2026-06-30）

### 解決的問題
電話 AI 把客人講的路名配到**錯鄉鎮甚至完全無關的路**。實際 log：`"台昌路" → 花蓮縣玉里鎮民國路一段`（客人要的是吉安「太昌路」，台/太同音被聽錯 → Google 模糊湊出毫不相干的玉里民國路 → 只驗縣界放行 → 成錯單）。前次「先驗證花蓮」只鎖**縣界**，從沒做**界內路名/鄉鎮**校驗。

### 改動（無 DB migration）
- **新 `src/utils/hualienGeo.ts`**：`roadStemMismatch`（結果路名與客人講的零共同字＝對不上）、`extractTownship`、`utteranceHasTownship`、`HUALIEN_TOWNSHIPS`（PhoneCallProcessor / LineMessageProcessor 共用）。
- **`PhoneCallProcessor.geocodeAddress`**：Google 街道結果做路名校驗，對不上 → `lowConfidence/reason=ROAD_MISMATCH`（不快取）；並標 `townshipFromCaller`/`resolvedTownship`。
- **`geocodeWithGeocodingAPI`**：移除「沒鄉鎮就盲補花蓮市」前綴（太昌路在吉安、補花蓮市反而湊錯），改只補「花蓮縣」+ bounds。
- **`verifyPickupAddress`**：`lowConfidence` → 回 `found=false`（AI 當查不到、請客人重講）；浮出 `townshipFromCaller`/`resolvedTownship`/`reason`。
- **`dispatchRealtimeOrder`**：建單前 `lowConfidence` → 拒絕建單回 `addressUnclear`。
- **`realtime-bridge/bridge.mjs`**：prompt + check_address 描述 → 客人沒講鄉鎮時 AI **必須跟客人確認/反問鄉鎮**、念回把鄉鎮唸清楚；ROAD_MISMATCH 不硬湊成別條路。**（bridge 部署在 box，需 sync + 重啟）**
- **`LineMessageProcessor.geocodeAddress`（LINE 文字叫車）**：同步移除盲補花蓮市 + Google/Places 結果路名校驗，對不上回 null（請使用者重講），避免 LINE 端重蹈覆轍。


## 📝 最新修改（2026-06-29）- LINE 聯絡客人 phone-aware + 找不到客人會合地標 + order:offer 帶 waypoints

### 解決的問題
1. **LINE 客人聯絡**：LINE 訂單多半沒留真電話（`passengers.phone` 是 `LINE_<userId>` 佔位、`orders.customer_phone` 為 NULL），司機只能 LINE 推訊息、無法撥號。
2. **找不到客人**：到了現場找不到人時，除了請客人重傳位置，沒有「導向一個雙方都認得的明顯地點會合」的機制。
3. **Android 接單閃退（前日已修）**：WS `order:offer` payload 缺 `waypoints` → Android `gson.fromJson` 反序列化成 null → `.isEmpty()` NPE。

### 改動
- **`POST /api/orders/:orderId/contact-passenger`（phone-aware）**：LINE 分支先驗 `customer_phone` / `passengers.phone` 是否為真台灣手機（`^09\d{8}$`、非 `LINE_` 佔位）→ 有 → 回 `{channel:'TEL', passengerPhone: 遮罩號}` 讓 App 撥號；沒有 → 維持 LINE Bot 推文字訊息。TEL 回應 message 也用 `maskCounterpartPhone` 遮罩值（避免 `RELAY_MASK_ENABLED` 開啟時洩漏真號）。
- **`POST /api/orders/:orderId/request-relocation`（找不到客人）**：body 加 `suggestLandmark`。`HualienAddressDB.findNearestLandmark(lat,lng,800)`（in-memory haversine、排除禁止上車地標）找最近公共地標；`LineNotifier.notifyRequestRelocation` 查 `pickup_lat/lng` 算地標，`LineFlexTemplates.relocateRequestCard` 新增「🚕 建議會合地點」區塊，端點回傳 `meetupLandmark` 給司機端同步顯示。
- **`SmartDispatcherV2` / `OrderDispatcher` 的 `order:offer`**：payload 一律帶 `waypoints`（首發 `[]`、replay `tracking.order.waypoints ?? []`），防 Android null 閃退。
- 無 DB migration（`customer_phone` 欄位已存在；地標索引在記憶體）。

## 📝 最新修改（2026-06-28）- 電話 AI：不亂猜地址（先驗證花蓮）+ 查不到/台語不清/問兩次轉真人

### 解決的問題
電話 AI 會**硬把地址猜成花蓮**：prompt 寫死「所有地點當花蓮、不准反問別縣市」→ 客人講「鳳山區」被改口成「花蓮鳳山區」確認 → Google 硬湊一個花蓮座標（通過邊界檢查）→ **建出座標錯誤的單**（`outOfServiceArea` 只擋解析到界外、擋不了被 AI 改寫後湊進界內）。

### 改動
- **`bridge.mjs` prompt**：花蓮行政區只有市/鄉/鎮、**沒有「區」**→ 任何「○○區」（鳳山區/三民區…）一定非花蓮、**不准改口硬確認**；上車點**確認前一定先呼叫 `check_address` 驗證**，只用回傳的 `normalizedAddress` 跟客人確認；驗不過/問兩次/台語聽不懂 → `transfer_to_human`。
- **新工具 `check_address`**（bridge）→ 後端 **`POST /api/phone-calls/verify-address`**（複用 `PhoneCallProcessor.verifyPickupAddress`→`geocodeAddress`，**只驗證不建單**，回 `found/inHualien/normalizedAddress/outOfServiceArea/forbiddenPickup`）。
- **新工具 `transfer_to_human` + 轉接（零 AMI）**：bridge 記 `transferByUuid=SERVICE_PHONE`、等 AI 講完轉接語（`response.done`）才關 socket；bridge `/transfer-target?uuid=` HTTP；dialplan `taxi-ai` 在 `AudioSocket()` 後 `CURL` → 有號 `Goto(fet-outbound,${XFER},1)`（複用 relay-in pattern）否則 Hangup。`SERVICE_PHONE` env = 客服市話/手機（**留空→AI 改說「請稍後再撥」不會卡死**）。

### 新時尚→太昌（查證）
叫「建國路新時尚」命中地標 290（別名「新時尚」）= `吉安鄉太昌村建國路二段289號`、座標 23.99322/121.57374，**派車定位正確**（太昌寫在 address+別名；地標表無獨立「里」欄位，對派車無影響）。

## 📝 最新修改（2026-06-28）- 電話 AI 語音「沙沙底噪」修復（bridge 輸出 pacing）

電話 AI 客服 AI 聲音持續沙沙底噪。根因＝`realtime-bridge/bridge.mjs` 輸出 frame 切割：`enqueueAudio` 把**每個** OpenAI `response.output_audio.delta` 各自切 320B → 每個 delta 尾端留 <320B 短幀；`flushOut` 每 20ms 送一個「可變長度」chunk → 送出的 frame 時長忽長忽短 → Asterisk 播放時脈抖動 → **近乎連續的沙沙底噪**。（**非取樣率問題**：input/output 都 `audio/pcmu`＝μ-law **8kHz**、端到端一致、無 resample；`muDecode`/`linToMu` 也是標準正確的 G.711。）

修法：`outQ`（per-delta chunk 陣列）→ 單一連續 `outBuf` Buffer；`enqueueAudio` 直接累加、`flushOut` 每 tick 取**剛好 320B**（尾段不足補 slin 靜音湊滿 20ms），frame 邊界永遠對齊。barge-in 改 reset `outBuf`。已部署 box `/opt/taxi-ai-bridge/bridge.mjs`、restart `taxi-ai-bridge`（重啟乾淨、:9092/:9091 正常）。Phase 2（若仍有電話級底噪）：輸出改 `audio/pcm` 24kHz + 乾淨 24k→8k 降取樣消除 μ-law companding，待實聽結果再評估。

## 📝 最新修改（2026-06-27）- FCM 新訂單改 data-only（配合 App v1.6.5 全螢幕接單）

`FcmService.sendNewOrderToDriver` 去掉 `notification` field（含 `android.notification`）→ **data-only**（保留 `android.priority='high'`）。讓 App `onMessageReceived` 在**背景/被殺都會跑**，由 App 自己 post 高優先「全螢幕接單」通知（v1.6.5 `IncomingOrderActivity`）。含 notification field 時，背景由系統渲染、`onMessageReceived` 不跑 → 全螢幕碼觸發不到、且會「全螢幕＋系統 heads-up」雙通知。舊版 App（≤1.6.4）的 `onMessageReceived` 仍會把 data 渲染成 heads-up，**向下相容不漏單**。注意：force-stop / 兇 ROM 不喚醒進程時 data-only 可能收不到 → 請司機關閉省電限制。

## 📝 最新修改（2026-06-27）- 背景接單修復：reconnect replay 不再排除 timed-out 司機

### 解決的問題
司機 App 切背景被 Doze 殺 socket → 訂單派來時收不到 WS `order:offer`（只剩 FCM 通知鈴聲）→ 15-20s 批次 timeout 把他標記 timed-out → 開回 App 重連時，`SmartDispatcherV2.replayActiveOffersForDriver` 因 `allTimedOutDriverIds` 過濾把他擋掉 → **只剩主畫面、沒卡片可接**。這把「最該被救的人」擋掉，剛好打死它自己要解的場景。

### 改動（`src/services/SmartDispatcherV2.ts`，純後端一行邏輯）
- `replayActiveOffersForDriver` 移除 `if (state.allTimedOutDriverIds.has(driverId)) continue;`。只要訂單仍 `DISPATCHING`、司機沒明確 reject、未被接走，重連（`driver:online`）就 replay `order:offer`，讓他 first-come 搶仍未被接走的單。
- 安全性：`handleDriverAccept` 只看 `status==DISPATCHING`，不擋 timed-out 司機；`perDriverOffers` 永不刪除（payload 仍在）；多人搶同單由 first-come 收斂。
- App 端 `order:offer → 跳卡片` 流程不變、不檢查 `responseDeadline`，故純後端即生效，**現役 App 不需發版**。

### 仍存在的先天限制
offer 視窗短（~15-30s）；若整張訂單已過 order-level timeout/被取消（不再 DISPATCHING），沒有東西可 replay。背景常連的根治（前景服務維持 WS / FCM data message 預載）為後續工作項目。

## 📝 最新修改（2026-06-26）- 司機「完成訂單後自動排班」開關 + 休息/離線退出排班守門

### Context
司機完成訂單後原本要手動再排班。新增 `drivers.auto_queue_after_trip` 開關：ON 時每趟完成依當下 GPS（`QueueZoneResolver.resolveZone`）自動排入所在排班區；OFF 維持自由。排班區只在「完成訂單／手動排班」判斷一次，不隨 GPS 換區。

### 改動範圍（server）
- **Migration `032-driver-auto-queue.sql`**：`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS auto_queue_after_trip BOOLEAN NOT NULL DEFAULT false`（冪等、metadata-only）。
- **`src/api/orders.ts`**：抽 `maybeAutoRequeueAfterTrip(driverId)`（開關 OFF→no-op、不動既有 entry；ON→同區保留／跨區 LEFT+INSERT／不在任何區 LEFT）。掛到 `handleSubmitFare`（App 正常完成路徑，原本沒跑 auto-requeue）與 `PATCH /:orderId/status` DONE，取代原本無開關的 inline 區塊。
- **`src/api/drivers.ts`**：`PATCH /:id/status` 切 OFFLINE/REST → `LEFT` 掉 ACTIVE 排班（`left_reason=DRIVER_<state>`）；`GET /:id` 回 `autoQueueAfterTrip`；新增 `PATCH /:id/auto-queue { enabled }`。

### 不改的東西
`QueueFraudChecker`（每 60s 漂移踢出）維持「只退出、不換區」；後端無任何定期依 GPS 重評/更換排班區的邏輯，符合「排班區穩定」需求。

## 📝 最新修改（2026-05-16）- LINE 叫車三項：訊息正名 + 預估金額 + 接單 ETA

### 解決的問題
LINE 叫車路徑在「使用者體驗」與「司機接單後資訊」兩端各有缺口：
1. **「叫車成功！」訊息誤導**：使用者看到「叫車成功」會以為已媒合，實際才剛建單在等司機。
2. **司機接單後 LINE 沒 ETA**：`orders.ts` 推給 `notifyDriverAccepted` 的 `etaMinutes` 來自 DB 不存在欄位 `eta_to_pickup`，永遠 null，導致 `driverAcceptedCard` 走 fallback「司機正在前往您的上車點」。
3. **司機端看不到預估金額**：`line-liff.ts` 建單完全沒寫入 `estimated_fare`，司機 App `Order.estimatedFare` 為 null，HomeScreen 預估金額區塊不渲染。APP / 電話叫車路徑原本就有算，只有 LINE 路徑漏掉。

### 改動範圍（server 三檔，以 1893bf6 為 base）
- **`src/services/LineFlexTemplates.ts`**：`orderCreatedCard()` 標題 `'叫車成功！'` → `'正在媒合司機'`（綠色 #4CAF50），刪除重複副標題；altText 同步改。`driverAcceptedCard()` altText 把 ETA 放最前面（`🚕 司機約 X 分鐘到達｜車牌（姓名）`），確保手機鎖屏推播 / LINE 聊天列表預覽即使被截斷也看得到。
- **`src/api/line-liff.ts`**：建單前用 `ETAService.getETA(pickup, dest)` 取得 Google Directions 道路距離，再呼叫 `fareConfigService.calculateFare()` 算花蓮費率，寫入 `orders.estimated_fare`，並傳入 SmartDispatcherV2 的 `orderData.estimatedFare`。
- **`src/api/orders.ts`** (/accept)：司機接單時即時呼叫 `ETAService.getETA(司機位置, 上車點)` 算 ETA，傳給 `cns.notifyDriverAccepted({ etaMinutes })`。司機位置優先讀 `driverLocations` 記憶體 Map，fallback 讀 `drivers.current_lat/lng`。

### 司機端 Android App
**零修改**。`Order.estimatedFare`、`HomeScreen.kt:644` 預估金額渲染、`driverAcceptedCard()` 的 ETA 條件式均已就緒，server 補資料即生效。

### 已知邊界
LINE 預約叫車（mode=reserve）：不算 estimatedFare（時間未到，路況未知）。

### Regression 防範
這個 commit 在 revert 過時 commit `1b24b96` 後，以 `1893bf6` 為 base 重做。1b24b96 雖然有上述三項真改動，但同 commit 內 6 個過時副本檔（queue.ts/Drivers.tsx/booking.html/migrations 020-021）會 break commission→discount schema rename 後的 production，所以 revert 後重做 clean version。

## 📝 最新修改（2026-05-09）- GoGoCha 跨車隊媒合平台 Phase 1：Partner 抽象 + 對帳基礎建設

### 解決的問題
業主把方向拉到「跨車隊媒合平台」，需要：
1. 多種合作對象（車隊 / 品牌 / 招募人）統一管理
2. 一個司機可同時屬多個 partner（例：原車隊 + 透過某招募人加入 + 某品牌營運）
3. 彈性分潤規則（每個 partner 各自設 FIXED_PER_ORDER 或 PERCENTAGE）
4. 每筆訂單寫永久 BillingSnapshot，月底對帳精準（Σ司機單 == 車隊總單）
5. 派單**完全不受 partner 限制**（跨車隊媒合）

Phase 1 範圍：DB schema + 後端 CRUD + admin UI（Partners 頁 + 分潤規則頁）+ 訂單 DONE 自動寫 snapshot。

**核心設計：3 層抽象**
- **Layer 0 派遣**：既有 SmartDispatcherV2 不動
- **Layer 1 Queue 排班優先層**：P3 才做
- **Layer 2 Partner 結算層**：本次 P1 重點，**完全跨層、不影響派遣**

### Migration 019 — 7 張新表 + drivers/orders 加欄位

```
partners                    車隊/品牌/招募人（type 區分）
driver_partners             N:N，每 relationship_type (PRIMARY_FLEET/BRAND/RECRUITED_BY) 每司機 1 筆
commission_rules            分潤規則（FIXED_PER_ORDER / PERCENTAGE）
queue_zones                 排班區（圓形：center + radius）— P2 才用
queue_entries               排班記錄 — P2 才用
billing_snapshots           訂單完成永久寫一筆
billing_distributions       一張單拆給多 partner（PLATFORM 拿剩餘）
```

加欄位：
- `drivers.max_acceptable_commission_pct` — 司機接受抽成上限（P3 用）
- `orders.commission_pct` / `dispatch_type` / `dispatched_from_zone`

### 後端新增

| 檔案 | 功能 |
|------|------|
| `src/services/BillingService.ts` | `writeSnapshotForOrder(orderId)`：訂單 DONE 自動寫 snapshot + 拆 distribution |
| `src/api/admin-partners.ts` | Partner CRUD (GET 含 type 過濾 / POST / PUT / DELETE 軟刪) |
| `src/api/admin-driver-partners.ts` | 司機綁定 partner（PUT 整批設 PRIMARY_FLEET/BRAND/RECRUITED_BY） |
| `src/api/admin-commission-rules.ts` | 分潤規則 CRUD |
| `src/api/orders.ts` | PATCH /status DONE + submitFare 都呼叫 BillingService |
| `src/db/migrations/019-queue-and-billing.sql` | Schema |
| `src/db/migrate.ts` | 註冊 019 |
| `src/index.ts` | 註冊 3 個新 router |

### Admin Panel 新增

| 檔案 | 功能 |
|------|------|
| `admin-panel/src/pages/Partners.tsx` | 三 tab (車隊 / 品牌 / 招募人) CRUD |
| `admin-panel/src/pages/CommissionRules.tsx` | 分潤規則 CRUD（含時段生效 from/to） |
| `admin-panel/src/services/api.ts` | partnerAPI / commissionRuleAPI / driverPartnersAPI |
| `admin-panel/src/App.tsx` | 加路由 |
| `admin-panel/src/layouts/MainLayout.tsx` | 菜單加「合作對象」「分潤規則」 |

### 部署步驟
```bash
cd /var/www/taxiServer
git pull && pnpm install && pnpm build
pnpm migrate queue-billing
pm2 restart taxiserver

cd admin-panel && pnpm build
```

### 驗證（Phase 1 結束時）
1. SQL `\d partners` 等 7 張表存在
2. admin 後台「合作對象」頁建立 Partner 「大豐」(FLEET)
3. 「分潤規則」頁建立規則：partner=大豐, type=PERCENTAGE, amount=5
4. SQL 直接 INSERT driver_partners 綁司機 D001 PRIMARY_FLEET=大豐
5. 跑一筆訂單 DONE，車資 200
6. SQL 抽檢：
   - `billing_snapshots` 1 筆 (driver_id=D001, fare=200, commission_pct=0)
   - `billing_distributions` 至少 2 筆：FLEET amount=10、PLATFORM amount=-10（負數警示）
   - **(P1 commission_pct 都先設 0，但拆分結構已就位；P3/P4 commission 才會寫實值)**

### 設計決策
- **Partner 三類型同一抽象**：避免未來加新類型還要 migrate
- **driver_partners N:N + relationship_type**：每角色 1 partner（PRIMARY_FLEET 1 個 / BRAND 1 個 / RECRUITED_BY 1 個）
- **billing_snapshots ↔ distributions 1:N**：永久保留分潤歷史；rule 改了不影響舊單
- **commission_pct 在 orders 而非 snapshot**：派單時就決定，便於 query
- **Layer 2 結算對 Layer 0 派遣無影響**：snapshot 寫失敗只 log，不卡訂單完成

### 下個 Phase（已規劃）
- **P2** (5-6 天)：Queue Zone admin 頁 + 司機 App 排班 UI
- **P3** (4-5 天)：QueuePriorityLayer 整合派單 + 防作弊 cron
- **P4** (8-10 天)：訂單 commission_pct 動態設定 + 完整 Billing 報表頁
- **P5** (5+ 天)：邊角優化（多邊形 zone、自動跳排、PDF 匯出）

### 已知遺留（P2 補）
- Drivers.tsx 編輯頁加 partner 綁定 UI（目前 admin 需透過 SQL 或直接 API 綁）
- 司機 commission 接受度設定 UI
- LINE/App 客人 commission tier 選擇

---

## 📝 歷史修改（2026-05-08）- 派單系統三大 feature：排班 / 距離 bucket / 1+1 疊單

### 解決的問題
SmartDispatcherV2 之前是「Top-N 評分批次派單」，三個結構性洞：
1. 排班 schema (drivers.shifts) 進了 14 個月，但 dispatcher 從未檢查 → 司機不在班也照接
2. 派單分批選的是「綜合分數高」不是「先近後遠」→ 偏遠地區可能近司機被擠掉
3. 司機接單後直到下車才會被派下一單 → 浪費「快到目的地的 5 分鐘交接窗口」

### F1: 排班過濾（drivers.shifts → dispatcher）
新增 `src/services/ShiftChecker.ts` 提供 `isOnShift(now, shifts)` helper：
- shifts 為空 → return true（24/7 在班，向後相容）
- 跨日班次（end < start，例 22:00-06:00）自動拆兩段比對
- 時區用 Asia/Taipei 比對 HH:MM
- `minutesUntilShiftEnd()` 給 App 顯示「離下班還剩 X 分」用

`SmartDispatcherV2.getAvailableDrivers` SELECT 加 `d.shifts`，後端 filter 移除不在班司機（log 印「排班過濾 X/Y 位在班」）。Admin Panel ShiftSelector 早已存在（4 種班次：早/中/晚/夜，每種可勾選 + 設時段），這次只是讓那些設定**真正生效**。

### F2: 距離 bucket（半徑遞增派單）
CONFIG 加 `BATCH_RADIUS_KM: [2, 3, 5, 8, 15]`，每批派單最大半徑遞增（**累進式**：batch 1 ≤2km，batch 2 ≤3km, ..., batch 5 ≤15km）。
- 累進不分段：近的司機沒接 batch 1，batch 2 還會出現在候選
- 偏遠訂單前幾批可能 0 候選沒關係，第 4-5 批自動納入更遠司機
- bucket 內仍按既有評分排序

`selectBestDrivers` 加 `maxRadiusKm` 參數，`executeBatch` 依 batchNumber 取對應半徑。

### F3: 1+1 疊單（ON_TRIP 接下一單）

**Migration 018**：orders 表加 `queued_after_order_id`、`assignment_mode`（部分索引只索引 queued 訂單）。

**Dispatcher 改 `getAvailableDrivers`**：
- 候選範圍從 `availability IN ('AVAILABLE','REST')` 擴大到 `('AVAILABLE','REST','ON_TRIP')`
- ON_TRIP 司機加額外過濾：「目前位置到當前訂單目的地直線距離 ≤ 2km」（≈ 4 分鐘車程，用 Haversine 不打 Google API 控成本）
- SQL 多 SELECT 三欄：current_dest_lat / current_dest_lng / current_order_id（跑 ON_TRIP 司機的當前訂單反查）

**接單路徑分支** (`PATCH /:orderId/accept`)：
- 偵測司機 availability=ON_TRIP → **疊單模式**：UPDATE 設 `driver_id`、`queued_after_order_id`、`assignment_mode='STACKED_1P1'`，**status 維持 OFFERED**（避免被其他司機搶 + 行程結束才晉升）
- 一般司機 → 既有 ACCEPTED 邏輯不變

**前單完成自動晉升** (`PATCH /:orderId/status` status='DONE')：
1. 找 `queued_after_order_id == 該訂單` 的 OFFERED 訂單
2. 有 → UPDATE status='ACCEPTED', queued_after_order_id=NULL, assignment_mode='SINGLE'
3. emit `order:status` ACCEPTED 給司機（App 自動 refresh）
4. LINE notifyOrderStatusChange 推 ACCEPTED 給疊單客人

### 影響檔案
- `src/services/ShiftChecker.ts` — **新增**
- `src/services/SmartDispatcherV2.ts` — getAvailableDrivers shift filter + ON_TRIP 候選 + 距離過濾；CONFIG 加 BATCH_RADIUS_KM；selectBestDrivers 加 maxRadiusKm；executeBatch 用 bucket
- `src/api/orders.ts` — PATCH /accept 分疊單／一般兩路；PATCH /status DONE 自動晉升 + 推 socket + LINE
- `src/db/migrations/018-stacked-orders.sql` — **新增**
- `src/db/migrate.ts` — 註冊 018

### 部署步驟
```bash
cd /var/www/taxiServer
git pull && pnpm install && pnpm build
pnpm migrate stacked-orders
pm2 restart taxiserver
```

**不需要 APK 更新** — 三項都是後端行為，司機端透過既有 socket 機制即時接收。

### 驗證
1. **F1 排班**：admin 設司機 D001「中班 14:00-22:00」→ 早上 10:00 派單 → log 應印「排班過濾: N/N+1 位在班」(D001 被剔除)
2. **F2 bucket**：log 印 `[SmartDispatcherV2] 執行第 1 批派單（半徑 2 km）` → batch 2 印 3km、batch 3 印 5km
3. **F3 疊單**：D001 在跑 ORDER_A 距 dest 1.5km → 派 ORDER_B → log 應印「1+1 疊單接單」 → ORDER_A 完成 → log 印「自動晉升」+ D001 收到 ACCEPTED
4. SQL 抽檢：`SELECT order_id, status, queued_after_order_id, assignment_mode FROM orders WHERE assignment_mode = 'STACKED_1P1'`

### 已知遺留（下個 commit 補）
- 司機 App HomeScreen 加「上班中／不在班次」banner — 目前司機只透過「沒有訂單派來」感知不在班
- 司機 App SimplifiedDriverScreen 加「下一單」UI — 目前疊單晉升靠 socket 自動 refresh 訂單卡，沒有「排隊中」視覺提示

### 設計決策
- **shifts 為空 = 24/7 在班**：保持向後相容
- **bucket 累進不分段**：邏輯簡單、不會「漏人」
- **ON_TRIP 直線距離 < 2km 才能被疊單派**：避免太早派客人等太久；2km 用 Haversine ≈ 4 分鐘車程，跟 spec「< 5 分鐘」一致
- **不打 Google API 算 ETA-to-destination**：每筆派單對 N 個 ON_TRIP 司機 × 5 批 = 成本爆炸；Haversine 「夠好」proxy
- **疊單 status 維持 OFFERED**：避免被其他司機搶；前單 DONE 才晉升 ACCEPTED

---

## 📝 歷史修改（2026-05-05 #2）- 司機請客人重發位置（LINE push + LIFF 改訂單頁 + 補手機）

### 解決的問題
司機接到 LINE 訂單後，常遇到客人傳的上車點座標不準（geocode 不準、客人手 slip 點錯）。
之前司機沒有合規解決方法 — 撥電話有隱私問題、且 LINE 客人多半未留手機。
另外現在 LINE 訂單沒留手機，no-show 時司機完全沒法聯繫。

### 設計：閉環流程
```
司機按「請客人重發位置」按鈕
   → 後端 POST /api/orders/:id/request-relocation
   → LineNotifier.notifyRequestRelocation 推 Flex card 給客人
   → 客人按 Flex 卡上的 LIFF deep link
   → booking.html 偵測 mode=relocate redirect 到 relocate.html
   → 客人看地圖（中心 = 目前 pickup）拖曳 marker / 搜尋新位置
   → 順便選填手機（passengers.phone 仍是 LINE_xxx 才顯示）
   → PATCH /api/line/liff/relocate-order/:id
   → UPDATE orders.pickup_lat/lng/address
   → 若手機合法且原本是 placeholder：覆蓋 passengers.phone + orders.customer_phone
   → Socket emit `order:pickup_updated` → 司機 App
   → 司機端訂單卡上車點即時更新 + 語音 + Toast
```

### 影響檔案

**Backend (server)**：
- `src/services/LineFlexTemplates.ts` — 新增 `relocateRequestCard()`（黃底警示 + LIFF deep link）
- `src/services/LineNotifier.ts` — 新增 `notifyRequestRelocation()` 方法
- `src/api/orders.ts` — 新增 `POST /:orderId/request-relocation`，驗 driver_id + source='LINE' + status ACCEPTED/ARRIVED
- `src/api/line-liff.ts` — 新增 `PATCH /relocate-order/:orderId`，驗 line_user_id + bounds + 寫 DB + emit socket

**LIFF (frontend)**：
- `public/liff/booking.html` — 加 5 行 redirect script：mode=relocate 立即跳到 relocate.html
- `public/liff/relocate.html` — **新增**：地圖 + marker + 自動定位（getCurrentPosition）+ 選填手機 + 確認按鈕

**Android driver app**：
- `data/remote/dto/NoShowRequests.kt` — 加 `RequestRelocationRequest`
- `data/remote/ApiService.kt` — 加 `requestRelocation()` retrofit 方法
- `data/repository/OrderRepository.kt` — wrapper
- `data/remote/WebSocketManager.kt` — 加 `pickupUpdated` StateFlow + `order:pickup_updated` listener + cleanup
- `viewmodel/HomeViewModel.kt` — 訂閱 pickupUpdated 自動 in-place 更新 currentOrder.pickup + 語音提示；新增 `requestRelocation()`
- `ui/screens/SimplifiedDriverScreen.kt` — SmartActionButton 上方加紅圈按鈕（只 source=="LINE" + NavigatingToPickup/ArrivedAtPickup state 顯示）

### 為什麼選 LIFF 而非 Web URL
- LIFF 自動取 LINE userId → 後端可比對訂單 line_user_id 防別人代改
- 不需要客人額外登入 / 留 token
- 在 LINE 內 WebView 開啟，UX 像 native

### 為什麼 booking.html JS-redirect 而非 if-branch 重用
- booking.html 已經 427 行，加 mode=relocate 分支會大量 if-else 弄髒原 booking flow
- relocate UI 跟 booking 差異大：沒目的地、沒付款、沒備註、submit 不同 endpoint
- 同 origin redirect LIFF SDK auth state 保留，relocate.html 可獨立 init liff
- 保持單一 LIFF ID 註冊不需動 LINE Developers Console

### 部署步驟
```bash
# server
cd /var/www/taxiServer
git pull && pnpm install && pnpm build && pm2 restart taxiserver

# Android
cd ~/AndroidStudioProjects/HualienTaxiDriver
./gradlew publishReleaseBundle    # 推 Play Console alpha
```

### 驗證
1. LINE 客人下單，司機 App 接單 → 訂單卡 SmartActionButton 上方應出現「請客人重發上車位置」按鈕（紅圈 OutlinedButton）
2. 司機按按鈕 → Toast「已通知客人重發位置」+ 客人 LINE 收到黃色 Flex 卡
3. 客人按「📍 重新選擇位置」 → LIFF 開啟 relocate.html，地圖中心 = 訂單目前 pickup
4. 拖曳 marker 或搜尋新地址 → 點「✓ 確認新位置」（順便填手機）→ Toast「位置已更新」+ LIFF 自動關閉
5. 司機 App 訂單卡上車點地址自動換成新位置 + 語音「客人已更新上車位置」
6. DB 抽檢：`orders.pickup_lat/lng/address` 已更新；若有填手機 → `passengers.phone` 與 `orders.customer_phone` 同步寫入

### 設計決策
- **手機選填欄位顯示策略**：暫時無條件顯示（沒精準的 GET /me 端點判斷）。後端寫入時用 SQL `WHERE phone LIKE 'LINE\\_%'` 擋掉，已有真實號碼不會被覆蓋。後續可加 endpoint 精準控制 visibility。
- **status 限制 ACCEPTED/ARRIVED**：尚未接單（OFFERED）司機本來就不該主動聯繫；ON_TRIP 已上車不需要重發位置。
- **不做 cooldown**：實務上司機不會 spam，過度工程化。
- **LIFF deep link 用 LIFF_ID_BOOKING**：複用現有 LIFF endpoint 註冊，不額外申請新 ID。

---

## 📝 歷史修改（2026-05-05）- LINE 對話加付款方式選擇 + showConfirmCard 改 orchestrator

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

## ☎️ 電話叫車 / FET SIP Trunk + Asterisk（含即時 AI 語音客服）

電話進線叫車與 App / LINE 叫車**共用同一條派單管線**（`source='PHONE'`）。辦公室自架 Asterisk（box `asterisk-pbx`）接遠傳 FET SIP Trunk，**兩條路徑、同一個後端派單核心**：

- **即時 AI 語音客服（主）**：來電 → `taxi-ai` → `AudioSocket` → `bridge.mjs`(box) ↔ OpenAI Realtime → AI 對話問上車/目的地、聽不清反問、覆述確認 → function call → 後端 `POST /api/phone-calls/realtime-order` → `dispatchRealtimeOrder()` 複用 geocode+建單+派單 → AI 口頭「已幫您叫車，找到司機會再通知您」。
- **MVP 掛斷分析建單（fallback）**：來電 → `taxi-intake` → 播歡迎語 + 錄客人音軌 → 掛斷觸發 `fire-webhook.sh` → 後端 `PhoneCallProcessor`（Whisper → GPT → 花蓮地址 geocoding → `SmartDispatcherV2` 派單）。

### 進線路由與並發 fallback（`extensions_fet.conf`）

```
from-fet → taxi-route：
  GROUP_COUNT(aicall) < 3 ? → taxi-ai（即時 AI，佔一個 aicall 名額）
                          : → taxi-intake（MVP 錄音分析）
```

- 並發閘門在 **dialplan**（`GROUP_COUNT(aicall) < 3`），`bridge.mjs` 另有 `MAX_CALLS=3` 第二層保險（兩者一致）。AI 滿 3 通時第 4 通乾淨退回 MVP 錄音。
- ⚠️ **已知邊際**：閘門擋「AI 滿載」，擋不了「bridge 程序整個掛掉」。bridge down 時被路由到 `taxi-ai` 的來電會走到 `AudioSocket` 連不上而 `Hangup`（客人聽到靜音被掛斷），目前靠 systemd `Restart=always`（5s）緩解。後續可加：用 `/call-start` HTTP 狀態 gate，bridge 無回應就改走 `taxi-intake`（須實撥驗證，失敗模式是 AI 電話誤降級成 MVP，故跟端到端活測一起上）。
- ⚠️ **AI 不報車號**：`dispatchRealtimeOrder()` 是 fire-and-forget，當下還沒司機接單，AI 只說「已幫您叫車」。車號/ETA 在司機接單後由 `CustomerNotificationService` 走 LINE/SMS 通知（市話客人收不到簡訊，是 Phase 3 語音回撥的潛在需求，目前暫緩）。

### 接線真相表（實測值，非規劃書文件值）

| 項目 | 值 |
|------|-----|
| 本端 SIP IP / transport | **`210.243.167.38`**、port **5060/UDP**（非文件的 .33/TCP）|
| FET SBC 訊令 / 語音(RTP) | `123.51.252.5` / `123.51.252.4` |
| 認證 | **IP 認證**（無帳密，來源 IP `123.51.252.5` 比對）|
| 10 門 DID | `038907320 ~ 038907329`（9 碼無連字號；對外宣傳 `03-8907320`）|
| 上行頻寬 | **3M**（即時 AI 並發上限關鍵，`MAX_CALLS=3`）|

**出局送碼**（`fet-outbound`）：主叫一律 `038907320`；手機 `9004`+`09xxxxxxxx`（有加購 MVNO）；市話/長途原樣 `0+AC+SN`；國際 `007+...`。

### box(asterisk-pbx) 部署拓樸

- box：Ubuntu、Asterisk 22.5.2、使用者 `pbxdaihon`。無公網 SSH，靠**反向 SSH 隧道**進維運：
  `ssh -i <Lightsail.pem> ubuntu@15.164.245.47 'ssh -p 2222 -i ~/.ssh/box_key pbxdaihon@localhost ...'`
- systemd（皆 `enabled`，開機自起）：`taxi-ai-bridge`、`box-tunnel`(SSH 反隧道 :2222)、`box-tunnel-http`(錄音 8090 反隧道)、`nginx`、`asterisk`。
- 即時 AI 對話用 **G.711 μ-law 8kHz**（AudioSocket slin↔ulaw 查表、免重採樣、3M 上行可撐多通）。

### 版控的設定檔（box 為真相來源，repo 存逐字快照）

| repo 檔 | 部署到 box | 作用 |
|------|--------|------|
| `deploy/asterisk/pjsip_fet.conf` | `/etc/asterisk/`（`#include`）| FET trunk（.38/UDP、IP 認證）|
| `deploy/asterisk/extensions_fet.conf` | `/etc/asterisk/`（`#include`）| `from-fet`→`taxi-route` 並發閘門→`taxi-ai`/`taxi-intake` + `fet-outbound` |
| `deploy/asterisk/fire-webhook.sh` | `/etc/asterisk/scripts/`（`chmod +x`）| 掛斷後 POST webhook（JSON）|
| `deploy/asterisk/recordings-http.conf` | `/etc/nginx/sites-available/recordings` | 錄音唯讀 HTTP（`127.0.0.1:8090`，經反隧道供後端 fetch）|
| `deploy/asterisk/box-tunnel*.service` | `/etc/systemd/system/` | 兩條反向 SSH 隧道 |
| `realtime-bridge/bridge.mjs` | `/opt/taxi-ai-bridge/` | AudioSocket ↔ OpenAI Realtime bridge |
| `realtime-bridge/taxi-ai-bridge.service` | `/etc/systemd/system/` | bridge systemd（`Restart=always`）|
| `realtime-bridge/.env.example` | → box `/opt/taxi-ai-bridge/.env`（去敏，勿進版控）| `OPENAI_API_KEY`、`BRIDGE_SECRET`、`MAX_CALLS` |

### 後端端點

- `POST /api/phone-calls/webhook`（`src/api/phone-calls.ts`）— MVP 掛斷分析進入點。
- `POST /api/phone-calls/realtime-order`（同檔）— 即時 AI 建單進入點，`X-Bridge-Secret` 驗證；呼叫 `PhoneCallProcessor.dispatchRealtimeOrder()`，回 `{ok, orderId?, scheduled?, noDrivers?, etaMinutes?, forbiddenPickup?, error?}`。
- `GET /api/relay/lookup?from=&did=&key=`（`src/api/relay.ts`）— 號碼遮蔽中繼查表，box dialplan `relay-in` 用，回純文字撥號（見下）。

### v2 強化（AI 對話 + 派車邏輯，migration `030-ai-dispatch-v2.sql`）

電話叫車 v2 在「即時 AI」這條路加上：

- **付款（現金/刷卡）**：AI 問「現金還是刷卡」→ `payment_type=cash/credit_card`。刷卡 → `SmartDispatcherV2.getAvailableDrivers()` 只派 `drivers.can_credit_card=TRUE` 的車（`orders.payment_type` 加 `CREDIT_CARD`）。`can_credit_card` 預設 TRUE，ops 把純收現的車設 FALSE。
- **醫院/無障礙**：AI 視情況問「需要輪椅車嗎」→ `needs_wheelchair` → 只派 `drivers.can_wheelchair=TRUE`；其他需求進 `orders.special_notes`。`can_wheelchair` 預設 FALSE，ops 標出無障礙車。
- **派單前查車 + ETA / 沒車**：建單前先 `SmartDispatcherV2.checkAvailability(pickup, filters)`（heartbeat 5 分內 AVAILABLE + 能力篩選 + Haversine 最近 + `ETAService`）。有車→回 `etaMinutes`，AI 報「大約 X 分鐘」；沒車→回 `noDrivers`，AI 請客人稍後再撥、**不建單**。
- **預約/火車接送**：AI 提醒「火車接送至少提前 1 小時」、問時間→ `scheduled_at`(ISO)。建 `status='SCHEDULED'` 單，交給既有 `ScheduledOrderService`（BullMQ：提前 5 分派單、15 分提醒）。`dispatchScheduledOrder` 已補帶 `needs_wheelchair/subsidy/source`。
- **號碼遮蔽中繼**：司機↔客人互打經系統遮蔽。設計＝單一中繼號 `038907329` + caller-ID 查表橋接：
  - box `[relay-in]`：中繼號進線 → `${CURL(/api/relay/lookup?from=${CALLERID(num)}&key=...)}` → 後端依來電真號找 active order 的對方真號 → `Goto(fet-outbound,${TARGET},1)` 橋接（代表號 `038907320` 當主叫，雙方看不到對方真號）。`relay.key` 放 box `/etc/asterisk/relay.key`（不進 repo）。
  - **遮蔽放 API DTO 邊界**（`maskCounterpartPhone()`）：開 `RELAY_MASK_ENABLED=true` 後，面向 App 的 `customerPhone`/`driverPhone`/`passengerPhone` 欄位回中繼號，**現有 App 不改也會撥中繼號**（免發版）。真號只遮 client、server 內部（簡訊/派單）仍用真號。
  - **`RELAY_MASK_ENABLED` 預設關**：程式碼先上線無影響；活測驗證中繼能橋接後再翻開，避免「遮蔽開了但中繼沒驗證→互打不通」。

### v2.1 司機補行程資料（migration `031-driver-order-edits.sql`）

電話 AI 單**只要有上車點就先建單**（目的地選填，客人「上車後再說」不卡住）；司機載到客人後在 App 補資料，保留 AI 原值 vs 司機補值的修改紀錄。

- **電話端**：`bridge.mjs` 的 `create_taxi_order` 目的地改選填（拿出 `required`），客人不知道目的地就只用上車點建單。`dispatchRealtimeOrder`/`createPhoneOrder` 已能吃 null dest，AI 原文寫進 `dropoff_original`、`destination_confirmed=FALSE`。
- **司機改單**：`PATCH /api/orders/:orderId/driver-update`（`src/api/orders.ts`）body `{driverId, dest?, special_notes?, waypoints?, reason?}`。驗 `order.driver_id===driverId` + status∈(ACCEPTED,ARRIVED,ON_TRIP)。改目的地→寫 `dest_*`+`dropoff_final`+`destination_confirmed=TRUE`+`destination_modified_at/by`；備註→`special_notes`；停靠→覆寫 `order_waypoints`。每筆改動寫 `order_edits`（append-only，before/after JSONB）。
- **稽核基礎（沿用既有預留欄位）**：`dropoff_original`(AI 原值) / `dropoff_final`(司機確認值) / `destination_confirmed` 在 `004` 早建好，這次接上。新表 `order_waypoints`(中途停靠，可影響 App 多點導航) + `order_edits`(修改稽核，參考 `landmark_audit` pattern)。
- **後台稽核**：`GET /api/orders/:orderId/edits` 回 AI 原值 vs 司機補值 + 逐筆修改 log + 停靠。
- **DTO**：`GET /api/orders`、`/:orderId` 加 `dropoffOriginal`/`dropoffFinal`/`waypoints`（列表用 `WHERE order_id = ANY($1)` 批次查避免 N+1）。
- **車資不受影響**：車資是司機跳表金額（`POST /:orderId/fare`），與目的地無關，補目的地不重算。
- App 端（司機補資料 UI + 多點導航）需發 Play 版；與 bridge 目的地選填**一起上線**（避免「AI 建了無目的地單、但司機還不能補」的空窗）。

### v2.2 鎖定花蓮服務區 + 在地詞庫優先

AI 是「花蓮在地」叫車，地址理解先以花蓮為中心，不跳外縣市同名地點。

- **bridge prompt 鎖花蓮**（`bridge.mjs` buildSystemPrompt）：宣告「只服務花蓮、所有地點當花蓮理解、不准猜外縣市」。**上車點必須花蓮**；**目的地可花蓮以外（長途也接）**。這條是「AI 問是不是高雄」的主因修正——AI 覆述確認在 geocode 之前，是 LLM 自己猜的。
- **候選先濾花蓮**（`HualienAddressDB.pickBestPlaceResult(results, query, hualienOnly)` + `geocodeWithGeocodingAPI/PlacesSearch(addr, allowOutOfBounds)`）：Geocoding 迭代候選取第一個 `isWithinHualienBounds`、Places 先 filter 花蓮界內 → 多候選時花蓮優先、外縣市永不被選（同名消歧）。
- **上車點 vs 目的地分開鎖**：`geocodeAddress(addr, isPickup)`。上車點解析到外縣市 → 回 `outOfServiceArea:{county}`（複用 forbiddenPickup 同條 plumbing）→ bridge 餵回 AI → AI 說「只服務花蓮、請重講」、不建單（**不再靜默退花蓮市中心硬建**）。目的地允許外縣市（不擋長途好單）。vague/找不到（非外縣市）的上車點仍退花蓮市中心待確認。
- **outOfServiceArea / forbiddenPickup 不快取**（每次都要攔截）。

### 在地地標詞庫 ↔ 後台同源、即時同步（重要維護性）

**AI 語音用的詞庫和後台地標編輯是「同一份資料」**：
- `HualienAddressDB.rebuildIndex()` 從 DB 的 `landmarks`+`landmark_aliases` 表載入記憶體索引（exact/alias/taigi）。
- 後台 `admin-landmarks` 新增/改/刪地標後**自動呼叫 `rebuildIndex()` 原子替換索引** → 電話/LINE 下一筆查詢**即時生效、零延遲、免重啟**。
- **要新增花蓮在地地標/店名/路口/站點（如阿美麻糬、太昌、慶豐、仁里、國聯…），直接在後台地圖選點新增即可**（座標準、含別名/台語），AI 語音馬上吃到。前台語音與後台地名**不會分家**。

### 部署步驟（Asterisk / nginx / 歡迎語）

```bash
# 1) Asterisk 設定
sudo cp deploy/asterisk/pjsip_fet.conf      /etc/asterisk/
sudo cp deploy/asterisk/extensions_fet.conf /etc/asterisk/
echo '#include pjsip_fet.conf'      | sudo tee -a /etc/asterisk/pjsip.conf
echo '#include extensions_fet.conf' | sudo tee -a /etc/asterisk/extensions.conf
sudo mkdir -p /etc/asterisk/scripts /var/spool/asterisk/recording
sudo cp deploy/asterisk/fire-webhook.sh /etc/asterisk/scripts/ && sudo chmod +x /etc/asterisk/scripts/fire-webhook.sh
sudo asterisk -rx "pjsip reload"; sudo asterisk -rx "dialplan reload"

# 2) 錄音 HTTP（nginx）。註：root 父層需 chmod o+x /var/spool/asterisk
sudo cp deploy/asterisk/recordings-http.conf /etc/nginx/sites-available/recordings
sudo ln -s /etc/nginx/sites-available/recordings /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 3) 歡迎語音檔（greeting-taxi + got-it，8kHz mono WAV）
node deploy/asterisk/gen-greeting.mjs
sudo cp deploy/asterisk/sounds/*.wav /var/lib/asterisk/sounds/custom/

# 4) 即時 AI bridge（box 上）
sudo cp realtime-bridge/bridge.mjs realtime-bridge/package.json /opt/taxi-ai-bridge/
sudo cp realtime-bridge/taxi-ai-bridge.service /etc/systemd/system/
# 依 .env.example 在 box 建 /opt/taxi-ai-bridge/.env（填真實 key，chmod 600）
sudo systemctl daemon-reload && sudo systemctl enable --now taxi-ai-bridge
```

### 驗證

1. **線路**：`asterisk -rx "pjsip show endpoint fet-endpoint"` Contact `Avail`；`sngrep` 看 RTP 來自 `123.51.252.4`。
2. **dialplan**：`asterisk -rx "dialplan show taxi-route"` 顯示 `GROUP_COUNT` 閘門。
3. **即時 AI**：撥 `03-8907320` → AI 對話 → 報禁區上車點(如火車站) → AI 念替代點 → 改口 → 建單 → 司機 App 收 `order:offer`；驗 DB `orders`(source=PHONE)、`customer_notifications`。
4. **fallback**：臨時 `MAX_CALLS=1` 並 restart bridge → 同撥 2 通 → 第 2 通走 MVP 錄音建單 → 測完調回 3。
5. **MVP/容錯**：模糊地址 → `/api/phone-calls/needs-review` Operator 審核 → APPROVED 續派；admin `GET /api/phone-calls/:callId/audio` 可聽錄音。
6. **服務常駐**：`systemctl is-enabled taxi-ai-bridge box-tunnel box-tunnel-http nginx asterisk` 全 `enabled`。

### 注意事項

- **數據機 SIP ALG 必須關**（斷話/單向通話最常見根因）。
- **REC_BASE**：`fire-webhook.sh` 用 `http://127.0.0.1:8090`（經反向隧道），非公網 IP。
- **3M 上行**：即時 AI 用 G.711 μ-law，`MAX_CALLS=3` 起步；超出退 MVP 錄音（本地不串流）。
- **代表號**：遠傳端無 hunt group；對外只宣傳 `03-8907320`，並發由 Asterisk + `MAX_CALLS` 閘門消化。
- 現有 FXO 市話線**先保留**當網路全斷時的緊急備援。

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

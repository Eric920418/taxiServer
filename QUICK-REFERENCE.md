# 🚀 快速參考手冊

> 所有功能、指令、文檔的快速索引

---

## 📚 文檔索引

| 文檔 | 說明 | 何時使用 |
|------|------|----------|
| [AI-DISPATCHER-GUIDE.md](./AI-DISPATCHER-GUIDE.md) | 智能派單引擎使用指南 | 了解派單系統如何運作 |
| [OPTIMIZATION-GUIDE.md](./OPTIMIZATION-GUIDE.md) | 優化與維護指南 | 定期優化系統性能 |
| [data-analysis-report.md](./data-analysis-report.md) | 初始數據分析報告 | 了解業務模式和洞察 |
| [QUICK-REFERENCE.md](./QUICK-REFERENCE.md) | 本文檔 - 快速參考 | 快速查找指令和功能 |

---

## 🎯 每日/每週/每月任務

### 每日檢查（5分鐘）

```bash
# 1. 查看系統狀態
pm2 status

# 2. 查看最近日誌
pm2 logs --lines 50

# 3. 快速測試 API
curl http://localhost:3000/health
curl http://localhost:3000/api/dispatch/stats
```

### 每週分析（30分鐘 - 建議週一早上）

```bash
# 1. 生成週報
npx tsx scripts/weekly-report.ts

# 2. 查看報告
cat reports/weekly-$(date +%Y-%m-%d).md

# 3. 檢查司機收入平衡
curl http://localhost:3000/api/dispatch/driver-earnings | jq

# 4. 檢查熱區狀態
curl http://localhost:3000/api/dispatch/hot-zones | jq
```

### 每月優化（2小時 - 建議月初）

```bash
# 1. 備份數據庫
pg_dump -U postgres hualien_taxi > backups/db-$(date +%Y%m%d).sql

# 2. 生成月度分析
# 修改 weekly-report.ts 中的時間範圍為 30 天

# 3. 更新熱區配置（根據週報建議）
vi src/services/ai-dispatcher.ts

# 4. 調整評分權重（根據效果）
vi src/services/ai-dispatcher.ts

# 5. 重新編譯並重啟
./restart.sh

# 6. 運行測試驗證
npx tsx test-dispatcher.ts
```

---

## 🔧 常用指令

### 系統操作

```bash
# 啟動服務
pnpm dev                    # 開發模式
pm2 start ecosystem.config.js  # 生產模式

# 重啟服務（最常用）
./restart.sh                # 完整重啟（編譯+重啟）
pm2 restart taxiserver      # 快速重啟

# 停止服務
pm2 stop taxiserver

# 查看狀態
pm2 status
pm2 monit                   # 即時監控

# 查看日誌
pm2 logs                    # 實時日誌
pm2 logs --lines 100        # 最近100行
pm2 logs --err              # 只看錯誤
```

### 測試與診斷

```bash
# 完整測試派單引擎
npx tsx test-dispatcher.ts

# 生成模擬數據
npx tsx scripts/generate-mock-data.ts

# 生成週報
npx tsx scripts/weekly-report.ts

# 測試 API 端點
curl http://localhost:3000/api/dispatch/stats
curl http://localhost:3000/api/dispatch/hot-zones
curl http://localhost:3000/api/dispatch/driver-earnings
```

### 資料庫操作

```bash
# 連接資料庫
sudo -u postgres psql -d hualien_taxi

# 查看訂單統計
sudo -u postgres psql -d hualien_taxi -c "
  SELECT status, COUNT(*)
  FROM orders
  GROUP BY status;
"

# 查看今日訂單
sudo -u postgres psql -d hualien_taxi -c "
  SELECT COUNT(*) as today_orders
  FROM orders
  WHERE DATE(created_at) = CURRENT_DATE;
"

# 備份資料庫
pg_dump -U postgres hualien_taxi > backup.sql

# 優化資料庫
sudo -u postgres psql -d hualien_taxi -c "VACUUM ANALYZE;"
```

---

## 🌐 API 端點快速參考

### 派單相關

| 端點 | 方法 | 說明 | 範例 |
|------|------|------|------|
| `/api/dispatch/smart` | POST | 智能派單 | 見下方 |
| `/api/dispatch/stats` | GET | 派單統計 | `curl localhost:3000/api/dispatch/stats` |
| `/api/dispatch/hot-zones` | GET | 當前熱區 | `curl localhost:3000/api/dispatch/hot-zones` |
| `/api/dispatch/driver-earnings` | GET | 司機收入 | `curl localhost:3000/api/dispatch/driver-earnings` |
| `/api/dispatch/simulate` | POST | 模擬派單 | `curl -X POST localhost:3000/api/dispatch/simulate -H "Content-Type: application/json" -d '{"count":10}'` |

### 智能派單範例

```bash
curl -X POST http://localhost:3000/api/dispatch/smart \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "TEST001",
    "pickupLat": 23.9933,
    "pickupLng": 121.6011,
    "destLat": 23.9878,
    "destLng": 121.6061,
    "passengerId": "PASS001"
  }'
```

### 其他 API

| 端點 | 方法 | 說明 |
|------|------|------|
| `/health` | GET | 健康檢查 |
| `/api/drivers` | GET | 司機列表 |
| `/api/orders` | GET | 訂單列表 |
| `/api/passengers` | GET | 乘客列表 |
| `/api/earnings` | GET | 收入統計 |

---

## ⚙️ 配置檔案位置

| 檔案 | 說明 | 何時修改 |
|------|------|----------|
| `.env` | 環境變數（資料庫連線等） | 部署時、資料庫變更時 |
| `src/services/ai-dispatcher.ts` | 派單引擎核心邏輯 | 每月優化時 |
| `ecosystem.config.js` | PM2 配置 | 調整執行環境時 |
| `tsconfig.json` | TypeScript 配置 | 極少修改 |

---

## 🎛️ 關鍵參數調整

### 熱區配置

**檔案**: `src/services/ai-dispatcher.ts` (約第19行)

```typescript
const HOT_ZONES = {
  '東大門夜市': {
    lat: 23.9986,        // 緯度
    lng: 121.6083,       // 經度
    radius: 1,           // 半徑(km) - 建議 0.5-2
    peakHours: [18,19,20,21,22], // 活躍時段
    weight: 1.5          // 權重 - 建議 1.2-2.0
  },
  // 根據週報建議新增...
};
```

### 評分權重

**檔案**: `src/services/ai-dispatcher.ts` (約第163行)

```typescript
const components = {
  distance: 30,    // 距離 (建議: 25-35)
  hotZone: 20,     // 熱區 (建議: 15-25)
  earnings: 25,    // 收入平衡 (建議: 20-30)
  efficiency: 15,  // 效率 (建議: 10-20)
  acceptance: 5,   // 接單率 (建議: 3-7)
  golden: 5        // 黃金時段 (建議: 3-7)
};
```

### ETA 速度參數

**檔案**: `src/services/ai-dispatcher.ts` (約第259行)

```typescript
let avgSpeed = 30; // 一般時段 (建議: 25-35 km/h)

if ([7, 8, 17, 18, 19].includes(hour)) {
  avgSpeed = 20;   // 高峰時段 (建議: 15-25 km/h)
} else if (hour >= 23 || hour <= 5) {
  avgSpeed = 40;   // 深夜時段 (建議: 35-45 km/h)
}
```

---

## 📊 監控指標目標值

| 指標 | 目標值 | 警戒值 | 如何查看 |
|------|--------|--------|----------|
| 平均接單時間 | < 45秒 | > 90秒 | 週報 / API stats |
| 訂單完成率 | > 85% | < 75% | 週報 |
| 司機收入差距 | < 20% | > 40% | API driver-earnings |
| 派單評分 | > 60分 | < 45分 | API stats |
| 系統響應時間 | < 200ms | > 500ms | pm2 logs |

---

## 🚨 故障排除

### 問題：服務無法啟動

```bash
# 1. 檢查是否已有進程
pm2 list

# 2. 停止所有進程
pm2 stop all

# 3. 重新啟動
pm2 start ecosystem.config.js

# 4. 查看錯誤日誌
pm2 logs --err
```

### 問題：資料庫連接失敗

```bash
# 1. 檢查 PostgreSQL 是否運行
sudo systemctl status postgresql

# 2. 檢查 .env 配置
cat .env | grep DB_

# 3. 測試連接
sudo -u postgres psql -d hualien_taxi -c "SELECT 1;"
```

### 問題：派單沒有推薦司機

```bash
# 1. 檢查是否有可用司機
curl http://localhost:3000/api/drivers | jq '.[] | select(.availability=="AVAILABLE")'

# 2. 檢查司機心跳時間
sudo -u postgres psql -d hualien_taxi -c "
  SELECT driver_id, name, availability, last_heartbeat
  FROM drivers
  WHERE availability = 'AVAILABLE';
"

# 3. 更新司機狀態
sudo -u postgres psql -d hualien_taxi -c "
  UPDATE drivers
  SET availability = 'AVAILABLE',
      last_heartbeat = NOW()
  WHERE driver_id = 'D001';
"
```

### 問題：編譯錯誤

```bash
# 1. 清理並重新安裝依賴
rm -rf node_modules
rm pnpm-lock.yaml
pnpm install

# 2. 清理編譯產物
rm -rf dist

# 3. 重新編譯
pnpm build
```

---

## 📈 優化路徑圖

### 階段 1：當前（規則引擎）✅
- [x] 基於數據分析的規則引擎
- [x] 熱區識別
- [x] 收入平衡
- [x] ETA 預測

### 階段 2：短期優化（1-3個月）
- [ ] 建立監控儀表板
- [ ] A/B 測試不同策略
- [ ] 自動化週報生成（定時任務）
- [ ] 異常預警系統

### 階段 3：中期優化（3-6個月）
- [ ] 引入 ML ETA 預測模型
- [ ] 需求預測系統
- [ ] 動態調整熱區

### 階段 4：長期優化（6-12個月）
- [ ] 深度學習派單模型
- [ ] 動態定價系統
- [ ] 多城市擴展

---

## 💡 最佳實踐

### DO ✅

- ✅ 每週生成並檢視週報
- ✅ 每月備份資料庫
- ✅ 基於數據調整參數
- ✅ 小步調整，觀察效果
- ✅ 記錄每次參數變更

### DON'T ❌

- ❌ 同時調整多個參數
- ❌ 沒有數據支持就大幅變更
- ❌ 忽略警戒指標
- ❌ 忘記備份就修改
- ❌ 跳過測試直接上線

---

## 📞 緊急聯絡

如果遇到嚴重問題：

1. **立即回滾**：
   ```bash
   pm2 stop taxiserver
   git checkout HEAD~1  # 回到上一版本
   pnpm build
   pm2 start ecosystem.config.js
   ```

2. **恢復資料庫**（如果誤刪數據）：
   ```bash
   sudo -u postgres psql -d hualien_taxi < backups/latest-backup.sql
   ```

3. **查看完整日誌**：
   ```bash
   pm2 logs --lines 1000 > error-report.log
   ```

---

## 🔗 相關資源

- [Node.js 文檔](https://nodejs.org/docs/)
- [PostgreSQL 文檔](https://www.postgresql.org/docs/)
- [PM2 文檔](https://pm2.keymetrics.io/docs/)
- [TypeScript 手冊](https://www.typescriptlang.org/docs/)

---

*最後更新：2025年11月10日*
*系統版本：v2.0 (智能派單引擎)*
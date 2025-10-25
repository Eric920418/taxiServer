# 🚀 花蓮計程車系統 - 快速開始指南

## 步驟 1: 初始化資料庫

```bash
cd /Users/eric/Desktop/HualienTaxiServer

# 方法 A: 使用自動化腳本（推薦）
cd scripts
chmod +x db-setup.sh
./db-setup.sh

# 方法 B: 手動執行
createdb hualien_taxi
psql -d hualien_taxi -f src/db/schema.sql
pnpm run db:init
```

## 步驟 2: 生成模擬數據（150筆訂單）

```bash
pnpm run db:mock
```

你會看到：
```
============================================
  花蓮計程車系統 - 模擬數據生成器
============================================

[1/3] 生成模擬訂單數據...
✓ 已生成 150 筆訂單

[2/3] 插入訂單到資料庫...
  已插入 150/150 筆...
✓ 成功插入 150 筆訂單

[3/3] 生成統計報告...

訂單狀態統計:
────────────────────────────────────────────────────────────
  DONE         | 數量: 135 | 平均車資: NT$145 | 平均距離: 8.5km
  CANCELLED    | 數量:  15 | 平均車資: NT$0   | 平均距離: 7.2km

時段分布統計:
────────────────────────────────────────────────────────────
  深夜 (00-05)  | ███ 18 筆
  早晨 (06-11)  | ████████████ 42 筆
  午後 (12-17)  | ██████████ 35 筆
  晚間 (18-23)  | ███████████████ 55 筆

============================================
✓ 模擬數據生成完成！
============================================
```

## 步驟 3: 啟動 Server

```bash
pnpm dev
```

應該看到：
```
╔════════════════════════════════════════════╗
║   花蓮計程車司機端 Server 已啟動            ║
║   HTTP: http://localhost:3000              ║
║   WebSocket: ws://localhost:3000           ║
╚════════════════════════════════════════════╝
[DB] PostgreSQL 連接成功
```

## 步驟 4: 測試 API

### 查詢所有訂單
```bash
curl http://localhost:3000/api/orders | jq .
```

### 查詢司機今日收入
```bash
curl "http://localhost:3000/api/earnings/D001?period=today" | jq .
```

回應範例：
```json
{
  "success": true,
  "driverId": "D001",
  "earnings": {
    "period": "today",
    "totalAmount": 850,
    "orderCount": 6,
    "totalDistance": 45.3,
    "totalDuration": 3.5,
    "averageFare": 141.67,
    "orders": [...]
  }
}
```

### 查詢司機本月收入
```bash
curl "http://localhost:3000/api/earnings/D001?period=month" | jq .
```

### 查詢收入排行榜
```bash
curl "http://localhost:3000/api/earnings/leaderboard?period=week" | jq .
```

## 模擬數據特點

✅ **真實花蓮地點：**
- 花蓮火車站、東大門夜市、七星潭
- 慈濟醫院、遠百花蓮店、東華大學
- 共 20+ 個真實地點

✅ **符合真實使用模式：**
- 時段分布：上下班高峰（7-9時、17-19時）
- 週末訂單較多
- 深夜訂單較少

✅ **完整訂單流程：**
- 90% 完成率
- 5% 取消率
- 包含完整時間戳（接單、到達、開始、完成）

✅ **真實車資計算：**
- 起跳 100元（1.5km）
- 續跳 5元/200m
- 基於實際距離計算

## 資料分析範例

### SQL 查詢範例

```sql
-- 查詢今日訂單
SELECT * FROM orders
WHERE created_at >= CURRENT_DATE
ORDER BY created_at DESC;

-- 查詢熱門時段
SELECT
  hour_of_day,
  COUNT(*) as count,
  AVG(meter_amount) as avg_fare
FROM orders
WHERE status = 'DONE'
GROUP BY hour_of_day
ORDER BY count DESC;

-- 查詢熱門路線
SELECT
  pickup_address,
  dest_address,
  COUNT(*) as trip_count,
  AVG(meter_amount) as avg_fare
FROM orders
WHERE status = 'DONE'
GROUP BY pickup_address, dest_address
ORDER BY trip_count DESC
LIMIT 10;

-- 司機績效排行
SELECT
  driver_id,
  COUNT(*) as total_trips,
  SUM(meter_amount) as total_earnings,
  AVG(meter_amount) as avg_fare
FROM orders
WHERE status = 'DONE'
  AND completed_at >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY driver_id
ORDER BY total_earnings DESC;
```

## 下一步：AI 訓練

現在你已經有 150+ 筆真實模擬數據，可以開始：

1. **分析熱區模式**：哪些地點訂單最多？
2. **時段分析**：哪些時段最賺錢？
3. **距離優化**：如何派單能讓司機收益最大化？
4. **ETA 預測**：訓練模型預測到達時間

查看 `src/services/dispatcher.ts` 了解智能派單演算法！

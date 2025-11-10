# 🔧 智能派單系統 - 優化與維護指南

> 當您累積更多真實數據後，按照本指南定期優化系統，持續提升效能

---

## 📋 目錄

1. [定期優化時程表](#定期優化時程表)
2. [每週數據分析](#每週數據分析)
3. [每月參數調優](#每月參數調優)
4. [每季系統評估](#每季系統評估)
5. [關鍵監控指標](#關鍵監控指標)
6. [優化檢查清單](#優化檢查清單)
7. [進階優化建議](#進階優化建議)

---

## 定期優化時程表

### 📅 每週一次（建議週一早上）

- **數據分析報告**
- **熱區更新**
- **異常訂單檢查**

### 📅 每月一次（建議月初）

- **參數調優**
- **司機分類更新**
- **收入平衡檢討**

### 📅 每季一次（建議季末）

- **全面系統評估**
- **A/B 測試新策略**
- **考慮引入 AI 模型**

---

## 每週數據分析

### 1. 執行週報生成腳本

創建 `scripts/weekly-report.ts`：

```typescript
/**
 * 週報生成腳本
 * 執行：npx tsx scripts/weekly-report.ts
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'hualien_taxi',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function generateWeeklyReport() {
  const today = new Date();
  const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  console.log('📊 生成週報...\n');

  // 1. 總體訂單統計
  const orderStats = await pool.query(`
    SELECT
      COUNT(*) as total_orders,
      COUNT(CASE WHEN status = 'DONE' THEN 1 END) as completed,
      COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled,
      ROUND(AVG(CASE WHEN status = 'DONE' THEN meter_amount END)) as avg_fare,
      ROUND(AVG(CASE WHEN status = 'DONE' THEN actual_distance_km END)::numeric, 2) as avg_distance,
      SUM(CASE WHEN status = 'DONE' THEN meter_amount ELSE 0 END) as total_revenue
    FROM orders
    WHERE created_at >= $1 AND created_at < $2
  `, [lastWeek, today]);

  // 2. 新熱門路線（本週 vs 上週比較）
  const hotRoutes = await pool.query(`
    SELECT
      pickup_address,
      dest_address,
      COUNT(*) as trip_count,
      ROUND(AVG(meter_amount)) as avg_fare,
      ROUND(AVG(actual_duration_min)) as avg_duration
    FROM orders
    WHERE status = 'DONE'
      AND created_at >= $1 AND created_at < $2
    GROUP BY pickup_address, dest_address
    HAVING COUNT(*) >= 3
    ORDER BY trip_count DESC
    LIMIT 10
  `, [lastWeek, today]);

  // 3. 時段變化分析
  const hourlyTrends = await pool.query(`
    SELECT
      hour_of_day,
      COUNT(*) as order_count,
      SUM(meter_amount) as revenue,
      ROUND(AVG(meter_amount)) as avg_fare
    FROM orders
    WHERE status = 'DONE'
      AND created_at >= $1 AND created_at < $2
    GROUP BY hour_of_day
    ORDER BY revenue DESC
    LIMIT 5
  `, [lastWeek, today]);

  // 4. 司機績效
  const driverPerformance = await pool.query(`
    SELECT
      d.driver_id,
      d.name,
      COUNT(o.order_id) as trips,
      SUM(o.meter_amount) as earnings,
      ROUND(AVG(EXTRACT(EPOCH FROM (o.accepted_at - o.created_at)))) as avg_accept_sec,
      ROUND(d.acceptance_rate, 2) as acceptance_rate
    FROM drivers d
    LEFT JOIN orders o ON d.driver_id = o.driver_id
      AND o.status = 'DONE'
      AND o.created_at >= $1 AND o.created_at < $2
    GROUP BY d.driver_id, d.name, d.acceptance_rate
    ORDER BY trips DESC
  `, [lastWeek, today]);

  // 5. 派單效率（如果有 dispatch_logs 數據）
  const dispatchStats = await pool.query(`
    SELECT
      COUNT(*) as total_dispatches,
      ROUND(AVG(dispatch_score), 2) as avg_score,
      ROUND(AVG(predicted_eta)) as avg_predicted_eta
    FROM dispatch_logs
    WHERE created_at >= $1 AND created_at < $2
  `, [lastWeek, today]);

  // 生成 Markdown 報告
  const report = `
# 📊 週報 - ${lastWeek.toLocaleDateString()} 至 ${today.toLocaleDateString()}

## 一、總體營運數據

| 指標 | 數值 |
|------|------|
| 總訂單數 | ${orderStats.rows[0].total_orders} |
| 完成訂單 | ${orderStats.rows[0].completed} |
| 取消訂單 | ${orderStats.rows[0].cancelled} |
| 完成率 | ${(orderStats.rows[0].completed / orderStats.rows[0].total_orders * 100).toFixed(1)}% |
| 總營收 | NT$${orderStats.rows[0].total_revenue.toLocaleString()} |
| 平均車資 | NT$${orderStats.rows[0].avg_fare} |
| 平均距離 | ${orderStats.rows[0].avg_distance}km |

## 二、熱門路線 TOP 10

| 起點 | 終點 | 次數 | 平均車資 | 平均時長 |
|------|------|------|----------|----------|
${hotRoutes.rows.map(r =>
  `| ${r.pickup_address} | ${r.dest_address} | ${r.trip_count} | NT$${r.avg_fare} | ${r.avg_duration}分 |`
).join('\n')}

## 三、黃金時段 TOP 5

| 時段 | 訂單量 | 營收 | 平均車資 |
|------|--------|------|----------|
${hourlyTrends.rows.map(r =>
  `| ${r.hour_of_day}:00 | ${r.order_count} | NT$${r.revenue} | NT$${r.avg_fare} |`
).join('\n')}

## 四、司機績效排行

| 司機 | 完成訂單 | 總收入 | 平均接單時間 | 接單率 |
|------|----------|---------|--------------|--------|
${driverPerformance.rows.map(r =>
  `| ${r.name} | ${r.trips || 0} | NT$${r.earnings || 0} | ${r.avg_accept_sec || 0}秒 | ${r.acceptance_rate}% |`
).join('\n')}

## 五、派單引擎效率

| 指標 | 數值 |
|------|------|
| 總派單次數 | ${dispatchStats.rows[0]?.total_dispatches || 0} |
| 平均評分 | ${dispatchStats.rows[0]?.avg_score || 0} 分 |
| 平均預測 ETA | ${dispatchStats.rows[0]?.avg_predicted_eta || 0} 分鐘 |

## 六、優化建議

### 🔥 需要關注的熱區

根據本週數據，以下區域訂單量增加：

${hotRoutes.rows.slice(0, 3).map(r =>
  `- **${r.pickup_address}** → ${r.dest_address}（${r.trip_count}次）`
).join('\n')}

### ⚙️ 建議調整

1. 檢查是否需要更新熱區配置
2. 觀察司機收入平衡情況
3. 確認黃金時段設定是否符合實際

---

*報告生成時間：${new Date().toLocaleString()}*
  `;

  // 儲存報告
  const filename = `reports/weekly-${today.toISOString().split('T')[0]}.md`;
  if (!fs.existsSync('reports')) {
    fs.mkdirSync('reports');
  }
  fs.writeFileSync(filename, report);

  console.log(`✅ 週報已生成：${filename}\n`);
  console.log(report);

  await pool.end();
}

generateWeeklyReport().catch(console.error);
```

### 2. 使用方式

```bash
# 每週一執行
npx tsx scripts/weekly-report.ts
```

### 3. 檢查項目

根據週報檢查以下項目：

- [ ] **完成率** - 目標 > 85%
- [ ] **平均接單時間** - 目標 < 60 秒
- [ ] **司機收入差距** - 目標 < 30%
- [ ] **新熱門路線** - 是否需要加入熱區？
- [ ] **時段變化** - 黃金時段是否改變？

---

## 每月參數調優

### 1. 調整熱區配置

根據月度數據更新熱區設定：

**檔案**：`src/services/ai-dispatcher.ts`

```typescript
// 每月根據實際數據更新
const HOT_ZONES = {
  '東大門夜市': {
    lat: 23.9986,
    lng: 121.6083,
    radius: 1, // 根據訂單分布調整
    peakHours: [18, 19, 20, 21, 22], // 根據時段分析調整
    weight: 1.5 // 根據訂單量調整：1.2-2.0
  },
  // ... 新增或移除熱區
};
```

**調整依據查詢**：

```sql
-- 找出訂單密集區域
SELECT
  pickup_address,
  COUNT(*) as order_count,
  AVG(pickup_lat) as avg_lat,
  AVG(pickup_lng) as avg_lng,
  ARRAY_AGG(DISTINCT EXTRACT(HOUR FROM created_at)::int ORDER BY EXTRACT(HOUR FROM created_at)) as peak_hours
FROM orders
WHERE created_at > NOW() - INTERVAL '30 days'
  AND status = 'DONE'
GROUP BY pickup_address
HAVING COUNT(*) >= 20
ORDER BY order_count DESC;
```

### 2. 調整評分權重

根據派單效果調整評分權重：

**檔案**：`src/services/ai-dispatcher.ts` → `calculateDriverScore()`

```typescript
const components = {
  distance: 30,    // 距離評分 (建議範圍: 25-35)
  hotZone: 20,     // 熱區評分 (建議範圍: 15-25)
  earnings: 25,    // 收入平衡 (建議範圍: 20-30)
  efficiency: 15,  // 效率匹配 (建議範圍: 10-20)
  acceptance: 5,   // 接單率 (建議範圍: 3-7)
  golden: 5        // 黃金時段 (建議範圍: 3-7)
};
```

**調整原則**：

- 如果乘客等待時間長 → 提高 `distance` 權重
- 如果司機收入差距大 → 提高 `earnings` 權重
- 如果熱區覆蓋不足 → 提高 `hotZone` 權重

**效果驗證查詢**：

```sql
-- 檢查派單效果
SELECT
  DATE(dl.created_at) as date,
  COUNT(*) as dispatches,
  AVG(dl.dispatch_score) as avg_score,
  AVG(dl.predicted_eta) as avg_eta,
  AVG(EXTRACT(EPOCH FROM (o.accepted_at - o.created_at))) as actual_accept_time
FROM dispatch_logs dl
LEFT JOIN orders o ON dl.order_id = o.order_id
WHERE dl.created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(dl.created_at)
ORDER BY date DESC;
```

### 3. 更新司機分類

根據歷史表現重新分類司機：

```sql
-- 分析司機特性
SELECT
  driver_id,
  AVG(actual_duration_min) as avg_duration,
  AVG(actual_distance_km) as avg_distance,
  COUNT(*) as total_trips,
  AVG(EXTRACT(EPOCH FROM (accepted_at - created_at))) as avg_accept_time
FROM orders
WHERE status = 'DONE'
  AND created_at > NOW() - INTERVAL '30 days'
GROUP BY driver_id;
```

**調整依據**：

- `avg_duration < 10` → 快速週轉型
- `avg_distance > 5` → 長距離專家型
- `avg_accept_time < 45` → 高訂單量型

### 4. 優化 ETA 預測

根據實際行車數據調整速度參數：

**檔案**：`src/services/ai-dispatcher.ts` → `predictETA()`

```typescript
// 根據實際數據調整平均速度
let avgSpeed = 30; // 基礎速度 (建議範圍: 25-35 km/h)

// 高峰時段降速
if ([7, 8, 17, 18, 19].includes(hour)) {
  avgSpeed = 20; // 高峰速度 (建議範圍: 15-25 km/h)
}
// 深夜提速
else if (hour >= 23 || hour <= 5) {
  avgSpeed = 40; // 深夜速度 (建議範圍: 35-45 km/h)
}
```

**驗證查詢**：

```sql
-- 比較預測 vs 實際時間
SELECT
  EXTRACT(HOUR FROM o.created_at) as hour,
  AVG(dl.predicted_eta) as predicted_eta,
  AVG(EXTRACT(EPOCH FROM (o.accepted_at - o.created_at)) / 60) as actual_eta,
  COUNT(*) as sample_size
FROM dispatch_logs dl
JOIN orders o ON dl.order_id = o.order_id
WHERE o.status IN ('ACCEPTED', 'DONE')
  AND o.created_at > NOW() - INTERVAL '30 days'
GROUP BY EXTRACT(HOUR FROM o.created_at)
ORDER BY hour;
```

---

## 每季系統評估

### 1. 全面數據分析

執行完整的季度分析：

```bash
# 修改分析週期為 90 天
# 執行數據分析
psql -U postgres -d hualien_taxi < scripts/quarterly-analysis.sql
```

**檔案**：`scripts/quarterly-analysis.sql`

```sql
-- 季度分析報告
\echo '========================================='
\echo '       季度系統評估報告'
\echo '========================================='
\echo ''

-- 1. 派單效率趨勢
\echo '1. 派單效率趨勢'
SELECT
  DATE_TRUNC('week', created_at) as week,
  COUNT(*) as total_orders,
  AVG(EXTRACT(EPOCH FROM (accepted_at - created_at))) as avg_accept_time,
  COUNT(CASE WHEN status = 'DONE' THEN 1 END)::float / COUNT(*) * 100 as completion_rate
FROM orders
WHERE created_at > NOW() - INTERVAL '90 days'
GROUP BY DATE_TRUNC('week', created_at)
ORDER BY week;

-- 2. 收入平衡改善
\echo ''
\echo '2. 司機收入標準差（數值越小越平衡）'
SELECT
  DATE_TRUNC('week', completed_at) as week,
  STDDEV(daily_earnings) as earnings_stddev,
  MAX(daily_earnings) - MIN(daily_earnings) as earnings_gap
FROM (
  SELECT
    driver_id,
    DATE(completed_at) as date,
    SUM(meter_amount) as daily_earnings
  FROM orders
  WHERE status = 'DONE'
    AND completed_at > NOW() - INTERVAL '90 days'
  GROUP BY driver_id, DATE(completed_at)
) daily
GROUP BY DATE_TRUNC('week', completed_at)
ORDER BY week;

-- 3. 熱區效果分析
\echo ''
\echo '3. 熱區派單效果'
SELECT
  CASE
    WHEN pickup_address IN ('東大門夜市', '花蓮火車站', '遠百花蓮店', '太魯閣國家公園') THEN '熱區'
    ELSE '非熱區'
  END as zone_type,
  COUNT(*) as orders,
  AVG(EXTRACT(EPOCH FROM (accepted_at - created_at))) as avg_accept_time,
  AVG(meter_amount) as avg_fare
FROM orders
WHERE status = 'DONE'
  AND created_at > NOW() - INTERVAL '90 days'
GROUP BY zone_type;

-- 4. 時段優化效果
\echo ''
\echo '4. 黃金時段 vs 一般時段'
SELECT
  CASE
    WHEN EXTRACT(HOUR FROM created_at) IN (19, 15, 17, 7, 22) THEN '黃金時段'
    ELSE '一般時段'
  END as time_type,
  COUNT(*) as orders,
  SUM(meter_amount) as revenue,
  AVG(meter_amount) as avg_fare
FROM orders
WHERE status = 'DONE'
  AND created_at > NOW() - INTERVAL '90 days'
GROUP BY time_type;
```

### 2. A/B 測試新策略

測試不同的派單策略效果：

**範例：測試「距離優先」vs「收入平衡優先」**

```typescript
// 在 ai-dispatcher.ts 中加入實驗模式
export class SmartDispatcher {
  private experimentMode: 'A' | 'B' = 'A'; // A=距離優先, B=收入優先

  async dispatch(order: any) {
    // 根據訂單 ID 的奇偶數決定策略
    const useStrategyB = parseInt(order.orderId.slice(-1)) % 2 === 0;

    if (useStrategyB) {
      // 策略 B：收入平衡優先
      components.distance = 20;
      components.earnings = 35;
    } else {
      // 策略 A：距離優先
      components.distance = 35;
      components.earnings = 20;
    }
    // ...
  }
}
```

**比較結果**：

```sql
-- A/B 測試效果比較
SELECT
  CASE
    WHEN CAST(RIGHT(order_id, 1) AS INTEGER) % 2 = 0 THEN '策略B-收入優先'
    ELSE '策略A-距離優先'
  END as strategy,
  COUNT(*) as orders,
  AVG(EXTRACT(EPOCH FROM (accepted_at - created_at))) as avg_accept_time,
  AVG(meter_amount) as avg_fare,
  STDDEV(driver_daily_earnings) as earnings_balance
FROM orders
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY strategy;
```

### 3. 考慮引入 AI 模型

當數據量 > 10,000 筆時，可以考慮：

**階段 1：ETA 預測模型（最簡單）**

```python
# scripts/train_eta_model.py
import pandas as pd
import psycopg2
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
import joblib

# 連接資料庫
conn = psycopg2.connect("dbname=hualien_taxi user=postgres")

# 讀取數據
df = pd.read_sql("""
    SELECT
        pickup_lat, pickup_lng,
        dest_lat, dest_lng,
        EXTRACT(HOUR FROM created_at) as hour,
        EXTRACT(DOW FROM created_at) as day_of_week,
        EXTRACT(EPOCH FROM (accepted_at - created_at)) / 60 as eta_minutes
    FROM orders
    WHERE status IN ('ACCEPTED', 'DONE')
        AND accepted_at IS NOT NULL
    LIMIT 10000
""", conn)

# 特徵和目標
X = df[['pickup_lat', 'pickup_lng', 'dest_lat', 'dest_lng', 'hour', 'day_of_week']]
y = df['eta_minutes']

# 訓練模型
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)
model = RandomForestRegressor(n_estimators=100, random_state=42)
model.fit(X_train, y_train)

# 評估
score = model.score(X_test, y_test)
print(f"模型 R² 分數: {score:.2%}")

# 保存模型
joblib.dump(model, 'models/eta_predictor.pkl')
print("✅ 模型已保存")
```

**在 Node.js 中使用模型**：

```typescript
import { spawn } from 'child_process';

async function predictETAWithML(order: any): Promise<number> {
  return new Promise((resolve, reject) => {
    const python = spawn('python3', [
      'scripts/predict_eta.py',
      order.pickupLat.toString(),
      order.pickupLng.toString(),
      order.destLat.toString(),
      order.destLng.toString(),
      new Date().getHours().toString(),
      new Date().getDay().toString()
    ]);

    let output = '';
    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        resolve(parseFloat(output.trim()));
      } else {
        reject(new Error('ML prediction failed'));
      }
    });
  });
}
```

---

## 關鍵監控指標

### API 監控端點

**1. 即時監控**

```bash
# 查看派單統計
curl http://localhost:3000/api/dispatch/stats

# 查看司機收入
curl http://localhost:3000/api/dispatch/driver-earnings

# 查看熱區狀態
curl http://localhost:3000/api/dispatch/hot-zones
```

**2. 建立監控儀表板**

使用 Grafana 或簡單的監控頁面：

**檔案**：`src/api/dashboard.ts`

```typescript
import { Router } from 'express';
import pool from '../db/connection';

const router = Router();

router.get('/metrics', async (req, res) => {
  const metrics = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM orders WHERE created_at > NOW() - INTERVAL '1 hour') as orders_last_hour,
      (SELECT AVG(EXTRACT(EPOCH FROM (accepted_at - created_at))) FROM orders WHERE accepted_at > NOW() - INTERVAL '1 hour') as avg_accept_time,
      (SELECT COUNT(*) FROM drivers WHERE availability = 'AVAILABLE') as available_drivers,
      (SELECT AVG(meter_amount) FROM orders WHERE status = 'DONE' AND completed_at > NOW() - INTERVAL '1 hour') as avg_fare_last_hour
  `);

  res.json({
    timestamp: new Date(),
    metrics: metrics.rows[0]
  });
});

export default router;
```

### 關鍵指標目標

| 指標 | 目標值 | 警戒值 | 說明 |
|------|--------|--------|------|
| 平均接單時間 | < 45秒 | > 90秒 | 越短越好 |
| 訂單完成率 | > 85% | < 75% | 取消率太高需檢討 |
| 司機收入差距 | < 20% | > 40% | 最高與最低收入差距 |
| 派單評分 | > 60分 | < 45分 | 綜合評分 |
| ETA 準確度 | ±20% | ±40% | 預測 vs 實際 |

---

## 優化檢查清單

### 每週檢查清單

```markdown
## 每週優化檢查 - YYYY/MM/DD

### 數據收集
- [ ] 執行週報腳本：`npx tsx scripts/weekly-report.ts`
- [ ] 查看 PM2 日誌：`pm2 logs --lines 100`
- [ ] 檢查資料庫連接狀態

### 性能指標
- [ ] 平均接單時間：_____秒 (目標 < 45秒)
- [ ] 訂單完成率：_____%  (目標 > 85%)
- [ ] 司機收入差距：_____%  (目標 < 20%)

### 異常處理
- [ ] 是否有大量取消訂單？
- [ ] 是否有司機接單率異常低？
- [ ] 是否有新的熱點區域？

### 行動項目
- [ ] ________________________
- [ ] ________________________
```

### 每月檢查清單

```markdown
## 每月優化檢查 - YYYY/MM

### 參數調整
- [ ] 檢查並更新熱區配置
- [ ] 檢查並調整評分權重
- [ ] 檢查並更新黃金時段
- [ ] 重新分類司機類型

### 系統優化
- [ ] 清理過期的派單日誌 (> 90 天)
- [ ] 更新數據庫索引
- [ ] 檢查伺服器資源使用率

### 數據備份
- [ ] 備份訂單數據
- [ ] 備份派單記錄
- [ ] 匯出月度報表

### 改進計劃
- [ ] ________________________
- [ ] ________________________
```

---

## 進階優化建議

### 1. 當數據量達到不同階段時

**階段一：1,000-5,000 筆訂單**
- ✅ 持續使用規則引擎
- ✅ 定期調整參數
- ✅ 收集更多特徵數據

**階段二：5,000-10,000 筆訂單**
- 考慮引入簡單的機器學習模型（ETA 預測）
- 實施 A/B 測試驗證效果
- 建立完整的監控系統

**階段三：> 10,000 筆訂單**
- 引入深度學習模型
- 實時需求預測
- 動態定價系統

### 2. 進階功能開發優先序

**Priority 1（3-6個月內）**
1. ✅ 完善規則引擎（已完成）
2. 📊 建立監控儀表板
3. 🔔 異常預警系統

**Priority 2（6-12個月）**
1. 🤖 ETA 預測 ML 模型
2. 📈 需求預測系統
3. 🚗 司機推薦路線

**Priority 3（12個月後）**
1. 🧠 深度學習派單模型
2. 💰 動態定價系統
3. 🌐 多城市擴展

### 3. 技術債務管理

定期檢查並改進：

```typescript
// TODO 清單範例
/**
 * 技術債務追蹤
 *
 * [TECH-001] 優化距離計算（考慮使用 PostGIS）
 * [TECH-002] 增加派單緩存機制
 * [TECH-003] 實現分散式鎖防止重複派單
 * [TECH-004] 改用 Redis 存儲司機位置
 */
```

### 4. 性能優化建議

**資料庫優化**：

```sql
-- 定期執行（每月一次）
VACUUM ANALYZE orders;
VACUUM ANALYZE dispatch_logs;
REINDEX TABLE orders;

-- 檢查慢查詢
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

**程式碼優化**：

```typescript
// 使用連接池
// 使用 Redis 緩存熱數據
// 實現批次處理
// 使用 Worker Thread 處理密集運算
```

---

## 快速參考指令

```bash
# 數據分析
npx tsx scripts/weekly-report.ts              # 週報
npx tsx scripts/generate-mock-data.ts         # 生成測試數據
psql -d hualien_taxi < scripts/analysis.sql   # SQL 分析

# 系統測試
npx tsx test-dispatcher.ts                    # 派單引擎測試
curl http://localhost:3000/api/dispatch/stats # API 測試

# 系統維護
./restart.sh                                  # 重啟服務
pm2 logs --lines 100                          # 查看日誌
pm2 monit                                     # 即時監控

# 資料庫維護
psql -d hualien_taxi -c "VACUUM ANALYZE;"     # 優化資料庫
pg_dump hualien_taxi > backup.sql             # 備份資料庫
```

---

## 總結

### 核心原則

1. **數據驅動決策** - 所有優化都基於真實數據
2. **小步快跑** - 每次只調整一個參數，觀察效果
3. **持續監控** - 設立警報，及時發現問題
4. **漸進式優化** - 從簡單到複雜，不要過早優化

### 成功指標

經過 3 個月的持續優化，期望達到：

- ✅ 平均接單時間 < 30 秒
- ✅ 訂單完成率 > 90%
- ✅ 司機收入差距 < 15%
- ✅ 乘客滿意度 > 4.5/5.0
- ✅ 司機滿意度 > 4.5/5.0

---

*本指南會隨著系統演進持續更新*
*最後更新：2025年11月10日*
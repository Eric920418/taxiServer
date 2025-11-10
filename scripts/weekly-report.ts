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

  console.log('╔════════════════════════════════════════╗');
  console.log('║       📊 週報生成中...                 ║');
  console.log('╚════════════════════════════════════════╝\n');

  console.log(`期間：${lastWeek.toLocaleDateString()} 至 ${today.toLocaleDateString()}\n`);

  // 1. 總體訂單統計
  console.log('[1/6] 分析總體營運數據...');
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

  // 2. 新熱門路線
  console.log('[2/6] 分析熱門路線...');
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
    HAVING COUNT(*) >= 2
    ORDER BY trip_count DESC
    LIMIT 10
  `, [lastWeek, today]);

  // 3. 時段變化分析
  console.log('[3/6] 分析時段趨勢...');
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
  console.log('[4/6] 分析司機績效...');
  const driverPerformance = await pool.query(`
    SELECT
      d.driver_id,
      d.name,
      COUNT(o.order_id) as trips,
      COALESCE(SUM(o.meter_amount), 0) as earnings,
      ROUND(AVG(EXTRACT(EPOCH FROM (o.accepted_at - o.created_at)))) as avg_accept_sec,
      ROUND(d.acceptance_rate, 2) as acceptance_rate
    FROM drivers d
    LEFT JOIN orders o ON d.driver_id = o.driver_id
      AND o.status = 'DONE'
      AND o.created_at >= $1 AND o.created_at < $2
    GROUP BY d.driver_id, d.name, d.acceptance_rate
    ORDER BY trips DESC
  `, [lastWeek, today]);

  // 5. 派單效率
  console.log('[5/6] 分析派單效率...');
  const dispatchStats = await pool.query(`
    SELECT
      COUNT(*) as total_dispatches,
      ROUND(AVG(dispatch_score), 2) as avg_score,
      ROUND(AVG(predicted_eta)) as avg_predicted_eta
    FROM dispatch_logs
    WHERE created_at >= $1 AND created_at < $2
  `, [lastWeek, today]);

  // 6. 找出需要關注的區域
  console.log('[6/6] 識別改進機會...\n');
  const emergingZones = await pool.query(`
    SELECT
      pickup_address,
      COUNT(*) as order_count,
      ROUND(AVG(pickup_lat)::numeric, 6) as avg_lat,
      ROUND(AVG(pickup_lng)::numeric, 6) as avg_lng
    FROM orders
    WHERE created_at >= $1 AND created_at < $2
    GROUP BY pickup_address
    HAVING COUNT(*) >= 5
      AND pickup_address NOT IN ('東大門夜市', '花蓮火車站', '遠百花蓮店', '太魯閣國家公園')
    ORDER BY order_count DESC
    LIMIT 5
  `, [lastWeek, today]);

  const stats = orderStats.rows[0];
  const completionRate = stats.total_orders > 0
    ? (stats.completed / stats.total_orders * 100).toFixed(1)
    : '0.0';

  // 生成 Markdown 報告
  const report = `# 📊 週報 - ${lastWeek.toLocaleDateString()} 至 ${today.toLocaleDateString()}

## 一、總體營運數據

| 指標 | 數值 | 狀態 |
|------|------|------|
| 總訂單數 | ${stats.total_orders} | ${stats.total_orders > 50 ? '✅' : '⚠️'} |
| 完成訂單 | ${stats.completed} | - |
| 取消訂單 | ${stats.cancelled} | ${stats.cancelled < stats.total_orders * 0.15 ? '✅' : '⚠️'} |
| 完成率 | ${completionRate}% | ${parseFloat(completionRate) > 85 ? '✅ 優秀' : parseFloat(completionRate) > 75 ? '⚠️ 需改善' : '❌ 警戒'} |
| 總營收 | NT$${(stats.total_revenue || 0).toLocaleString()} | - |
| 平均車資 | NT$${stats.avg_fare || 0} | - |
| 平均距離 | ${stats.avg_distance || 0}km | - |

${hotRoutes.rows.length > 0 ? `
## 二、熱門路線 TOP ${hotRoutes.rows.length}

| 排名 | 起點 | 終點 | 次數 | 平均車資 | 平均時長 |
|------|------|------|------|----------|----------|
${hotRoutes.rows.map((r, i) =>
  `| ${i + 1} | ${r.pickup_address} | ${r.dest_address} | ${r.trip_count} | NT$${r.avg_fare} | ${r.avg_duration}分 |`
).join('\n')}
` : '\n## 二、熱門路線\n\n本週數據不足，無法分析熱門路線。\n'}

${hourlyTrends.rows.length > 0 ? `
## 三、黃金時段 TOP ${hourlyTrends.rows.length}

| 排名 | 時段 | 訂單量 | 營收 | 平均車資 |
|------|------|--------|------|----------|
${hourlyTrends.rows.map((r, i) =>
  `| ${i + 1} | ${r.hour_of_day}:00 | ${r.order_count} | NT$${r.revenue.toLocaleString()} | NT$${r.avg_fare} |`
).join('\n')}

### 💡 時段建議

${hourlyTrends.rows.length > 0 ? `- **最佳時段**：${hourlyTrends.rows[0].hour_of_day}:00（營收 NT$${hourlyTrends.rows[0].revenue.toLocaleString()}）` : ''}
${hourlyTrends.rows.length > 1 ? `- **次佳時段**：${hourlyTrends.rows[1].hour_of_day}:00（營收 NT$${hourlyTrends.rows[1].revenue.toLocaleString()}）` : ''}
` : '\n## 三、黃金時段\n\n本週數據不足，無法分析時段分布。\n'}

## 四、司機績效排行

| 排名 | 司機 | 完成訂單 | 總收入 | 平均接單時間 | 接單率 |
|------|------|----------|---------|--------------|--------|
${driverPerformance.rows.map((r, i) =>
  `| ${i + 1} | ${r.name} | ${r.trips || 0} | NT$${(r.earnings || 0).toLocaleString()} | ${r.avg_accept_sec || 0}秒 | ${r.acceptance_rate}% |`
).join('\n')}

### 📊 司機分析

${driverPerformance.rows.length > 0 ? `
- **收入冠軍**：${driverPerformance.rows[0].name}（NT$${driverPerformance.rows[0].earnings.toLocaleString()}）
- **訂單冠軍**：${driverPerformance.rows.reduce((max, r) => r.trips > max.trips ? r : max).name}（${driverPerformance.rows.reduce((max, r) => r.trips > max.trips ? r : max).trips}趟）
- **收入差距**：NT$${Math.max(...driverPerformance.rows.map(r => r.earnings)) - Math.min(...driverPerformance.rows.map(r => r.earnings))}
  ${Math.max(...driverPerformance.rows.map(r => r.earnings)) - Math.min(...driverPerformance.rows.map(r => r.earnings)) > Math.max(...driverPerformance.rows.map(r => r.earnings)) * 0.3 ? '⚠️ **需要加強收入平衡**' : '✅ 收入平衡良好'}
` : '- 本週無司機數據'}

${dispatchStats.rows[0]?.total_dispatches > 0 ? `
## 五、派單引擎效率

| 指標 | 數值 | 狀態 |
|------|------|------|
| 總派單次數 | ${dispatchStats.rows[0].total_dispatches} | - |
| 平均評分 | ${dispatchStats.rows[0].avg_score} 分 | ${dispatchStats.rows[0].avg_score > 60 ? '✅ 優秀' : dispatchStats.rows[0].avg_score > 45 ? '⚠️ 需改善' : '❌ 警戒'} |
| 平均預測 ETA | ${dispatchStats.rows[0].avg_predicted_eta} 分鐘 | ${dispatchStats.rows[0].avg_predicted_eta < 10 ? '✅' : '⚠️'} |
` : '\n## 五、派單引擎效率\n\n本週無派單記錄。\n'}

${emergingZones.rows.length > 0 ? `
## 六、新興熱點區域 🔥

以下區域訂單量顯著增加，建議考慮加入熱區配置：

| 區域 | 訂單量 | 經緯度 |
|------|--------|--------|
${emergingZones.rows.map(r =>
  `| ${r.pickup_address} | ${r.order_count} | (${r.avg_lat}, ${r.avg_lng}) |`
).join('\n')}

### 建議操作

\`\`\`typescript
// 在 src/services/ai-dispatcher.ts 中加入：
${emergingZones.rows.map(r => `
'${r.pickup_address}': {
  lat: ${r.avg_lat},
  lng: ${r.avg_lng},
  radius: 1,
  peakHours: [7, 8, 17, 18, 19], // 需根據實際數據調整
  weight: 1.2
}`).join(',\n')}
\`\`\`
` : ''}

## 七、本週優化建議

### ✅ 做得好的地方

${stats.total_orders > 0 ? `
${parseFloat(completionRate) > 85 ? '- ✅ 訂單完成率優秀' : ''}
${stats.cancelled < stats.total_orders * 0.1 ? '- ✅ 取消率控制良好' : ''}
${driverPerformance.rows.length > 0 && (Math.max(...driverPerformance.rows.map(r => r.earnings)) - Math.min(...driverPerformance.rows.map(r => r.earnings))) < Math.max(...driverPerformance.rows.map(r => r.earnings)) * 0.3 ? '- ✅ 司機收入平衡良好' : ''}
` : '- 本週訂單量不足，建議增加推廣力度'}

### ⚠️ 需要改善的地方

${parseFloat(completionRate) < 85 ? '- ⚠️ 訂單完成率偏低，需分析取消原因' : ''}
${stats.cancelled > stats.total_orders * 0.15 ? '- ⚠️ 取消率偏高，建議檢討派單策略' : ''}
${driverPerformance.rows.length > 0 && (Math.max(...driverPerformance.rows.map(r => r.earnings)) - Math.min(...driverPerformance.rows.map(r => r.earnings))) > Math.max(...driverPerformance.rows.map(r => r.earnings)) * 0.3 ? '- ⚠️ 司機收入差距過大，需加強平衡機制' : ''}
${dispatchStats.rows[0]?.avg_score < 60 ? '- ⚠️ 派單評分偏低，建議調整評分權重' : ''}

### 📝 行動清單

- [ ] 檢查並更新熱區配置（如有新興熱點）
- [ ] 檢視取消訂單原因並改善
- [ ] 調整派單參數以平衡司機收入
- [ ] 與表現優異的司機分享經驗

---

## 📈 趨勢對比

### 與上週對比

*(需要積累更多週數據後才能顯示趨勢)*

---

*報告生成時間：${new Date().toLocaleString()}*
*資料期間：${lastWeek.toLocaleDateString()} - ${today.toLocaleDateString()}*

---

## 📚 相關文檔

- [優化指南](../OPTIMIZATION-GUIDE.md)
- [數據分析報告](../data-analysis-report.md)
- [AI 派單指南](../AI-DISPATCHER-GUIDE.md)
`;

  // 儲存報告
  const reportsDir = 'reports';
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
  }

  const filename = `${reportsDir}/weekly-${today.toISOString().split('T')[0]}.md`;
  fs.writeFileSync(filename, report);

  console.log('═'.repeat(50));
  console.log(`✅ 週報已生成：${filename}`);
  console.log('═'.repeat(50));
  console.log('\n📊 報告預覽：\n');
  console.log(report);

  await pool.end();
}

// 執行
generateWeeklyReport().catch((error) => {
  console.error('❌ 生成週報時發生錯誤:', error);
  process.exit(1);
});
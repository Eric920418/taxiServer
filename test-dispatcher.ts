/**
 * 智能派單引擎測試腳本
 * 測試各種場景下的派單效果
 */

import axios from 'axios';
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const API_BASE = 'http://localhost:3000/api';
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'hualien_taxi',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// 測試場景定義
const testScenarios = [
  {
    name: '🌃 深夜長途訂單',
    order: {
      orderId: 'TEST-001',
      pickupLat: 23.9933, // 花蓮火車站
      pickupLng: 121.6011,
      destLat: 23.8911,   // 東華大學
      destLng: 121.5447,
      passengerId: 'PASS001',
      hour: 2 // 凌晨2點
    },
    expectedBehavior: '應選擇長距離專家型司機'
  },
  {
    name: '🍜 東大門夜市晚餐時段',
    order: {
      orderId: 'TEST-002',
      pickupLat: 23.9986, // 東大門夜市
      pickupLng: 121.6083,
      destLat: 23.9878,   // 遠百花蓮店
      destLng: 121.6061,
      passengerId: 'PASS002',
      hour: 19 // 晚上7點
    },
    expectedBehavior: '熱區加權 + 黃金時段優先'
  },
  {
    name: '🏥 醫院接駁短程',
    order: {
      orderId: 'TEST-003',
      pickupLat: 23.9953, // 花蓮慈濟醫院
      pickupLng: 121.5717,
      destLat: 23.9933,   // 花蓮火車站
      destLng: 121.6011,
      passengerId: 'PASS003',
      hour: 10 // 上午10點
    },
    expectedBehavior: '短程快速週轉型司機優先'
  },
  {
    name: '🏔️ 太魯閣觀光長程',
    order: {
      orderId: 'TEST-004',
      pickupLat: 24.1555, // 太魯閣國家公園
      pickupLng: 121.6207,
      destLat: 24.0377,   // 七星潭
      destLng: 121.6224,
      passengerId: 'PASS004',
      hour: 15 // 下午3點
    },
    expectedBehavior: '高單價路線，長距離專家優先'
  },
  {
    name: '🚆 早班通勤高峰',
    order: {
      orderId: 'TEST-005',
      pickupLat: 23.9944, // 中正路住宅區
      pickupLng: 121.6058,
      destLat: 23.9933,   // 花蓮火車站
      destLng: 121.6011,
      passengerId: 'PASS005',
      hour: 7 // 早上7點
    },
    expectedBehavior: '高峰時段，快速接單司機優先'
  }
];

// 設置司機位置（模擬不同位置的司機）
async function setupDrivers() {
  console.log('📍 設置司機位置...\n');

  const drivers = [
    { id: 'D001', lat: 23.9900, lng: 121.6000, status: 'AVAILABLE' }, // 靠近火車站
    { id: 'D002', lat: 23.9980, lng: 121.6080, status: 'AVAILABLE' }, // 靠近東大門
    { id: 'D003', lat: 23.9870, lng: 121.6060, status: 'AVAILABLE' }  // 靠近遠百
  ];

  for (const driver of drivers) {
    await pool.query(`
      UPDATE drivers
      SET current_lat = $1,
          current_lng = $2,
          availability = $3,
          last_heartbeat = NOW()
      WHERE driver_id = $4
    `, [driver.lat, driver.lng, driver.status, driver.id]);

    console.log(`   ✓ ${driver.id} 設置在 (${driver.lat}, ${driver.lng})`);
  }
  console.log();
}

// 執行測試
async function runTest(scenario: any) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`測試場景：${scenario.name}`);
  console.log(`期望行為：${scenario.expectedBehavior}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    // 調用智能派單API
    const response = await axios.post(`${API_BASE}/dispatch/smart`, scenario.order);

    if (response.data.success) {
      const result = response.data.data;

      console.log('📊 派單結果：');
      console.log(`   推薦司機：${result.recommendedDrivers.join(', ')}`);
      console.log(`   派單原因：${result.reason}`);
      console.log(`   預計到達：${result.predictedETA} 分鐘`);
      console.log(`   綜合評分：${result.score.toFixed(2)} 分`);

      return {
        success: true,
        result
      };
    } else {
      console.log('❌ 派單失敗：', response.data.error);
      return {
        success: false,
        error: response.data.error
      };
    }
  } catch (error: any) {
    console.log('❌ 測試失敗：', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// 測試收入平衡
async function testEarningsBalance() {
  console.log('\n' + '='.repeat(60));
  console.log('💰 測試收入平衡機制');
  console.log('='.repeat(60) + '\n');

  // 獲取當前司機收入
  const response = await axios.get(`${API_BASE}/dispatch/driver-earnings`);
  const earnings = response.data.data;

  console.log('當前司機收入狀況：');
  earnings.drivers.forEach((driver: any) => {
    const bar = '█'.repeat(Math.floor(driver.today_earnings / 500));
    console.log(`   ${driver.driver_id} ${driver.name}: ${bar} NT$${driver.today_earnings} (${driver.today_trips}趟)`);
  });

  console.log(`\n統計資料：`);
  console.log(`   平均收入：NT$${earnings.statistics.average}`);
  console.log(`   最高收入：NT$${earnings.statistics.maximum}`);
  console.log(`   最低收入：NT$${earnings.statistics.minimum}`);
  console.log(`   收入差距：NT$${earnings.statistics.gap}`);
}

// 測試熱區
async function testHotZones() {
  console.log('\n' + '='.repeat(60));
  console.log('🔥 測試熱區識別');
  console.log('='.repeat(60) + '\n');

  const response = await axios.get(`${API_BASE}/dispatch/hot-zones`);
  const data = response.data;

  console.log(`當前時間：${data.currentHour}:00`);
  console.log('活躍熱區：');

  if (data.hotZones.length > 0) {
    data.hotZones.forEach((zone: any) => {
      console.log(`   📍 ${zone.name} (權重：${zone.weight}x)`);
    });
  } else {
    console.log('   目前沒有活躍熱區');
  }
}

// 模擬批量派單
async function simulateDispatch() {
  console.log('\n' + '='.repeat(60));
  console.log('🚕 模擬批量派單（10筆）');
  console.log('='.repeat(60) + '\n');

  const response = await axios.post(`${API_BASE}/dispatch/simulate`, { count: 10 });

  if (response.data.success) {
    const results = response.data.results;
    let successCount = 0;

    results.forEach((r: any) => {
      if (r.result.recommendedDrivers.length > 0) {
        successCount++;
        console.log(`   ✓ ${r.orderId}: 派給 ${r.result.recommendedDrivers[0]} (${r.result.reason})`);
      } else {
        console.log(`   ✗ ${r.orderId}: 無可用司機`);
      }
    });

    console.log(`\n成功率：${(successCount / results.length * 100).toFixed(1)}%`);
  }
}

// 主測試流程
async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║     智能派單引擎 2.0 - 測試套件        ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  try {
    // 1. 設置司機位置
    await setupDrivers();

    // 2. 測試各種場景
    const results = [];
    for (const scenario of testScenarios) {
      const result = await runTest(scenario);
      results.push({
        scenario: scenario.name,
        ...result
      });

      // 等待1秒避免請求過快
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // 3. 測試收入平衡
    await testEarningsBalance();

    // 4. 測試熱區
    await testHotZones();

    // 5. 模擬批量派單
    await simulateDispatch();

    // 6. 總結報告
    console.log('\n' + '='.repeat(60));
    console.log('📈 測試總結');
    console.log('='.repeat(60) + '\n');

    const successCount = results.filter(r => r.success).length;
    console.log(`測試場景：${results.length} 個`);
    console.log(`成功派單：${successCount} 個`);
    console.log(`成功率：${(successCount / results.length * 100).toFixed(1)}%`);

    console.log('\n✅ 測試完成！');

  } catch (error: any) {
    console.error('測試過程發生錯誤:', error.message);
  } finally {
    await pool.end();
  }
}

// 執行測試
main();
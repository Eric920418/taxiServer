/**
 * 花蓮計程車系統 - 模擬數據生成器
 * 用途：生成符合真實使用模式的訂單數據，用於 AI 訓練
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'hualien_taxi',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// ============================================
// 花蓮真實地點資料庫
// ============================================

interface Location {
  name: string;
  lat: number;
  lng: number;
  type: 'station' | 'attraction' | 'hotel' | 'hospital' | 'shopping' | 'residential' | 'school';
  popularity: number; // 1-10，越高越熱門
}

const hualienLocations: Location[] = [
  // 交通樞紐
  { name: '花蓮火車站', lat: 23.9933, lng: 121.6011, type: 'station', popularity: 10 },
  { name: '花蓮機場', lat: 24.0232, lng: 121.6169, type: 'station', popularity: 8 },

  // 熱門景點
  { name: '東大門夜市', lat: 23.9986, lng: 121.6083, type: 'attraction', popularity: 10 },
  { name: '七星潭', lat: 24.0377, lng: 121.6224, type: 'attraction', popularity: 9 },
  { name: '太魯閣國家公園', lat: 24.1555, lng: 121.6207, type: 'attraction', popularity: 9 },
  { name: '松園別館', lat: 23.9944, lng: 121.6127, type: 'attraction', popularity: 7 },
  { name: '花蓮文化創意產業園區', lat: 23.9872, lng: 121.6042, type: 'attraction', popularity: 6 },

  // 飯店區域
  { name: '美侖飯店', lat: 23.9897, lng: 121.6127, type: 'hotel', popularity: 7 },
  { name: '福容大飯店', lat: 23.9922, lng: 121.6139, type: 'hotel', popularity: 8 },
  { name: '煙波大飯店', lat: 24.0042, lng: 121.6089, type: 'hotel', popularity: 8 },

  // 醫院
  { name: '花蓮慈濟醫院', lat: 23.9953, lng: 121.5717, type: 'hospital', popularity: 8 },
  { name: '門諾醫院', lat: 23.9889, lng: 121.6031, type: 'hospital', popularity: 7 },

  // 購物商圈
  { name: '遠百花蓮店', lat: 23.9878, lng: 121.6061, type: 'shopping', popularity: 8 },
  { name: '新天堂樂園', lat: 23.9878, lng: 121.6056, type: 'shopping', popularity: 7 },

  // 學校
  { name: '東華大學', lat: 23.8911, lng: 121.5447, type: 'school', popularity: 6 },
  { name: '花蓮高中', lat: 23.9839, lng: 121.6069, type: 'school', popularity: 5 },

  // 住宅區
  { name: '國聯一路住宅區', lat: 23.9903, lng: 121.6025, type: 'residential', popularity: 5 },
  { name: '中山路商業區', lat: 23.9861, lng: 121.6047, type: 'residential', popularity: 6 },
  { name: '中正路住宅區', lat: 23.9944, lng: 121.6058, type: 'residential', popularity: 5 },
  { name: '美崙市區', lat: 23.9931, lng: 121.6103, type: 'residential', popularity: 5 },
];

// ============================================
// 時段分布模型（符合真實使用習慣）
// ============================================

interface TimePattern {
  hour: number;
  weight: number; // 訂單量權重
  avgDistance: number; // 平均距離（公里）
}

const hourlyPatterns: TimePattern[] = [
  { hour: 0, weight: 0.3, avgDistance: 3 },
  { hour: 1, weight: 0.2, avgDistance: 3 },
  { hour: 2, weight: 0.1, avgDistance: 2 },
  { hour: 3, weight: 0.1, avgDistance: 2 },
  { hour: 4, weight: 0.2, avgDistance: 4 },
  { hour: 5, weight: 0.5, avgDistance: 5 },
  { hour: 6, weight: 1.2, avgDistance: 6 }, // 早班高峰
  { hour: 7, weight: 2.5, avgDistance: 8 }, // 上班高峰
  { hour: 8, weight: 2.0, avgDistance: 7 },
  { hour: 9, weight: 1.5, avgDistance: 5 },
  { hour: 10, weight: 1.3, avgDistance: 5 },
  { hour: 11, weight: 1.5, avgDistance: 6 },
  { hour: 12, weight: 1.8, avgDistance: 5 }, // 午餐時段
  { hour: 13, weight: 1.2, avgDistance: 5 },
  { hour: 14, weight: 1.0, avgDistance: 4 },
  { hour: 15, weight: 1.2, avgDistance: 5 },
  { hour: 16, weight: 1.5, avgDistance: 6 },
  { hour: 17, weight: 2.8, avgDistance: 8 }, // 下班高峰
  { hour: 18, weight: 3.0, avgDistance: 7 }, // 晚餐時段
  { hour: 19, weight: 2.5, avgDistance: 6 },
  { hour: 20, weight: 2.0, avgDistance: 5 },
  { hour: 21, weight: 1.8, avgDistance: 5 },
  { hour: 22, weight: 1.5, avgDistance: 4 },
  { hour: 23, weight: 0.8, avgDistance: 3 },
];

// ============================================
// 工具函數
// ============================================

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randomInt(min: number, max: number): number {
  return Math.floor(randomBetween(min, max + 1));
}

function randomChoice<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

function weightedRandomChoice<T>(items: T[], weights: number[]): T {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let random = Math.random() * totalWeight;

  for (let i = 0; i < items.length; i++) {
    random -= weights[i];
    if (random <= 0) {
      return items[i];
    }
  }

  return items[items.length - 1];
}

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // 地球半徑（公里）
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateFare(distanceKm: number): number {
  // 花蓮計程車費率：起跳 100元（1.5km），續跳 5元/200m
  const basePrice = 100;
  const baseDist = 1.5;

  if (distanceKm <= baseDist) {
    return basePrice;
  }

  const extraDist = distanceKm - baseDist;
  const extraPrice = Math.ceil(extraDist / 0.2) * 5;

  return basePrice + extraPrice;
}

// ============================================
// 生成訂單數據
// ============================================

interface MockOrder {
  orderId: string;
  passengerId: string;
  driverId: string;
  pickup: Location;
  destination: Location;
  createdAt: Date;
  acceptedAt: Date;
  arrivedAt: Date;
  startedAt: Date;
  completedAt: Date;
  status: string;
  meterAmount: number;
  actualDistanceKm: number;
  actualDurationMin: number;
}

async function generateMockOrders(count: number = 150): Promise<MockOrder[]> {
  const orders: MockOrder[] = [];
  const drivers = ['D001', 'D002', 'D003'];
  const now = new Date();

  // 生成過去 30 天的訂單
  const daysBack = 30;

  for (let i = 0; i < count; i++) {
    // 隨機選擇日期（過去30天）
    const daysAgo = randomBetween(0, daysBack);
    const orderDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);

    // 根據時段權重選擇小時
    const hour = weightedRandomChoice(
      hourlyPatterns.map(p => p.hour),
      hourlyPatterns.map(p => p.weight)
    );

    orderDate.setHours(hour, randomInt(0, 59), randomInt(0, 59));

    // 週末訂單量較多
    const dayOfWeek = orderDate.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    if (isWeekend && Math.random() < 0.3) {
      // 跳過一些平日訂單，增加週末比例
      continue;
    }

    // 選擇上車點（根據熱門度）
    const pickup = weightedRandomChoice(
      hualienLocations,
      hualienLocations.map(l => l.popularity)
    );

    // 選擇目的地（避免同一地點）
    let destination: Location;
    do {
      destination = weightedRandomChoice(
        hualienLocations,
        hualienLocations.map(l => l.popularity)
      );
    } while (destination.name === pickup.name);

    // 計算距離和時間
    const distanceKm = calculateDistance(
      pickup.lat, pickup.lng,
      destination.lat, destination.lng
    );

    // 預估時間：30km/h 平均速度
    const durationMin = Math.max(5, Math.round(distanceKm / 30 * 60));

    // 計算車資
    const fare = calculateFare(distanceKm);

    // 隨機選擇司機
    const driver = randomChoice(drivers);

    // 生成時間戳
    const createdAt = orderDate;
    const acceptedAt = new Date(createdAt.getTime() + randomInt(10, 120) * 1000); // 10秒-2分鐘接單
    const arrivedAt = new Date(acceptedAt.getTime() + randomInt(3, 15) * 60 * 1000); // 3-15分鐘到達
    const startedAt = new Date(arrivedAt.getTime() + randomInt(30, 180) * 1000); // 30秒-3分鐘上車
    const completedAt = new Date(startedAt.getTime() + durationMin * 60 * 1000);

    // 90% 完成率，5% 取消，5% 拒單
    const rand = Math.random();
    let status: string;
    let actualCompletedAt: Date | null = null;

    if (rand < 0.90) {
      status = 'DONE';
      actualCompletedAt = completedAt;
    } else if (rand < 0.95) {
      status = 'CANCELLED';
    } else {
      // 拒單的不加入（重新生成）
      i--;
      continue;
    }

    orders.push({
      orderId: `ORD${now.getTime()}${i.toString().padStart(4, '0')}`,
      passengerId: `PASS${randomInt(1, 20).toString().padStart(3, '0')}`,
      driverId: driver,
      pickup,
      destination,
      createdAt,
      acceptedAt,
      arrivedAt,
      startedAt,
      completedAt: actualCompletedAt || completedAt,
      status,
      meterAmount: status === 'DONE' ? fare : 0,
      actualDistanceKm: distanceKm,
      actualDurationMin: durationMin
    });
  }

  return orders.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

// ============================================
// 插入數據到資料庫
// ============================================

async function insertMockData() {
  console.log('============================================');
  console.log('  花蓮計程車系統 - 模擬數據生成器');
  console.log('============================================\n');

  try {
    // 1. 生成訂單數據
    console.log('[1/3] 生成模擬訂單數據...');
    const orders = await generateMockOrders(150);
    console.log(`✓ 已生成 ${orders.length} 筆訂單\n`);

    // 2. 插入到資料庫
    console.log('[2/3] 插入訂單到資料庫...');

    let insertedCount = 0;
    for (const order of orders) {
      try {
        await pool.query(`
          INSERT INTO orders (
            order_id, passenger_id, driver_id, status,
            pickup_lat, pickup_lng, pickup_address,
            dest_lat, dest_lng, dest_address,
            payment_type,
            meter_amount, actual_distance_km, actual_duration_min,
            created_at, offered_at, accepted_at, arrived_at, started_at, completed_at,
            hour_of_day, day_of_week
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7,
            $8, $9, $10,
            'CASH',
            $11, $12, $13,
            $14, $14, $15, $16, $17, $18,
            $19, $20
          )
          ON CONFLICT (order_id) DO NOTHING
        `, [
          order.orderId,
          order.passengerId,
          order.driverId,
          order.status,
          order.pickup.lat,
          order.pickup.lng,
          order.pickup.name,
          order.destination.lat,
          order.destination.lng,
          order.destination.name,
          order.meterAmount,
          order.actualDistanceKm,
          order.actualDurationMin,
          order.createdAt,
          order.acceptedAt,
          order.arrivedAt,
          order.startedAt,
          order.completedAt,
          order.createdAt.getHours(),
          order.createdAt.getDay()
        ]);

        insertedCount++;

        if (insertedCount % 10 === 0) {
          process.stdout.write(`  已插入 ${insertedCount}/${orders.length} 筆...\r`);
        }
      } catch (error: any) {
        // 跳過重複的訂單
        if (!error.message.includes('duplicate')) {
          console.error(`插入訂單 ${order.orderId} 失敗:`, error.message);
        }
      }
    }

    console.log(`\n✓ 成功插入 ${insertedCount} 筆訂單\n`);

    // 3. 統計報告
    console.log('[3/3] 生成統計報告...');

    const stats = await pool.query(`
      SELECT
        status,
        COUNT(*) as count,
        AVG(meter_amount)::int as avg_fare,
        AVG(actual_distance_km)::numeric(5,2) as avg_distance,
        AVG(actual_duration_min)::int as avg_duration
      FROM orders
      GROUP BY status
      ORDER BY count DESC
    `);

    console.log('\n訂單狀態統計:');
    console.log('─'.repeat(60));
    stats.rows.forEach(row => {
      console.log(`  ${row.status.padEnd(12)} | 數量: ${row.count.toString().padStart(3)} | 平均車資: NT$${row.avg_fare || 0} | 平均距離: ${row.avg_distance}km`);
    });

    const timeStats = await pool.query(`
      SELECT
        hour_of_day,
        COUNT(*) as count
      FROM orders
      GROUP BY hour_of_day
      ORDER BY hour_of_day
    `);

    console.log('\n時段分布統計:');
    console.log('─'.repeat(60));
    const hourBlocks = [
      { name: '深夜 (00-05)', hours: [0, 1, 2, 3, 4, 5] },
      { name: '早晨 (06-11)', hours: [6, 7, 8, 9, 10, 11] },
      { name: '午後 (12-17)', hours: [12, 13, 14, 15, 16, 17] },
      { name: '晚間 (18-23)', hours: [18, 19, 20, 21, 22, 23] }
    ];

    hourBlocks.forEach(block => {
      const count = timeStats.rows
        .filter(r => block.hours.includes(r.hour_of_day))
        .reduce((sum, r) => sum + parseInt(r.count), 0);
      console.log(`  ${block.name.padEnd(15)} | ${'█'.repeat(Math.floor(count / 5))} ${count} 筆`);
    });

    console.log('\n' + '='.repeat(60));
    console.log('✓ 模擬數據生成完成！');
    console.log('='.repeat(60));
    console.log('\n現在可以：');
    console.log('  1. 啟動 server:  pnpm dev');
    console.log('  2. 查詢訂單:     curl http://localhost:3000/api/orders');
    console.log('  3. 開始 AI 訓練！\n');

  } catch (error) {
    console.error('錯誤:', error);
  } finally {
    await pool.end();
  }
}

// 執行
insertMockData();

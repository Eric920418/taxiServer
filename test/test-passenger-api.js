/**
 * 測試乘客端 API 和 WebSocket 功能
 */

const axios = require('axios');
const io = require('socket.io-client');

const BASE_URL = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000';

// 顏色輸出
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testPassengerLogin() {
  log('\n[測試 1] 乘客登錄/註冊 (Firebase Phone Auth)', 'blue');
  try {
    // 模擬 Firebase UID（實際應用中，這個 UID 由 Firebase SDK 在前端生成）
    const mockFirebaseUid = `test_firebase_uid_${Date.now()}`;

    const response = await axios.post(`${BASE_URL}/api/auth/phone-verify-passenger`, {
      phone: '0922222222',
      firebaseUid: mockFirebaseUid,
      name: '測試乘客B'
    });

    if (response.data.success && response.data.passengerId) {
      const passenger = {
        passengerId: response.data.passengerId,
        phone: response.data.phone,
        name: response.data.name,
        totalRides: response.data.totalRides,
        rating: response.data.rating
      };
      log(`✓ 登錄成功: ${passenger.passengerId} - ${passenger.name}`, 'green');
      return passenger;
    } else {
      throw new Error('登錄失敗');
    }
  } catch (error) {
    log(`✗ 登錄失敗: ${error.response?.data?.message || error.message}`, 'red');
    return null;
  }
}

async function testNearbyDrivers() {
  log('\n[測試 2] 查詢附近司機', 'blue');
  try {
    const response = await axios.get(`${BASE_URL}/api/passengers/nearby-drivers`, {
      params: {
        lat: 23.9871,
        lng: 121.6015,
        radius: 5000
      }
    });

    if (response.data.success) {
      log(`✓ 查詢成功，找到 ${response.data.count} 位司機`, 'green');
      response.data.drivers.forEach(driver => {
        log(`  - ${driver.name} (${driver.driverId}), 距離: ${driver.distance}m, 評分: ${driver.rating}`, 'yellow');
      });
      return true;
    } else {
      throw new Error('查詢失敗');
    }
  } catch (error) {
    log(`✗ 查詢失敗: ${error.message}`, 'red');
    return false;
  }
}

async function testRequestRide(passenger) {
  log('\n[測試 3] 創建叫車訂單', 'blue');
  try {
    const response = await axios.post(`${BASE_URL}/api/passengers/request-ride`, {
      passengerId: passenger.passengerId,
      passengerName: passenger.name,
      passengerPhone: passenger.phone,
      pickupLat: 23.9871,
      pickupLng: 121.6015,
      pickupAddress: '花蓮火車站',
      destLat: 23.9950,
      destLng: 121.6100,
      destAddress: '花蓮東大門夜市',
      paymentType: 'CASH'
    });

    if (response.data.success && response.data.order) {
      const order = response.data.order;
      log(`✓ 叫車成功`, 'green');
      log(`  訂單ID: ${order.orderId}`, 'yellow');
      log(`  狀態: ${order.status}`, 'yellow');
      log(`  上車點: ${order.pickup.address}`, 'yellow');
      log(`  目的地: ${order.destination ? order.destination.address : '未設定'}`, 'yellow');
      log(`  推送給 ${response.data.offeredTo.length} 位司機`, 'yellow');
      return order;
    } else {
      throw new Error('叫車失敗');
    }
  } catch (error) {
    log(`✗ 叫車失敗: ${error.message}`, 'red');
    return null;
  }
}

async function testCancelOrder(passenger, order) {
  log('\n[測試 4] 取消訂單', 'blue');
  try {
    const response = await axios.post(`${BASE_URL}/api/passengers/cancel-order`, {
      orderId: order.orderId,
      passengerId: passenger.passengerId,
      reason: '測試取消'
    });

    if (response.data.success) {
      log(`✓ 訂單取消成功: ${response.data.message}`, 'green');
      return true;
    } else {
      throw new Error('取消失敗');
    }
  } catch (error) {
    log(`✗ 取消失敗: ${error.message}`, 'red');
    return false;
  }
}

async function testWebSocket(passenger) {
  log('\n[測試 5] WebSocket 連接和實時功能', 'blue');

  return new Promise((resolve) => {
    const socket = io(WS_URL, {
      reconnection: false,
      timeout: 5000
    });

    let testsCompleted = 0;
    const totalTests = 2;

    socket.on('connect', () => {
      log('✓ WebSocket 連接成功', 'green');

      // 乘客上線
      socket.emit('passenger:online', {
        passengerId: passenger.passengerId
      });
      log('  發送 passenger:online 事件', 'yellow');
    });

    // 監聽附近司機
    socket.on('nearby:drivers', (drivers) => {
      log(`✓ 收到附近司機推送: ${drivers.length} 位司機`, 'green');
      drivers.forEach(driver => {
        log(`  - 司機 ${driver.driverId} at (${driver.location.lat}, ${driver.location.lng})`, 'yellow');
      });
      testsCompleted++;
      if (testsCompleted >= totalTests) {
        socket.disconnect();
        resolve(true);
      }
    });

    // 監聽訂單更新
    socket.on('order:update', (order) => {
      log(`✓ 收到訂單更新: ${order.orderId} -> ${order.status}`, 'green');
      testsCompleted++;
      if (testsCompleted >= totalTests) {
        socket.disconnect();
        resolve(true);
      }
    });

    socket.on('connect_error', (error) => {
      log(`✗ WebSocket 連接錯誤: ${error.message}`, 'red');
      resolve(false);
    });

    socket.on('disconnect', () => {
      log('  WebSocket 已斷開', 'yellow');
    });

    // 5秒後自動結束測試
    setTimeout(() => {
      if (testsCompleted === 0) {
        log('✗ WebSocket 測試超時（可能沒有在線司機）', 'yellow');
      }
      socket.disconnect();
      resolve(testsCompleted > 0);
    }, 5000);
  });
}

async function runAllTests() {
  log('='.repeat(60), 'blue');
  log('開始測試乘客端 API 和 WebSocket 功能', 'blue');
  log('='.repeat(60), 'blue');

  const results = {
    passed: 0,
    failed: 0
  };

  // 測試 1: 登錄
  const passenger = await testPassengerLogin();
  if (passenger) {
    results.passed++;
  } else {
    results.failed++;
    log('\n測試中止：無法登錄', 'red');
    return;
  }

  // 測試 2: 查詢附近司機
  const nearbyDriversOk = await testNearbyDrivers();
  if (nearbyDriversOk) {
    results.passed++;
  } else {
    results.failed++;
  }

  // 測試 3: 叫車
  const order = await testRequestRide(passenger);
  if (order) {
    results.passed++;
  } else {
    results.failed++;
  }

  // 測試 4: 取消訂單
  if (order) {
    const cancelOk = await testCancelOrder(passenger, order);
    if (cancelOk) {
      results.passed++;
    } else {
      results.failed++;
    }
  }

  // 測試 5: WebSocket
  const wsOk = await testWebSocket(passenger);
  if (wsOk) {
    results.passed++;
  } else {
    results.failed++;
  }

  // 測試總結
  log('\n' + '='.repeat(60), 'blue');
  log('測試總結', 'blue');
  log('='.repeat(60), 'blue');
  log(`通過: ${results.passed}`, 'green');
  log(`失敗: ${results.failed}`, results.failed > 0 ? 'red' : 'green');
  log(`總計: ${results.passed + results.failed}`, 'yellow');
  log('='.repeat(60), 'blue');
}

// 執行測試
runAllTests().catch(error => {
  log(`測試執行錯誤: ${error.message}`, 'red');
  process.exit(1);
});

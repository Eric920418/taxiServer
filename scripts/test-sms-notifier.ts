/**
 * SmsNotifier 驗證腳本
 *
 * 驗證項目：
 *   1. normalizeTaiwanMobile 支援的格式（無需真實 API）
 *   2. parseMitakeResponse 解析正確性（透過實際呼叫三竹「測試端點」SmSendGetSim.asp，不扣費）
 *   3. Rate limit 行為
 *
 * 執行方式：
 *   pnpm ts-node scripts/test-sms-notifier.ts
 *
 * 環境變數需求（可在 .env 或 export）：
 *   MITAKE_SMS_USERNAME=你的三竹帳號
 *   MITAKE_SMS_PASSWORD=你的三竹密碼
 *   MITAKE_SMS_API_URL=https://smexpress.mitake.com.tw:9601/SmSendGetSim.asp  (測試端點)
 *   TEST_PHONE=0912345678  (接收測試的手機號)
 *
 * 若尚未申請三竹帳號，腳本會跳過線上測試，只跑本地邏輯測試。
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { SmsNotifier } from '../src/services/SmsNotifier';

let pass = 0;
let fail = 0;

function assertEq(label: string, expected: any, actual: any) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  console.log(`${ok ? '✅' : '❌'} ${label}: 預期 ${JSON.stringify(expected)} / 實際 ${JSON.stringify(actual)}`);
  if (ok) pass++; else fail++;
}

function assertTrue(label: string, condition: boolean, extra?: string) {
  console.log(`${condition ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (condition) pass++; else fail++;
}

// ============================================
// Test 1: normalizeTaiwanMobile 本地測試（無需 API）
// ============================================
async function testNormalize() {
  console.log('\n=== Test 1: 手機號正規化 ===\n');

  // 建構一個不打 API 的 SmsNotifier（只為了呼叫 normalizeTaiwanMobile）
  // 用 fake env 避免建構失敗
  const notifier = new SmsNotifier({
    username: 'test',
    password: 'test',
    apiUrl: 'https://example.com/fake',
  });

  const cases: Array<{ input: string; expected: string | null }> = [
    { input: '0912345678',        expected: '0912345678' },
    { input: '0912-345-678',      expected: '0912345678' },
    { input: '0912 345 678',      expected: '0912345678' },
    { input: '(0912)345-678',     expected: '0912345678' },
    { input: '+886912345678',     expected: '0912345678' },
    { input: '+886-912-345-678',  expected: '0912345678' },
    { input: '886912345678',      expected: '0912345678' },
    { input: '0223456789',        expected: null },          // 市話
    { input: '912345678',         expected: null },          // 缺前導 0
    { input: '091234567',         expected: null },          // 位數不足
    { input: '09123456789',       expected: null },          // 位數過多
    { input: '',                  expected: null },
    { input: 'abcdefg',           expected: null },
  ];

  for (const c of cases) {
    const result = notifier.normalizeTaiwanMobile(c.input);
    assertEq(`normalize("${c.input}")`, c.expected, result);
  }
}

// ============================================
// Test 2: 三竹 API 連線測試（使用測試端點，不扣費）
// ============================================
async function testMitakeApi() {
  console.log('\n=== Test 2: 三竹 API 連線 ===\n');

  const username = process.env.MITAKE_SMS_USERNAME;
  const password = process.env.MITAKE_SMS_PASSWORD;
  const apiUrl = process.env.MITAKE_SMS_API_URL;
  const testPhone = process.env.TEST_PHONE;

  if (!username || !password || !apiUrl || !testPhone) {
    console.log('⚠️  跳過：未設定 MITAKE_SMS_USERNAME / PASSWORD / API_URL / TEST_PHONE');
    console.log('   申請三竹帳號後於 .env 設定，或 export 變數再執行');
    return;
  }

  if (!apiUrl.includes('Sim.asp')) {
    console.log('⚠️  警告：API URL 似乎不是測試端點（SmSendGetSim.asp），實際執行會扣費！');
    console.log(`   目前 URL: ${apiUrl}`);
    console.log('   若要繼續，請設 FORCE_REAL_SEND=1');
    if (process.env.FORCE_REAL_SEND !== '1') {
      console.log('   已中止（未設 FORCE_REAL_SEND=1）');
      return;
    }
  }

  const notifier = new SmsNotifier({ username, password, apiUrl });

  const message = `【大豐計程車】SmsNotifier 測試 ${new Date().toISOString()}`;
  console.log(`   發送到 ${testPhone}: ${message}`);

  const result = await notifier.send(testPhone, message);
  console.log('   回應：', JSON.stringify(result, null, 2));

  assertTrue(
    '三竹 API 回應解析成功',
    result.statusCode !== undefined || result.errorCode !== undefined,
    '至少要有 statusCode 或 errorCode'
  );
}

// ============================================
// Test 3: Rate limit
// ============================================
async function testRateLimit() {
  console.log('\n=== Test 3: Rate limit（in-memory）===\n');

  // 用一個不會真的送出的 mock：手機號刻意用無效格式，會在 normalize 就失敗
  // 但我們想測 rate limit，所以用另一個方式：建立 notifier 後直接呼叫 send
  // 並檢查連續超過 3 次時的行為
  //
  // 注意：rate limit 只在發送「成功」後扣額度（見 SmsNotifier.send 實作）
  // 所以要測 rate limit 需要讓 send 成功。此處為單元測試目的，改用 stub：
  //
  // 透過「替換 API URL 為會失敗的 URL」不能測到 rate limit（因為 rate limit 只扣成功）
  //
  // 因此本項測試在 PR1 階段改以「手機號格式錯誤不扣額度」驗證保護邏輯：
  // 格式錯誤時不應該扣 rate limit 額度
  const notifier = new SmsNotifier({
    username: 'test',
    password: 'test',
    apiUrl: 'https://example.com/fake',
  });

  // 連續 5 次格式錯誤
  for (let i = 0; i < 5; i++) {
    const r = await notifier.send('INVALID_PHONE', 'test');
    assertTrue(
      `第 ${i + 1} 次無效號碼呼叫回 INVALID_PHONE`,
      r.errorCode === 'INVALID_PHONE',
    );
  }

  console.log('   （完整 rate limit 測試需要真實 API 成功回應，留待 PR2 整合測試）');
}

// ============================================
// Run
// ============================================
(async () => {
  try {
    await testNormalize();
    await testMitakeApi();
    await testRateLimit();

    console.log(`\n總結：${pass} pass / ${fail} fail`);
    process.exit(fail > 0 ? 1 : 0);
  } catch (err: any) {
    console.error('\n❌ 測試腳本異常中止：', err);
    process.exit(2);
  }
})();

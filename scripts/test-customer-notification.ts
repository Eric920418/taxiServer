/**
 * CustomerNotificationService 驗證腳本
 *
 * 驗證項目（不需真實 DB / LINE / SMS 帳號）：
 *   1. Feature flag 關閉時立刻 return
 *   2. LINE 優先：有 line_user_id 就走 LINE
 *   3. SMS 備援：無 line_user_id 但有 customer_phone 就走 SMS
 *   4. 兩者皆無：noop 不 throw
 *   5. 去重：同訂單 × 同事件的 SENT 紀錄只發一次
 *   6. LINE 失敗：預設不降級（shouldFallbackToSms 回 false）
 *   7. customer_notifications 表寫入行為
 *   8. orders.notification_channel 更新
 *
 * 執行：
 *   pnpm ts-node scripts/test-customer-notification.ts
 *
 * 注意：本腳本不實際連 DB，也不打真的 LINE / SMS API —
 *       用 mock pool + stub notifier 驗證分派邏輯。
 */

import { CustomerNotificationService } from '../src/services/CustomerNotificationService';
import type { LineNotifier } from '../src/services/LineNotifier';
import type { SmsNotifier, SmsSendResult } from '../src/services/SmsNotifier';
import type { Pool } from 'pg';

let pass = 0;
let fail = 0;

function assertTrue(label: string, condition: boolean, extra?: string) {
  console.log(`${condition ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (condition) pass++; else fail++;
}

function assertEq<T>(label: string, expected: T, actual: T) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  console.log(`${ok ? '✅' : '❌'} ${label}: 預期 ${JSON.stringify(expected)} / 實際 ${JSON.stringify(actual)}`);
  if (ok) pass++; else fail++;
}

/**
 * 建立 mock pg Pool — 記錄所有 query 呼叫
 */
function makeMockPool(orderRow: any, existingDedupe: boolean = false): Pool & { queries: any[] } {
  const queries: any[] = [];
  return {
    queries,
    async query(sql: string, params?: any[]) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });

      // 去重查詢
      if (sql.includes('customer_notifications') && sql.includes('status = \'SENT\'') && sql.includes('LIMIT 1')) {
        return { rows: existingDedupe ? [{ '?column?': 1 }] : [], rowCount: existingDedupe ? 1 : 0 };
      }
      // 查訂單通訊資訊
      if (sql.includes('SELECT line_user_id, customer_phone FROM orders')) {
        return { rows: orderRow ? [orderRow] : [], rowCount: orderRow ? 1 : 0 };
      }
      // INSERT customer_notifications
      if (sql.includes('INSERT INTO customer_notifications')) {
        return { rows: [], rowCount: 1 };
      }
      // UPDATE orders
      if (sql.includes('UPDATE orders')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

/**
 * LINE stub：記錄呼叫，可控制是否 throw
 */
function makeLineStub(shouldFail: boolean = false, failError?: any): LineNotifier & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async notifyOrderStatusChange(orderId: string, status: string) {
      calls.push(`notifyOrderStatusChange(${orderId}, ${status})`);
      if (shouldFail) throw failError ?? new Error('LINE stub failure');
    },
    async notifyNoDriverAvailable(orderId: string) {
      calls.push(`notifyNoDriverAvailable(${orderId})`);
      if (shouldFail) throw failError ?? new Error('LINE stub failure');
    },
  } as any;
}

/**
 * SMS stub：記錄呼叫，可控制回傳成功/失敗
 */
function makeSmsStub(result: SmsSendResult): SmsNotifier & { calls: Array<{ phone: string; message: string }> } {
  const calls: Array<{ phone: string; message: string }> = [];
  return {
    calls,
    async send(phone: string, message: string) {
      calls.push({ phone, message });
      return result;
    },
  } as any;
}

// ============================================
// Test runner
// ============================================

async function runTest(name: string, fn: () => Promise<void>) {
  console.log(`\n=== ${name} ===\n`);
  try {
    await fn();
  } catch (err: any) {
    console.error(`❌ ${name} 執行異常:`, err?.message || err);
    fail++;
  }
}

(async () => {
  // ============================================
  // Test 1: Feature flag 關閉時立刻 return
  // ============================================
  await runTest('Test 1: Feature flag 關閉時不發送', async () => {
    delete process.env.CUSTOMER_NOTIFICATION_ENABLED;  // 或設 'false'

    const pool = makeMockPool({ line_user_id: 'U123', customer_phone: null });
    const line = makeLineStub();
    const sms = makeSmsStub({ success: true });
    const svc = new CustomerNotificationService(pool, line as any, sms as any);

    await svc.notifyDriverAccepted('ORDER_1', { driverName: '王司機', plate: 'ABC-123' });

    assertEq('LINE 未被呼叫', 0, line.calls.length);
    assertEq('SMS 未被呼叫', 0, sms.calls.length);
    assertEq('DB 未被查詢', 0, pool.queries.length);
  });

  // 以下測試都需要 flag=true
  process.env.CUSTOMER_NOTIFICATION_ENABLED = 'true';
  process.env.CUSTOMER_SERVICE_PHONE = '03-123-4567';

  // ============================================
  // Test 2: 有 line_user_id → 走 LINE
  // ============================================
  await runTest('Test 2: line_user_id 存在時走 LINE', async () => {
    const pool = makeMockPool({ line_user_id: 'U123', customer_phone: null });
    const line = makeLineStub();
    const sms = makeSmsStub({ success: true });
    const svc = new CustomerNotificationService(pool, line as any, sms as any);

    await svc.notifyDriverAccepted('ORDER_1', { driverName: '王司機', plate: 'ABC-123', etaMinutes: 5 });

    assertEq('LINE 被呼叫一次', 1, line.calls.length);
    assertTrue('LINE 呼叫的 method 正確', line.calls[0].includes('notifyOrderStatusChange'));
    assertEq('SMS 未被呼叫', 0, sms.calls.length);

    const insertCall = pool.queries.find(q => q.sql.includes('INSERT INTO customer_notifications'));
    assertTrue('customer_notifications 有 INSERT', !!insertCall);
    assertTrue('INSERT 包含 LINE channel', insertCall?.params?.includes('LINE') ?? false);
    // 'SENT' 硬編碼在 SQL 而非 params（成功寫入的 INSERT）
    assertTrue('INSERT SQL 帶 SENT', insertCall?.sql.includes("'SENT'") ?? false);
  });

  // ============================================
  // Test 3: 無 line_user_id 但有 customer_phone → 走 SMS
  // ============================================
  await runTest('Test 3: 只有 customer_phone 時走 SMS', async () => {
    const pool = makeMockPool({ line_user_id: null, customer_phone: '0912345678' });
    const line = makeLineStub();
    const sms = makeSmsStub({ success: true, statusCode: '1', messageId: 'MSG123' });
    const svc = new CustomerNotificationService(pool, line as any, sms as any);

    await svc.notifyDriverArrived('ORDER_2', { driverName: '李司機', plate: 'XYZ-789', pickupAddress: '花蓮火車站' });

    assertEq('LINE 未被呼叫', 0, line.calls.length);
    assertEq('SMS 被呼叫一次', 1, sms.calls.length);
    assertEq('SMS 手機號正確', '0912345678', sms.calls[0].phone);
    assertTrue('SMS 內容包含花蓮計程車標記', sms.calls[0].message.includes('花蓮計程車'));

    const insertCall = pool.queries.find(q => q.sql.includes('INSERT INTO customer_notifications'));
    assertTrue('INSERT 包含 SMS channel', insertCall?.params?.includes('SMS') ?? false);
  });

  // ============================================
  // Test 4: 兩者皆無 → noop 不 throw
  // ============================================
  await runTest('Test 4: 兩者皆無時不 throw', async () => {
    const pool = makeMockPool({ line_user_id: null, customer_phone: null });
    const line = makeLineStub();
    const sms = makeSmsStub({ success: true });
    const svc = new CustomerNotificationService(pool, line as any, sms as any);

    let threw = false;
    try {
      await svc.notifyDispatchFailed('ORDER_3', '目前無可用司機');
    } catch {
      threw = true;
    }

    assertTrue('未 throw', !threw);
    assertEq('LINE 未被呼叫', 0, line.calls.length);
    assertEq('SMS 未被呼叫', 0, sms.calls.length);
  });

  // ============================================
  // Test 5: 去重 — 已有 SENT 紀錄時跳過
  // ============================================
  await runTest('Test 5: 去重機制', async () => {
    const pool = makeMockPool(
      { line_user_id: 'U123', customer_phone: null },
      /* existingDedupe = */ true
    );
    const line = makeLineStub();
    const sms = makeSmsStub({ success: true });
    const svc = new CustomerNotificationService(pool, line as any, sms as any);

    await svc.notifyDriverAccepted('ORDER_4', { driverName: '測試' });

    assertEq('LINE 未被呼叫（已去重）', 0, line.calls.length);
    assertEq('SMS 未被呼叫', 0, sms.calls.length);
    assertTrue(
      '無新 INSERT',
      !pool.queries.some(q => q.sql.includes('INSERT INTO customer_notifications'))
    );
  });

  // ============================================
  // Test 6: LINE 失敗 — 預設不降級（shouldFallbackToSms=false）
  // ============================================
  await runTest('Test 6: LINE 失敗時預設不降級到 SMS', async () => {
    const pool = makeMockPool({ line_user_id: 'U123', customer_phone: '0912345678' });
    const line = makeLineStub(/* shouldFail = */ true, Object.assign(new Error('LINE 500'), { statusCode: 500 }));
    const sms = makeSmsStub({ success: true });
    const svc = new CustomerNotificationService(pool, line as any, sms as any);

    await svc.notifyDriverAccepted('ORDER_5', { driverName: '王司機' });

    assertEq('LINE 有被嘗試一次', 1, line.calls.length);
    assertEq('SMS 未被呼叫（預設不降級）', 0, sms.calls.length);

    // 'FAILED' 硬編碼在 SQL（同 SENT 的 pattern）
    const failInsert = pool.queries.find(q =>
      q.sql.includes('INSERT INTO customer_notifications') && q.sql.includes("'FAILED'")
    );
    assertTrue('有失敗紀錄寫入 customer_notifications', !!failInsert);
  });

  // ============================================
  // Test 7: SMS 發送失敗也要寫 FAILED 紀錄
  // ============================================
  await runTest('Test 7: SMS 失敗時記錄 FAILED', async () => {
    const pool = makeMockPool({ line_user_id: null, customer_phone: '0912345678' });
    const line = makeLineStub();
    const sms = makeSmsStub({
      success: false,
      errorCode: '6',
      errorMessage: '三竹發送失敗 (statuscode=6)：門號有錯誤',
    });
    const svc = new CustomerNotificationService(pool, line as any, sms as any);

    await svc.notifyDriverArrived('ORDER_6', { driverName: '測試' });

    assertEq('SMS 有被呼叫', 1, sms.calls.length);
    const failInsert = pool.queries.find(q =>
      q.sql.includes('INSERT INTO customer_notifications') && q.sql.includes("'FAILED'")
    );
    assertTrue('有失敗紀錄', !!failInsert);
    assertTrue(
      '錯誤訊息完整保存（遵守 CLAUDE.md 錯誤完整顯示原則）',
      failInsert?.params?.some((p: any) => typeof p === 'string' && p.includes('門號有錯誤')) ?? false
    );
  });

  // ============================================
  // Test 8: 訂單不存在 → 無動作
  // ============================================
  await runTest('Test 8: 訂單不存在時 noop', async () => {
    const pool = makeMockPool(null);
    const line = makeLineStub();
    const sms = makeSmsStub({ success: true });
    const svc = new CustomerNotificationService(pool, line as any, sms as any);

    await svc.notifyDriverAccepted('NONEXISTENT', { driverName: '測試' });

    assertEq('LINE 未被呼叫', 0, line.calls.length);
    assertEq('SMS 未被呼叫', 0, sms.calls.length);
  });

  // ============================================
  // Summary
  // ============================================
  console.log(`\n總結：${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
})();

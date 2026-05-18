/**
 * FcmService - 司機端 FCM 推播（背景接單通道）
 *
 * 訂單派發 / 取消雙通道：
 *   - Socket.io   前景即時（App 開著）
 *   - FCM         背景叫醒（App 切背景 / 螢幕關 / Doze mode）
 *
 * Data-only message（不含 notification field）：
 *   - 強迫 TaxiFirebaseMessagingService.onMessageReceived 跑，由 App 自己渲染 system notification
 *   - App killed 時 FCM 自動拉起 service
 *
 * 失效 token 自動清掉 (UNREGISTERED / INVALID_REGISTRATION_TOKEN)
 */

import * as admin from 'firebase-admin';
import { Pool } from 'pg';
import fs from 'fs';

export class FcmService {
  private pool: Pool;
  private app: admin.app.App | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
    const credPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (!credPath) {
      console.warn('[FCM] FIREBASE_SERVICE_ACCOUNT_PATH not set; FCM push disabled (司機背景時收不到訂單)');
      return;
    }
    if (!fs.existsSync(credPath)) {
      console.warn(`[FCM] credentials 不存在 ${credPath}; FCM push disabled`);
      return;
    }
    try {
      this.app = admin.initializeApp(
        { credential: admin.credential.cert(credPath) },
        'gogocha-fcm'
      );
      console.log('[FCM] initialized for project', this.app.options.projectId);
    } catch (e: any) {
      console.error('[FCM] init 失敗:', e.message);
    }
  }

  /**
   * 司機收到新訂單通知（data-only message，背景也會跳系統 notification）
   */
  async sendNewOrderToDriver(driverId: string, order: {
    orderId: string;
    passengerName: string;
    passengerPhone?: string;
    pickup: string;
  }): Promise<void> {
    if (!this.app) return;
    const token = await this.getToken(driverId);
    if (!token) return;
    try {
      await this.app.messaging().send({
        token,
        data: {
          type: 'new_order',
          title: '新訂單！',
          body: `${order.passengerName} 在 ${order.pickup} 叫車`,
          orderId: order.orderId,
          passengerName: order.passengerName,
          passengerPhone: order.passengerPhone ?? '',
          pickup: order.pickup,
        },
        android: { priority: 'high' as const },
        apns: { headers: { 'apns-priority': '10' } },
      });
      console.log(`[FCM] new_order → ${driverId}`);
    } catch (e: any) {
      await this.handleSendError(driverId, e);
    }
  }

  /**
   * 司機收到訂單取消通知
   */
  async sendOrderCancelledToDriver(
    driverId: string,
    orderId: string,
    reason?: string,
  ): Promise<void> {
    if (!this.app) return;
    const token = await this.getToken(driverId);
    if (!token) return;
    try {
      await this.app.messaging().send({
        token,
        data: {
          type: 'order_cancelled',
          title: '訂單已取消',
          body: reason || '乘客已取消訂單',
          orderId,
        },
        android: { priority: 'high' as const },
      });
      console.log(`[FCM] order_cancelled → ${driverId}`);
    } catch (e: any) {
      await this.handleSendError(driverId, e);
    }
  }

  private async getToken(driverId: string): Promise<string | null> {
    const r = await this.pool.query<{ fcm_token: string | null }>(
      'SELECT fcm_token FROM drivers WHERE driver_id = $1',
      [driverId]
    );
    return r.rows[0]?.fcm_token ?? null;
  }

  private async handleSendError(driverId: string, err: any): Promise<void> {
    const code = err.code || err.errorInfo?.code || '';
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-argument' ||
      code === 'messaging/invalid-registration-token'
    ) {
      await this.pool.query(
        'UPDATE drivers SET fcm_token = NULL, fcm_updated_at = NOW() WHERE driver_id = $1',
        [driverId]
      );
      console.warn(`[FCM] cleared invalid token for ${driverId} (${code})`);
    } else {
      console.error(`[FCM] send error for ${driverId}:`, code, err.message);
    }
  }
}

let instance: FcmService | null = null;
export function initFcmService(pool: Pool): FcmService {
  if (!instance) instance = new FcmService(pool);
  return instance;
}
export function getFcmService(): FcmService | null {
  return instance;
}

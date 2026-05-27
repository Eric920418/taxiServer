/**
 * SOSService — 模組 5：長輩失聯時通知家屬
 *
 * 觸發時機：cancel-no-show endpoint 成功取消後（不管司機立即取消或 5min 自動）
 * Rate limit：同一家屬 24h 最多收到 1 次 SOS（避免被轟）
 */

import { Pool } from 'pg';
import { messagingApi } from '@line/bot-sdk';
import { familyNoShowAlertCard } from './LineFlexTemplates';

const SOS_RATE_LIMIT_HOURS = 24;

export class SOSService {
  private pool: Pool;
  private lineClient: messagingApi.MessagingApiClient;

  constructor(pool: Pool) {
    this.pool = pool;
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN 是必要的');
    this.lineClient = new messagingApi.MessagingApiClient({ channelAccessToken: token });
  }

  /**
   * 主入口：no-show 取消後通知家屬
   * 失敗不擋主流程（呼叫端 catch + log 即可）
   */
  async pushNoShowAlertToFamilies(orderId: string): Promise<void> {
    try {
      // 1. 拿 order 完整資料 + 長輩名 + 司機資訊
      const order = await this.pool.query(
        `SELECT o.order_id, o.passenger_id, o.pickup_address, o.created_at,
                p.name AS passenger_name, p.phone AS passenger_phone,
                d.name AS driver_name, d.plate AS driver_plate, d.phone AS driver_phone
         FROM orders o
         LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
         LEFT JOIN drivers d ON o.driver_id = d.driver_id
         WHERE o.order_id = $1`,
        [orderId]
      );
      if (order.rows.length === 0) {
        console.log(`[SOS] 訂單 ${orderId} 不存在，跳過 SOS`);
        return;
      }
      const o = order.rows[0];

      // 2. 拿家屬清單（rate limit 在迴圈內 check per-family）
      const families = await this.pool.query(
        `SELECT id, line_user_id, display_name, relation, last_sos_sent_at
         FROM passenger_family_contacts
         WHERE passenger_id = $1
         ORDER BY is_primary DESC, created_at ASC`,
        [o.passenger_id]
      );
      if (families.rows.length === 0) {
        console.log(`[SOS] 長輩 ${o.passenger_id} 未綁家屬，跳過 SOS（純存證）`);
        return;
      }

      // 3. 拿最新 no-show 照片（如有）
      const evidence = await this.pool.query(
        `SELECT photo_url FROM no_show_evidence
         WHERE order_id = $1
         ORDER BY captured_at DESC LIMIT 1`,
        [orderId]
      );
      const photoPath = evidence.rows[0]?.photo_url; // 例：/uploads/no_show/xxx.jpg
      const photoUrl = photoPath
        ? `${process.env.PUBLIC_BASE_URL || 'https://api.hualientaxi.taxi'}${photoPath}`
        : undefined;

      // 4. 格式化推播 payload
      const pickupTime = this.formatDateTime(new Date(o.created_at));
      const cardPayload = {
        passengerName: o.passenger_name || '長輩',
        passengerPhone: this.normalizePhone(o.passenger_phone),
        pickupAddress: o.pickup_address || '未知地點',
        pickupTime,
        driverName: o.driver_name || '司機',
        driverPlate: o.driver_plate || '',
        driverPhone: this.normalizePhone(o.driver_phone),
        photoUrl,
      };

      const flex = familyNoShowAlertCard(cardPayload);

      // 5. 對每位家屬：rate limit check + push
      const rateLimitMs = SOS_RATE_LIMIT_HOURS * 3600 * 1000;
      const now = Date.now();
      for (const f of families.rows) {
        if (f.last_sos_sent_at) {
          const elapsed = now - new Date(f.last_sos_sent_at).getTime();
          if (elapsed < rateLimitMs) {
            const remainHr = Math.ceil((rateLimitMs - elapsed) / 3600 / 1000);
            console.log(`[SOS] 家屬 ${f.line_user_id} (${f.display_name}) 在 24h 內已收過 SOS（剩 ${remainHr}h），跳過`);
            continue;
          }
        }
        try {
          await this.lineClient.pushMessage({
            to: f.line_user_id,
            messages: [flex],
          });
          await this.pool.query(
            `UPDATE passenger_family_contacts
             SET last_sos_sent_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [f.id]
          );
          console.log(`[SOS] ✓ 已推 SOS 給家屬 ${f.line_user_id} (${f.display_name}) 訂單 ${orderId}`);
        } catch (e: any) {
          console.error(`[SOS] ✗ 推給家屬 ${f.line_user_id} 失敗（可能封鎖 / 退追）: ${e.message}`);
        }
      }
    } catch (e: any) {
      console.error(`[SOS] pushNoShowAlertToFamilies(${orderId}) 整體失敗:`, e.message);
    }
  }

  /** 把電話格式化掉前綴空白 + 加 0 後綴清理 */
  private normalizePhone(raw: string | null | undefined): string | undefined {
    if (!raw) return undefined;
    const cleaned = raw.replace(/[^0-9+]/g, '');
    if (!cleaned || cleaned.startsWith('LINE')) return undefined;
    return cleaned;
  }

  private formatDateTime(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}/${m}/${day} ${h}:${min}`;
  }
}

// ========== 單例管理 ==========

let sosService: SOSService | null = null;

export function initSOSService(pool: Pool): void {
  sosService = new SOSService(pool);
}

export function getSOSService(): SOSService | null {
  return sosService;
}

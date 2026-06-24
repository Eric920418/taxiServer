/**
 * relay.ts — 司機↔客人 電話中繼遮蔽
 *
 * 設計：單一中繼號 + caller-ID 查表橋接（不每單配號，免被 10 門 DID 卡死並發）。
 *  - box dialplan 在「中繼號(038907329)」進線時 curl GET /api/relay/lookup?from=<來電真號>
 *  - 後端依來電真號找 active order 的「對方」真號，回純文字供 dialplan 外撥橋接（查無回空字串）
 *  - 對方來電顯示為代表號(fet-outbound 設 038907320)，雙方都看不到對方真號
 *
 * 遮蔽開關 RELAY_MASK_ENABLED 預設關 → 程式碼可先上線；活測驗證中繼能橋接後再翻開，
 * 避免「遮蔽開了但中繼沒驗證 → 司機客人互打不通」。真號只遮 client DTO，server 內部仍用真號。
 */

import { Router } from 'express';
import pool from '../db/connection';

const router = Router();

/** 中繼遮蔽號（保留 1 門 DID 當系統轉接號；038907320 維持叫車主線）。 */
export const RELAY_NUMBER = process.env.RELAY_NUMBER || '038907329';

/** 遮蔽總開關：true 才把 client DTO 的真號換成中繼號。 */
export const RELAY_MASK_ENABLED = process.env.RELAY_MASK_ENABLED === 'true';

/** 給 client 看的對方號碼：開遮蔽→回中繼號；否則回真號。server 內部（簡訊/派單）絕不用這個。 */
export function maskCounterpartPhone(realNumber?: string | null): string | null {
  if (!realNumber) return realNumber ?? null;
  return RELAY_MASK_ENABLED ? RELAY_NUMBER : realNumber;
}

/** 末 9 碼數字（去 +886 / 前導 0 / 連字號，統一比對）。 */
function norm9(p?: string | null): string {
  return (p || '').replace(/[^0-9]/g, '').slice(-9);
}

/**
 * 中繼查表：依來電真號(from) 找 active order 的「對方」真號。
 * from 是司機→回客人號；from 是客人→回司機號；查無回 null。
 */
export async function lookupRelayTarget(from: string): Promise<string | null> {
  const nf = norm9(from);
  if (!nf) return null;
  const r = await pool.query(
    `SELECT o.order_id, o.customer_phone, o.status,
            p.phone AS passenger_phone, d.phone AS driver_phone
     FROM orders o
     LEFT JOIN drivers d ON o.driver_id = d.driver_id
     LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
     WHERE o.status IN ('ACCEPTED','ARRIVED','ON_TRIP')
       AND (
         RIGHT(regexp_replace(COALESCE(o.customer_phone,''), '[^0-9]', '', 'g'), 9) = $1
         OR RIGHT(regexp_replace(COALESCE(p.phone,''), '[^0-9]', '', 'g'), 9) = $1
         OR RIGHT(regexp_replace(COALESCE(d.phone,''), '[^0-9]', '', 'g'), 9) = $1
       )
     ORDER BY (o.status = 'ARRIVED') DESC, o.accepted_at DESC NULLS LAST
     LIMIT 1`,
    [nf]
  );
  const row = r.rows[0];
  if (!row) return null;
  const driverN = norm9(row.driver_phone);
  const custReal: string | null = row.customer_phone || row.passenger_phone || null;
  const custN = norm9(custReal);
  if (driverN && driverN === nf) return custReal;             // 司機撥 → 接客人
  if (custN && custN === nf) return row.driver_phone || null; // 客人撥 → 接司機
  return null;
}

/**
 * GET /api/relay/lookup?from=09xxxxxxxx&did=038907329&key=<BRIDGE_SECRET>
 * 回純文字要撥的號碼（或空字串），給 box dialplan 的 ${CURL(...)} 取用。
 */
router.get('/lookup', async (req, res) => {
  try {
    const secret = process.env.BRIDGE_SECRET || '';
    const provided = (req.query.key as string) || (req.headers['x-bridge-secret'] as string) || '';
    if (secret && provided !== secret) {
      return res.status(401).type('text/plain').send('');
    }
    const from = String(req.query.from || '');
    const target = await lookupRelayTarget(from);
    console.log(`[Relay] lookup from=${from} → ${target || '(查無對應行程)'}`);
    return res.type('text/plain').send(target || '');
  } catch (e: any) {
    // 錯誤完整顯示在 log；回空字串讓 dialplan 安全收場（播「找不到行程」）
    console.error('[Relay] lookup 錯誤:', e);
    return res.status(500).type('text/plain').send('');
  }
});

export default router;

//==============================================================
// taxi-ai-bridge — Asterisk AudioSocket ↔ OpenAI Realtime(GA) 橋接
//--------------------------------------------------------------
// 大豐計程車「即時 AI 語音客服」。每通電話：
//   Asterisk AudioSocket(slin16 8kHz) ↔ 本程式 ↔ OpenAI Realtime(g711 μ-law)
//   AI 問出上車/目的地 → function call → POST 後端建單派單 → 口頭回覆客人
//
// 兩個 server：
//   :9091 HTTP  — dialplan 在接 AudioSocket 前先 POST /call-start {uuid,caller}
//   :9092 TCP   — AudioSocket 連線（每連線=一通）
//
// env：OPENAI_API_KEY, RT_MODEL(gpt-realtime), VOICE(marin),
//      BACKEND_URL(https://api.hualientaxi.taxi), BACKEND_SECRET,
//      MAX_CALLS(並發上限，超過拒接→dialplan fallback MVP)
//==============================================================
import net from 'net';
import http from 'http';
import WebSocket from 'ws';

const PORT_TCP = +(process.env.AS_PORT || 9092);
const PORT_HTTP = +(process.env.HTTP_PORT || 9091);
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.RT_MODEL || 'gpt-realtime';
const VOICE = process.env.VOICE || 'marin';
const BACKEND_URL = process.env.BACKEND_URL || 'https://api.hualientaxi.taxi';
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';
const MAX_CALLS = +(process.env.MAX_CALLS || 3);
if (!KEY) { console.error('缺 OPENAI_API_KEY'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString(), ...a);

// 台灣時間（UTC+8）ISO 字串，注入 prompt 讓 AI 能換算「明天9點」這類預約時間
function nowTaiwanString() {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);
  return tw.toISOString().replace('Z', '+08:00');
}

// 每通連線時動態建（含當前時間）。AI 收到 create_taxi_order 結果 JSON 後依欄位回話。
function buildSystemPrompt() {
  return `你是台灣「大豐計程車」的電話叫車客服。全程用繁體中文、台灣口語、親切簡短。
現在時間（台灣 UTC+8）：${nowTaiwanString()}

★服務範圍：我們是「花蓮在地」叫車、只在花蓮接客。客人講的所有地點一律當作「花蓮」的地址去理解、覆述、確認，**絕對不要猜測或反問是不是其他縣市（高雄、台北、台中…）**。例如客人說某條路、某個地標，就當花蓮的那一個。

★說話風格：講話像真人在快速幫客人登記，精簡、自然、直接，不要太制式。
- 接話或進入下一句確認時，用「好」就好，**不要每次都說「好的」**。
- 開頭詞要變化、不要每輪都同一句：可換「好」「嗯」「沒問題」「瞭解」，有時直接問、不加開頭詞。
- 確認句要短、口語：例如「好，在國聯這邊對嗎？」「要去慈濟對嗎？」「這趟刷愛心卡嗎？」，不要冗長制式。

任務：問清楚客人需求後呼叫 create_taxi_order 建立訂單。開場先說「您好，大豐計程車，請問從哪裡上車？」

要問到的資訊（依序、自然地問，不要像在填表）：
1. 上車地點（必問、且**必須在花蓮**，我們只在花蓮接客）：要具體（路名＋段/巷弄或地標）。聽不清或太模糊就請對方再說一次。覆述確認一次。
   目的地：問一次即可，**目的地可以是花蓮以外（長途也接）**。客人若說「上車後再說／還不知道／到時跟司機講」，就**只用上車點建單、destination_address 留空**，不要硬逼——司機載到客人後會在系統補目的地。
2. 付款方式：問「請問付現金還是刷卡？」。客人說付現/付現金/現金 → payment_type 填 cash；說刷卡/信用卡 → 填 credit_card。
3. 以下只在客人主動提到時才處理：
   - 火車接送：提醒「火車接送建議至少提前 1 小時預約喔」，問希望幾點上車，換算成 scheduled_at（ISO 8601、含 +08:00）。若客人說現在就要走，就當即時單、不要填 scheduled_at。
   - 醫院／行動不便：問「請問需要無障礙（輪椅）車嗎？」，需要就 needs_wheelchair 填 true；要等病人、協助上下車等其他需求寫進 special_notes。

確認後馬上呼叫 create_taxi_order。系統會回 JSON，依結果這樣回覆客人：
- ok 為 true 且有 etaMinutes：「好，幫您叫車了，最近的車大約（用 etaMinutes 的數字）分鐘到，找到司機再通知您」。
- ok 為 true 且 scheduled 為 true：「好，幫您預約好了，到時會派車通知您」。
- ok 為 false 且 noDrivers 為 true：現在沒有空車，給客人台階、別只叫他稍後再撥。先說「不好意思，現在線上的車都在忙」，再問「如果不趕時間，可以晚點再打進來；或者方便等的話，我可以幫您排一張大約 20 分鐘後的預約車，到時有車就幫您派、會再通知您，要幫您排嗎？」
   · 客人說要排 → 用剛剛同樣的上車/目的地/付款資訊、**加上 scheduled_at（現在時間 +20 分鐘、ISO 8601 含 +08:00）**再呼叫一次 create_taxi_order；建好後回「好，幫您排好了，大約 20 分鐘後幫您派車，有車會再通知您；之後不需要的話再打進來取消就好」。
   · 客人說不用 → 「好，那您方便的時候再打進來，謝謝您」結束。
   · 措辭要誠實：是「先幫您排、到時再試派」，不要講成保證一定有車。
- ok 為 false 且有 forbiddenPickup：把 alternatives 念給客人、請他改上車點，再重新呼叫 create_taxi_order。
- ok 為 false 且有 outOfServiceArea：上車點不在花蓮。告訴客人「不好意思，我們目前只服務**花蓮**地區的上車喔，麻煩您再說一次花蓮的上車地點」，等客人重講花蓮上車點後再呼叫一次 create_taxi_order。
- ok 為 false 且有 error：「不好意思系統忙線，麻煩您稍後再撥」。

不要閒聊、不要問無關的事。`;
}

// 來電號碼映射：dialplan 先 POST /call-start 存 uuid→caller
const callerByUuid = new Map();
let activeCalls = 0;

//----- G.711 μ-law ↔ slin16 -----------------------------------
const muDecode = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  muDecode[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);
}
function linToMu(s) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
  const man = (s >> (exp + 3)) & 0x0f;
  return (~(sign | (exp << 4) | man)) & 0xff;
}
function slinToMu(buf) { // Buffer slin16 LE → Buffer μ-law
  const out = Buffer.allocUnsafe(buf.length >> 1);
  for (let i = 0, j = 0; i + 1 < buf.length; i += 2, j++) out[j] = linToMu(buf.readInt16LE(i));
  return out;
}
function muToSlin(buf) { // Buffer μ-law → Buffer slin16 LE
  const out = Buffer.allocUnsafe(buf.length * 2);
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(muDecode[buf[i]], i * 2);
  return out;
}

//----- AudioSocket frame helpers ------------------------------
// frame: [type:1][len:2 BE][payload]; type 0x00=terminate 0x01=uuid 0x10=audio(slin) 0x03=error
function frame(type, payload = Buffer.alloc(0)) {
  const h = Buffer.allocUnsafe(3);
  h[0] = type; h.writeUInt16BE(payload.length, 1);
  return Buffer.concat([h, payload]);
}

//----- 每通電話一個 Session ------------------------------------
class Call {
  constructor(sock) {
    this.sock = sock;
    this.uuid = null;
    this.caller = 'unknown';
    this.rx = Buffer.alloc(0);          // AudioSocket 進來的位元組緩衝
    this.outBuf = Buffer.alloc(0);      // 要送回 Asterisk 的 slin16 連續緩衝（pacer 每 20ms 取剛好 320B）
    this.ws = null;
    this.closed = false;
    this.ordered = false;
    sock.on('data', (d) => this.onTcp(d));
    sock.on('close', () => this.cleanup('tcp-close'));
    sock.on('error', () => this.cleanup('tcp-error'));
    // 20ms 取一幀(320B slin)送回 Asterisk
    this.pacer = setInterval(() => this.flushOut(), 20);
  }

  onTcp(d) {
    this.rx = Buffer.concat([this.rx, d]);
    while (this.rx.length >= 3) {
      const type = this.rx[0];
      const len = this.rx.readUInt16BE(1);
      if (this.rx.length < 3 + len) break;
      const payload = this.rx.subarray(3, 3 + len);
      this.rx = this.rx.subarray(3 + len);
      if (type === 0x01) {              // UUID（16 bytes 二進位 → 標準字串）
        const hex = payload.toString('hex');
        this.uuid = hex.length === 32
          ? `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
          : (payload.toString('ascii').replace(/\0+$/, '') || hex);
        this.caller = callerByUuid.get(this.uuid) || 'unknown';
        callerByUuid.delete(this.uuid);
        log(`📞 通話開始 uuid=${this.uuid} caller=${this.caller} (active=${activeCalls})`);
        this.openAI();
      } else if (type === 0x10) {       // 客人語音(slin16)→μ-law→OpenAI
        if (this.ws?.readyState === WebSocket.OPEN) {
          const mu = slinToMu(payload);
          this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mu.toString('base64') }));
        }
      } else if (type === 0x00) {       // Asterisk 掛斷
        this.cleanup('hangup');
      }
    }
  }

  flushOut() {
    if (this.closed || this.sock.destroyed) return;
    // 每 20ms 送「剛好」一幀 320 bytes(160 sample slin)；frame 邊界永遠對齊 → 不抖動、無沙沙底噪
    if (this.outBuf.length === 0) return;
    let chunk;
    if (this.outBuf.length >= 320) {
      chunk = this.outBuf.subarray(0, 320);
      this.outBuf = this.outBuf.subarray(320);
    } else {
      // 音訊真正尾段不足一幀 → 補靜音(slin 0)湊滿 20ms 再送，避免短幀造成 Asterisk 時脈抖動
      chunk = Buffer.concat([this.outBuf, Buffer.alloc(320 - this.outBuf.length)]);
      this.outBuf = Buffer.alloc(0);
    }
    this.sock.write(frame(0x10, chunk));
  }

  // OpenAI 來的 μ-law base64 → slin16 → 累加到連續緩衝（不再 per-delta 切塊，避免每個 delta 留短尾幀）
  enqueueAudio(b64) {
    const slin = muToSlin(Buffer.from(b64, 'base64'));
    this.outBuf = Buffer.concat([this.outBuf, slin]);
  }

  openAI() {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    this.ws = ws;
    ws.on('open', () => {});
    ws.on('message', (data) => this.onAI(JSON.parse(data.toString())));
    ws.on('close', () => this.cleanup('ws-close'));
    ws.on('error', (e) => { log('ws err', e.message); this.cleanup('ws-error'); });
  }

  onAI(ev) {
    switch (ev.type) {
      case 'session.created':
        this.ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: buildSystemPrompt(),
            audio: {
              input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } },
              output: { format: { type: 'audio/pcmu' }, voice: VOICE },
            },
            tools: [{
              type: 'function',
              name: 'create_taxi_order',
              description: '確認客人需求後，建立計程車訂單並派車（即時或預約）',
              parameters: {
                type: 'object',
                properties: {
                  pickup_address: { type: 'string', description: '上車地點，越具體越好' },
                  destination_address: { type: 'string', description: '目的地(選填)；客人不知道/上車後再說就留空' },
                  payment_type: { type: 'string', enum: ['cash', 'credit_card'], description: '付款方式：現金 cash / 刷卡 credit_card' },
                  needs_wheelchair: { type: 'boolean', description: '是否需要無障礙(輪椅)車' },
                  scheduled_at: { type: 'string', description: '預約上車時間 ISO 8601(含 +08:00)；即時單留空' },
                  special_notes: { type: 'string', description: '特殊需求備註(選填)' },
                },
                required: ['pickup_address'],
              },
            }],
          },
        }));
        break;
      case 'session.updated':
        // 主動開場
        this.ws.send(JSON.stringify({ type: 'response.create' }));
        break;
      case 'response.output_audio.delta':
        if (ev.delta) this.enqueueAudio(ev.delta);
        break;
      case 'response.output_audio_transcript.done':
        if (ev.transcript) log(`🤖 AI: ${ev.transcript}`);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript) log(`🗣️  客人: ${ev.transcript}`);
        break;
      case 'input_audio_buffer.speech_started':
        this.outBuf = Buffer.alloc(0);  // 客人插話 → 清掉 AI 還沒播完的音
        break;
      case 'response.function_call_arguments.done':
        this.onFunctionCall(ev);
        break;
      case 'error':
        log('OpenAI error', JSON.stringify(ev.error));
        break;
    }
  }

  async onFunctionCall(ev) {
    let args = {};
    try { args = JSON.parse(ev.arguments || '{}'); } catch {}
    log(`🚕 建單 caller=${this.caller}`, args);
    let result;
    try {
      const r = await fetch(`${BACKEND_URL}/api/phone-calls/realtime-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET },
        body: JSON.stringify({
          call_id: this.uuid,
          customer_phone: this.caller,
          pickup_address: args.pickup_address,
          destination_address: args.destination_address,
          special_notes: args.special_notes || null,
          payment_type: args.payment_type || null,
          needs_wheelchair: !!args.needs_wheelchair,
          scheduled_at: args.scheduled_at || null,
        }),
        signal: AbortSignal.timeout(12000),
      });
      result = await r.json();
    } catch (e) {
      result = { ok: false, error: 'backend_unreachable' };
    }
    this.ordered = !!result?.orderId;
    // 把結果餵回 AI，讓它口頭回覆客人
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(result) },
      }));
      this.ws.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  cleanup(why) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pacer);
    log(`📴 通話結束 (${why}) uuid=${this.uuid} ordered=${this.ordered}`);
    try { this.ws?.close(); } catch {}
    try { this.sock.destroy(); } catch {}
    activeCalls = Math.max(0, activeCalls - 1);
  }
}

//----- TCP（AudioSocket）-------------------------------------
net.createServer((sock) => {
  activeCalls++;
  if (activeCalls > MAX_CALLS) {        // 超過並發上限 → 立刻關，dialplan 走 fallback
    log(`🚦 超過並發上限 ${MAX_CALLS}，拒接這通（fallback MVP）`);
    activeCalls--;
    sock.end();
    return;
  }
  new Call(sock);
}).listen(PORT_TCP, '127.0.0.1', () => log(`AudioSocket TCP 監聽 127.0.0.1:${PORT_TCP} (MAX_CALLS=${MAX_CALLS})`));

//----- HTTP（接收 dialplan 的 uuid→caller 映射）---------------
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/call-start') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const uuid = p.get('uuid'), caller = p.get('caller') || 'unknown';
      if (uuid) { callerByUuid.set(uuid, caller); setTimeout(() => callerByUuid.delete(uuid), 60000); }
      res.writeHead(200); res.end('ok');
    });
  } else if (req.url === '/health') {
    res.writeHead(200); res.end(JSON.stringify({ active: activeCalls, max: MAX_CALLS }));
  } else { res.writeHead(404); res.end(); }
}).listen(PORT_HTTP, '127.0.0.1', () => log(`HTTP 監聽 127.0.0.1:${PORT_HTTP} (/call-start, /health)`));

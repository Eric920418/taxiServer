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

const SYSTEM_PROMPT = `你是台灣「大豐計程車」的電話叫車客服。全程用繁體中文、台灣口語、親切簡短。
任務：問清楚客人的「上車地點」和「目的地」，兩個都拿到就立刻呼叫 create_taxi_order 建立訂單。
規則：
- 開場先說「您好，大豐計程車，請問從哪裡上車？」
- 地址要具體（路名＋段/巷弄或附近地標）。聽不清楚或太模糊就請對方再說一次或說得更清楚。
- 拿到地址後簡短覆述確認一次，例如「您是從自強路到遠東百貨，對嗎？」
- 確認後馬上呼叫 create_taxi_order。建單成功後告訴客人「好的已經幫您叫車，找到司機會再通知您」。
- 如果系統回覆上車點不可停靠，就把替代點念給客人、請他改。
- 不要閒聊、不要問無關的事。`;

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
    this.outQ = [];                     // 要送回 Asterisk 的 slin16 chunk 佇列
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
    // 每 20ms 送一幀 320 bytes(160 sample slin)
    if (this.outQ.length === 0) return;
    let chunk = this.outQ.shift();
    this.sock.write(frame(0x10, chunk));
  }

  // OpenAI 來的 μ-law base64 → slin16 → 切 320B 幀塞 outQ
  enqueueAudio(b64) {
    const slin = muToSlin(Buffer.from(b64, 'base64'));
    for (let i = 0; i < slin.length; i += 320) this.outQ.push(slin.subarray(i, i + 320));
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
            instructions: SYSTEM_PROMPT,
            audio: {
              input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } },
              output: { format: { type: 'audio/pcmu' }, voice: VOICE },
            },
            tools: [{
              type: 'function',
              name: 'create_taxi_order',
              description: '已確認上車地點與目的地後，建立計程車訂單並派車',
              parameters: {
                type: 'object',
                properties: {
                  pickup_address: { type: 'string', description: '上車地點，越具體越好' },
                  destination_address: { type: 'string', description: '目的地' },
                  special_notes: { type: 'string', description: '特殊需求(選填)' },
                },
                required: ['pickup_address', 'destination_address'],
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
        this.outQ = [];                 // 客人插話 → 清掉 AI 還沒播完的音
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

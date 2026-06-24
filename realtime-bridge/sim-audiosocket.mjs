// 模擬 Asterisk AudioSocket 客戶端，本地測 bridge：
// 連線→送UUID→送靜音(保持通話)→收 AI 開場語音(算回送音訊幀)
import net from 'net';
import crypto from 'crypto';

const uuid = crypto.randomUUID();
const uuidBytes = Buffer.from(uuid.replace(/-/g, ''), 'hex'); // 16 bytes

await fetch('http://127.0.0.1:9091/call-start', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ uuid, caller: '0912345678' }).toString(),
});
console.log('已 POST /call-start, uuid=', uuid);

let audioBytes = 0, frames = 0, rx = Buffer.alloc(0);
const sock = net.connect(9092, '127.0.0.1', () => {
  const h = Buffer.alloc(3); h[0] = 0x01; h.writeUInt16BE(16, 1);
  sock.write(Buffer.concat([h, uuidBytes]));
  console.log('已送 UUID frame，開始送靜音保持通話…');
  const silence = Buffer.alloc(320);
  const t = setInterval(() => {
    const fh = Buffer.alloc(3); fh[0] = 0x10; fh.writeUInt16BE(320, 1);
    if (!sock.destroyed) sock.write(Buffer.concat([fh, silence]));
  }, 20);
  setTimeout(() => { clearInterval(t); sock.end(); }, 9000);
});
sock.on('data', (d) => {
  rx = Buffer.concat([rx, d]);
  while (rx.length >= 3) {
    const len = rx.readUInt16BE(1); if (rx.length < 3 + len) break;
    const type = rx[0]; const p = rx.subarray(3, 3 + len); rx = rx.subarray(3 + len);
    if (type === 0x10) { audioBytes += p.length; frames++; }
  }
});
sock.on('close', () => {
  console.log(`\n收到 AI 回送音訊：${frames} 幀 / ${audioBytes} bytes ≈ ${(audioBytes / 16000).toFixed(1)} 秒`);
  console.log(audioBytes > 0 ? '✅ bridge 全鏈路通（AudioSocket↔OpenAI↔音訊回送）' : '✗ 沒收到音訊');
  process.exit(0);
});
sock.on('error', (e) => { console.error('sock err', e.message); process.exit(1); });

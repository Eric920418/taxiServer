// 去風險測試：確認 OpenAI 帳號能用 Realtime API
// 用法：OPENAI_API_KEY=xxx node test-realtime.mjs   (可選 RT_MODEL 覆蓋模型)
import WebSocket from 'ws';

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('✗ 缺 OPENAI_API_KEY'); process.exit(1); }

// 依序嘗試這些模型名（不同時期 GA/preview 名稱不同）
const MODELS = process.env.RT_MODEL
  ? [process.env.RT_MODEL]
  : ['gpt-realtime', 'gpt-4o-realtime-preview', 'gpt-4o-realtime-preview-2024-12-17'];

async function tryModel(model) {
  return new Promise((resolve) => {
    const url = `wss://api.openai.com/v1/realtime?model=${model}`;
    // GA Realtime API：不帶 OpenAI-Beta header（帶了會 beta_api_shape_disabled）
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const done = (ok, msg) => { try { ws.close(); } catch {} resolve({ ok, msg }); };
    const t = setTimeout(() => done(false, '逾時'), 15000);
    ws.on('open', () => console.log(`  [${model}] WS 連上，等 session...`));
    ws.on('message', (data) => {
      const ev = JSON.parse(data.toString());
      if (ev.type === 'session.created') { clearTimeout(t); done(true, `session ${ev.session?.id}`); }
      else if (ev.type === 'error') { clearTimeout(t); done(false, JSON.stringify(ev.error)); }
    });
    ws.on('unexpected-response', (_req, res) => { clearTimeout(t); done(false, `HTTP ${res.statusCode}`); });
    ws.on('error', (e) => { clearTimeout(t); done(false, e.message); });
  });
}

for (const m of MODELS) {
  console.log(`嘗試模型: ${m}`);
  const r = await tryModel(m);
  if (r.ok) { console.log(`\n✅ Realtime 可用！模型=${m}  (${r.msg})`); process.exit(0); }
  console.log(`  ✗ ${m}: ${r.msg}\n`);
}
console.error('❌ 所有模型都不行——帳號可能沒開 Realtime 權限');
process.exit(1);

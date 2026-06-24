// 探針：確認 GA Realtime API 的正確事件形狀（session 設定、音訊事件名、function call 流程）
// 用法：OPENAI_API_KEY=xxx node probe-realtime.mjs
import WebSocket from 'ws';
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.RT_MODEL || 'gpt-realtime';
const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
  headers: { Authorization: `Bearer ${KEY}` },
});
const seen = new Set();
let audioBytes = 0;
const send = (o) => ws.send(JSON.stringify(o));

ws.on('open', () => console.log('WS open'));
ws.on('message', (data) => {
  const ev = JSON.parse(data.toString());
  if (!seen.has(ev.type)) { seen.add(ev.type); console.log('▶ 事件型別:', ev.type); }

  if (ev.type === 'session.created') {
    // 用 GA 形狀設定 session：g711 μ-law、server VAD、一個建單 tool
    send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: '你是台灣大豐計程車的電話客服。用繁體中文、台灣口語、簡短自然地對話。問清楚上車地點與目的地，覆述確認；聽不清楚就請對方再說一次。當同時拿到上車地點與目的地後，呼叫 create_taxi_order。',
        audio: {
          input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } },
          output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
        },
        tools: [{
          type: 'function',
          name: 'create_taxi_order',
          description: '已取得上車地點與目的地後建立計程車訂單',
          parameters: {
            type: 'object',
            properties: {
              pickup_address: { type: 'string', description: '上車地點' },
              destination_address: { type: 'string', description: '目的地' },
            },
            required: ['pickup_address', 'destination_address'],
          },
        }],
      },
    });
  }

  if (ev.type === 'session.updated') {
    console.log('  ✓ session.updated（設定被接受）');
    // 丟一句明確的文字，看 AI 會不會直接呼叫 create_taxi_order
    send({ type: 'conversation.item.create', item: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '我要從花蓮市自強路搭車到遠東百貨' }] } });
    send({ type: 'response.create' });
  }

  // 蒐集音訊 delta 的事件名（GA 可能是 response.output_audio.delta）
  if (ev.type.includes('audio') && ev.delta) audioBytes += ev.delta.length;

  // function call 完成的事件
  if (ev.type.includes('function_call_arguments') && ev.type.includes('done')) {
    console.log('  ★ FUNCTION CALL:', ev.name, ev.arguments);
  }
  if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call') {
    console.log('  ★ output_item function_call:', ev.item.name, ev.item.arguments);
  }

  if (ev.type === 'response.done') {
    console.log('\n=== 本輪 response.done ===');
    console.log('收到的所有事件型別:', [...seen].join(', '));
    console.log('音訊 delta base64 累積長度:', audioBytes);
    if (ev.response?.output) console.log('output items:', JSON.stringify(ev.response.output.map(o => ({type:o.type, name:o.name})) ));
    ws.close(); process.exit(0);
  }
  if (ev.type === 'error') { console.error('  ✗ error:', JSON.stringify(ev.error)); ws.close(); process.exit(1); }
});
ws.on('error', (e) => { console.error('WS error', e.message); process.exit(1); });
setTimeout(() => { console.error('逾時'); process.exit(1); }, 30000);

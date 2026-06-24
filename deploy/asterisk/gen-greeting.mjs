#!/usr/bin/env node
//==============================================================
// gen-greeting.mjs — 生 Asterisk 電話叫車歡迎語（8kHz mono WAV）
//--------------------------------------------------------------
// 雙來源自動偵測：
//   1) 有 GOOGLE_TTS_API_KEY / GOOGLE_MAPS_API_KEY → Google cmn-TW-Wavenet-A
//      （台灣國語女聲，直接要 8kHz LINEAR16，免轉檔，伺服器首選）
//   2) 否則有 OPENAI_API_KEY → OpenAI gpt-4o-mini-tts（需本機 ffmpeg 轉 8kHz）
//
// 輸出：8kHz / 16-bit / mono PCM WAV，Asterisk format_wav 直接可播。
// 用法：node deploy/asterisk/gen-greeting.mjs
// 產物：deploy/asterisk/sounds/{greeting-taxi,got-it}.wav
// 部署：scp sounds/*.wav  asterisk機:/var/lib/asterisk/sounds/custom/
//==============================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'sounds');
fs.mkdirSync(OUT_DIR, { recursive: true });

// A 案：歡迎語 → 客人講 → 偵測靜音 → got-it → 掛斷
const CLIPS = [
  { name: 'greeting-taxi', text: '您好，這裡是大豐計程車。請說出您的上車地點，以及您要去的目的地。說完之後請稍候，我們會立即為您安排車輛。' },
  { name: 'got-it', text: '好的，已經收到您的叫車需求，正在為您安排車輛，稍後將來電通知您車號，謝謝。' },
];

const GOOGLE_KEY = process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

async function viaGoogle(text) {
  const body = {
    input: { text },
    voice: { languageCode: 'cmn-TW', name: 'cmn-TW-Wavenet-A', ssmlGender: 'FEMALE' },
    audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000, speakingRate: 0.9 },
  };
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (!data.audioContent) throw new Error('Google 沒回 audioContent');
  return Buffer.from(data.audioContent, 'base64'); // 已是 8kHz WAV
}

async function viaOpenAI(text) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
      input: text,
      instructions: '用溫暖、緩慢、清晰的語氣，像親切的計程車客服阿姨，講台灣國語。',
      response_format: 'wav',
    }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const wav24k = Buffer.from(await res.arrayBuffer()); // 24kHz WAV
  // ffmpeg 轉 8kHz / mono / 16-bit（Asterisk format_wav 需要）
  const tmp = path.join(os.tmpdir(), `tts-${Date.now()}.wav`);
  fs.writeFileSync(tmp, wav24k);
  const out = path.join(os.tmpdir(), `tts-8k-${Date.now()}.wav`);
  execFileSync('ffmpeg', ['-y', '-i', tmp, '-ar', '8000', '-ac', '1', '-acodec', 'pcm_s16le', '-f', 'wav', out], { stdio: 'pipe' });
  const buf = fs.readFileSync(out);
  fs.unlinkSync(tmp); fs.unlinkSync(out);
  return buf;
}

const provider = GOOGLE_KEY ? 'Google cmn-TW-Wavenet-A（台灣女聲）'
  : OPENAI_KEY ? 'OpenAI gpt-4o-mini-tts/nova（需 ffmpeg）'
  : null;
if (!provider) { console.error('✗ 無可用 TTS key（GOOGLE_TTS_API_KEY 或 OPENAI_API_KEY）'); process.exit(1); }
console.log(`TTS 來源：${provider}\n`);

for (const clip of CLIPS) {
  try {
    const buf = GOOGLE_KEY ? await viaGoogle(clip.text) : await viaOpenAI(clip.text);
    const out = path.join(OUT_DIR, `${clip.name}.wav`);
    fs.writeFileSync(out, buf);
    console.log(`✓ ${clip.name}.wav  ${(buf.length / 1024).toFixed(1)}KB  「${clip.text.slice(0, 16)}…」`);
  } catch (e) {
    console.error(`✗ [${clip.name}] ${e.message}`);
    process.exit(1);
  }
}
console.log(`\n完成 → ${OUT_DIR}`);

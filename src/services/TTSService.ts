/**
 * TTSService — 模組 2：派車成功語音通知
 *
 * 用 Google Cloud Text-to-Speech REST API（無需 @google-cloud/text-to-speech SDK）
 * 流程：
 *   1. 合成中文 mp3
 *   2. 寫到 public/uploads/audio/{orderId}-{ts}.mp3
 *   3. 回傳 public URL + 估計時長（給 LINE audio message 用）
 *
 * 環境變數：
 *   GOOGLE_TTS_API_KEY — 必填，無此 key 則整個 TTS 功能 graceful skip
 *
 * 費用估算：cmn-TW-Wavenet-A ≈ $16/million chars
 *   一則 「司機張先生 車牌 ABC1234 5 分鐘後到達」≈ 20 字
 *   = 1000 則訊息 ≈ $0.32
 */

import fs from 'fs';
import path from 'path';

const TTS_API_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const AUDIO_DIR = path.join(__dirname, '../../public/uploads/audio');
const DEFAULT_VOICE = 'cmn-TW-Wavenet-A'; // 台灣國語女聲 Wavenet
const DEFAULT_SPEAKING_RATE = 0.9; // 略慢給長輩聽

// 確保資料夾存在
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

export interface TTSResult {
  /** 公開 URL，例 https://api.hualientaxi.taxi/uploads/audio/xxx.mp3 */
  audioUrl: string;
  /** 估計時長（毫秒）— LINE audio message 需要此欄位 */
  durationMs: number;
  /** server 本地檔路徑 */
  filePath: string;
}

/**
 * 合成中文語音 mp3
 *
 * @param text 要說的話（建議 ≤ 100 字、保持單句完整）
 * @param filenameHint 檔案前綴（如 orderId）、會加 timestamp 後綴
 * @returns 公開 URL + 估計時長
 * @throws Error 若 GOOGLE_TTS_API_KEY 未設定或 API 失敗
 */
export async function synthesizeChineseMp3(text: string, filenameHint: string): Promise<TTSResult> {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_TTS_API_KEY 未設定，TTS 跳過');
  }

  const cleanText = text.trim().slice(0, 200); // 安全 cap，避免單則太長爆 LINE 1 分鐘限制
  if (!cleanText) throw new Error('text 為空');

  const requestBody = {
    input: { text: cleanText },
    voice: {
      languageCode: 'cmn-TW',
      name: DEFAULT_VOICE,
      ssmlGender: 'FEMALE',
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: DEFAULT_SPEAKING_RATE,
      // sampleRateHertz 預設 24000 OK
    },
  };

  const res = await fetch(`${TTS_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google TTS API ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json() as { audioContent?: string };
  if (!data.audioContent) {
    throw new Error('Google TTS 沒回 audioContent');
  }

  // base64 → Buffer → 寫檔
  const audioBuffer = Buffer.from(data.audioContent, 'base64');

  // 檔大小檢查（LINE limit: 200KB）
  if (audioBuffer.length > 200 * 1024) {
    throw new Error(`mp3 ${(audioBuffer.length / 1024).toFixed(0)}KB 超過 LINE 200KB 限制`);
  }

  const ts = Date.now();
  const safeHint = filenameHint.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30) || 'tts';
  const filename = `${safeHint}-${ts}.mp3`;
  const filePath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filePath, audioBuffer);

  // 估時長：中文每字 350ms (speakingRate 0.9) + 500ms buffer
  // 實際更準確的做法是用 mp3-duration package、但對 LINE 容差，估保守即可
  const estimatedMs = cleanText.length * 350 + 500;

  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://api.hualientaxi.taxi';
  return {
    audioUrl: `${baseUrl}/uploads/audio/${filename}`,
    durationMs: estimatedMs,
    filePath,
  };
}

/**
 * 司機接單後的派車成功語音模板
 * 例：「您的計程車已找到，司機張先生 車牌 ABC1234 預計 5 分鐘後抵達」
 */
export function buildDriverAcceptedTtsText(args: {
  driverName: string;
  plate: string;
  etaMinutes?: number | null;
}): string {
  // 車牌轉成單字一個一個讀（避免「ABC1234」一口氣讀成意義不明的字符）
  const platePronounced = args.plate
    .replace(/-/g, ' ')
    .split('')
    .join(' ');
  const eta = args.etaMinutes ? `預計 ${args.etaMinutes} 分鐘後抵達` : '即將抵達';
  return `您好，您的計程車已找到，司機 ${args.driverName}，車牌 ${platePronounced}，${eta}。`;
}

/**
 * 清理 >N 天舊的 audio 檔（cron 用）
 */
export function cleanupOldAudio(maxAgeDays: number = 7): number {
  if (!fs.existsSync(AUDIO_DIR)) return 0;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  let deleted = 0;
  for (const f of fs.readdirSync(AUDIO_DIR)) {
    if (!f.endsWith('.mp3')) continue;
    const full = path.join(AUDIO_DIR, f);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoffMs) {
        fs.unlinkSync(full);
        deleted++;
      }
    } catch (e) { /* skip */ }
  }
  if (deleted > 0) console.log(`[TTSCleanup] 已刪除 ${deleted} 個 >${maxAgeDays}d audio 檔`);
  return deleted;
}

#!/usr/bin/env node
/**
 * generate-greeting.js - 大豐計程車 TTS 歡迎語音生成腳本
 *
 * 使用 OpenAI TTS API 生成 Asterisk 用的歡迎語音
 * 一次性執行：在 EC2 上產生 WAV 檔後即完成
 *
 * 前置條件：
 *   - OPENAI_API_KEY 環境變數（或 .env 檔案）
 *   - sox 已安裝：sudo apt-get install sox libsox-fmt-mp3
 *
 * 使用方式：
 *   node scripts/generate-greeting.js
 *
 * 輸出：
 *   /var/lib/asterisk/sounds/custom/taxi-greeting.wav (8kHz, mono, 16-bit PCM)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 載入 .env（如果存在）
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) {
  // dotenv 可能未安裝，直接用環境變數
}

// ========== 配置 ==========

const CONFIG = {
  // OpenAI TTS 設定
  model: 'tts-1',           // 標準品質，延遲低
  voice: 'nova',            // 溫暖女聲，適合客服場景
  speed: 0.95,              // 稍慢一點，讓長輩聽清楚

  // 語音稿
  text: '大豐，你好！請問哪裡搭車？嗶聲之後，請說出上車地點跟目的地，說完直接掛斷就可以囉！',

  // 輸出路徑
  tmpFile: '/tmp/taxi-greeting-raw.mp3',
  outputDir: '/var/lib/asterisk/sounds/custom',
  outputFile: '/var/lib/asterisk/sounds/custom/taxi-greeting.wav',
};

// ========== 主程式 ==========

async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  大豐計程車 - TTS 歡迎語音生成腳本         ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log('');

  // 1. 檢查 API Key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('❌ 缺少 OPENAI_API_KEY 環境變數');
    console.error('   請設定: export OPENAI_API_KEY=sk-...');
    process.exit(1);
  }
  console.log('✅ OpenAI API Key 已設定');

  // 2. 檢查 sox
  try {
    execSync('which sox', { stdio: 'pipe' });
    console.log('✅ sox 已安裝');
  } catch {
    console.error('❌ sox 未安裝');
    console.error('   請安裝: sudo apt-get install sox libsox-fmt-mp3');
    process.exit(1);
  }

  // 3. 建立輸出目錄
  if (!fs.existsSync(CONFIG.outputDir)) {
    console.log(`📁 建立目錄: ${CONFIG.outputDir}`);
    execSync(`sudo mkdir -p ${CONFIG.outputDir}`);
    execSync(`sudo chown asterisk:asterisk ${CONFIG.outputDir}`);
  }

  // 4. 呼叫 OpenAI TTS API
  console.log('');
  console.log(`🎙️  語音稿: "${CONFIG.text}"`);
  console.log(`🔊 模型: ${CONFIG.model}, 聲音: ${CONFIG.voice}, 速度: ${CONFIG.speed}`);
  console.log('⏳ 正在生成語音...');

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CONFIG.model,
      input: CONFIG.text,
      voice: CONFIG.voice,
      speed: CONFIG.speed,
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`❌ OpenAI TTS API 失敗: ${response.status}`);
    console.error(error);
    process.exit(1);
  }

  // 5. 儲存 MP3
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(CONFIG.tmpFile, buffer);
  console.log(`✅ MP3 已儲存: ${CONFIG.tmpFile} (${buffer.length} bytes)`);

  // 6. sox 轉換為 Asterisk 格式
  console.log('⏳ 轉換為 Asterisk WAV 格式 (8kHz, mono, 16-bit PCM)...');
  const soxCmd = `sox ${CONFIG.tmpFile} -r 8000 -c 1 -b 16 /tmp/taxi-greeting.wav`;
  execSync(soxCmd);

  // 7. 複製到 Asterisk sounds 目錄
  execSync(`sudo cp /tmp/taxi-greeting.wav ${CONFIG.outputFile}`);
  execSync(`sudo chown asterisk:asterisk ${CONFIG.outputFile}`);
  execSync(`sudo chmod 644 ${CONFIG.outputFile}`);

  // 8. 驗證
  const stats = fs.statSync(CONFIG.outputFile);
  const soxi = execSync(`soxi ${CONFIG.outputFile} 2>/dev/null || sox --info ${CONFIG.outputFile}`).toString();

  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║              生成完成！                     ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`📄 輸出檔案: ${CONFIG.outputFile}`);
  console.log(`📦 檔案大小: ${stats.size} bytes`);
  console.log(`📊 音檔資訊:`);
  console.log(soxi);
  console.log('');
  console.log('下一步：');
  console.log('  1. 測試播放: sudo asterisk -rx "channel originate Local/s@test-greeting extension s@test-greeting"');
  console.log('  2. 更新 dialplan: sudo cp config/asterisk/extensions_taxi.conf /etc/asterisk/');
  console.log('  3. 重載設定: sudo asterisk -rx "dialplan reload"');

  // 清理暫存檔
  try {
    fs.unlinkSync(CONFIG.tmpFile);
    fs.unlinkSync('/tmp/taxi-greeting.wav');
  } catch {
    // 忽略清理錯誤
  }
}

main().catch((err) => {
  console.error('❌ 執行失敗:', err.message);
  process.exit(1);
});

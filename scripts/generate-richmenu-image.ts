/**
 * generate-richmenu-image.ts - 生成 Rich Menu 圖片並上傳 + 啟用
 *
 * 用法：npx ts-node scripts/generate-richmenu-image.ts
 */

import dotenv from 'dotenv';
import sharp from 'sharp';
import { messagingApi } from '@line/bot-sdk';
import fs from 'fs';
import path from 'path';

dotenv.config();

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!channelAccessToken) {
  console.error('請設定 LINE_CHANNEL_ACCESS_TOKEN');
  process.exit(1);
}

const LIFF_ID_BOOKING = process.env.LIFF_ID_BOOKING;
const LIFF_ID_TRACKING = process.env.LIFF_ID_TRACKING;
if (!LIFF_ID_BOOKING || !LIFF_ID_TRACKING) {
  console.error('請設定 LIFF_ID_BOOKING 和 LIFF_ID_TRACKING');
  process.exit(1);
}

function generateSVG(): string {
  const W = 2500;
  const H = 843;
  const colW = Math.floor(W / 3);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- 叫車區塊 -->
  <rect x="0" y="0" width="${colW}" height="${H}" fill="#2196F3"/>
  <text x="${colW/2}" y="280" text-anchor="middle" font-size="140" fill="white">🚕</text>
  <text x="${colW/2}" y="460" text-anchor="middle" font-size="80" font-weight="bold" fill="white" font-family="Arial, sans-serif">叫車</text>
  <text x="${colW/2}" y="560" text-anchor="middle" font-size="38" fill="rgba(255,255,255,0.85)" font-family="Arial, sans-serif">地圖選位 · 即時叫車</text>

  <!-- 預約區塊 -->
  <rect x="${colW}" y="0" width="${colW+1}" height="${H}" fill="#FF9800"/>
  <line x1="${colW}" y1="80" x2="${colW}" y2="${H-80}" stroke="rgba(255,255,255,0.3)" stroke-width="2"/>
  <text x="${colW + colW/2}" y="280" text-anchor="middle" font-size="140" fill="white">📅</text>
  <text x="${colW + colW/2}" y="460" text-anchor="middle" font-size="80" font-weight="bold" fill="white" font-family="Arial, sans-serif">預約叫車</text>
  <text x="${colW + colW/2}" y="560" text-anchor="middle" font-size="38" fill="rgba(255,255,255,0.85)" font-family="Arial, sans-serif">提前預約 · 準時出發</text>

  <!-- 查詢區塊 -->
  <rect x="${colW*2}" y="0" width="${W - colW*2}" height="${H}" fill="#4CAF50"/>
  <line x1="${colW*2}" y1="80" x2="${colW*2}" y2="${H-80}" stroke="rgba(255,255,255,0.3)" stroke-width="2"/>
  <text x="${colW*2 + (W-colW*2)/2}" y="280" text-anchor="middle" font-size="140" fill="white">📋</text>
  <text x="${colW*2 + (W-colW*2)/2}" y="460" text-anchor="middle" font-size="80" font-weight="bold" fill="white" font-family="Arial, sans-serif">查詢/取消</text>
  <text x="${colW*2 + (W-colW*2)/2}" y="560" text-anchor="middle" font-size="38" fill="rgba(255,255,255,0.85)" font-family="Arial, sans-serif">訂單追蹤 · 即時位置</text>
</svg>`;
}

async function main() {
  console.log('1. 生成 Rich Menu 圖片...');
  const svg = generateSVG();
  const imageBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

  const imagePath = path.join(__dirname, 'richmenu.png');
  fs.writeFileSync(imagePath, imageBuffer);
  console.log(`   圖片已儲存: ${imagePath} (${(imageBuffer.length / 1024).toFixed(0)} KB)`);

  const client = new messagingApi.MessagingApiClient({ channelAccessToken: channelAccessToken! });
  const blobClient = new messagingApi.MessagingApiBlobClient({ channelAccessToken: channelAccessToken! });

  console.log('2. 建立 Rich Menu...');
  const richMenu = await client.createRichMenu({
    size: { width: 2500, height: 843 },
    selected: true,
    name: '花蓮計程車（LIFF）',
    chatBarText: '叫車選單',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 833, height: 843 },
        action: {
          type: 'uri',
          uri: `https://liff.line.me/${LIFF_ID_BOOKING}?mode=call`,
          label: '叫車',
        },
      },
      {
        bounds: { x: 833, y: 0, width: 834, height: 843 },
        action: {
          type: 'uri',
          uri: `https://liff.line.me/${LIFF_ID_BOOKING}?mode=reserve`,
          label: '預約叫車',
        },
      },
      {
        bounds: { x: 1667, y: 0, width: 833, height: 843 },
        action: {
          type: 'uri',
          uri: `https://liff.line.me/${LIFF_ID_TRACKING}`,
          label: '查詢/取消',
        },
      },
    ],
  });

  const richMenuId = richMenu.richMenuId;
  console.log(`   Rich Menu ID: ${richMenuId}`);

  console.log('3. 上傳圖片...');
  await blobClient.setRichMenuImage(richMenuId, imageBuffer, 'image/png');
  console.log('   圖片上傳成功');

  console.log('4. 設為預設 Rich Menu...');
  await client.setDefaultRichMenu(richMenuId);
  console.log('   已設為預設 Rich Menu');

  console.log('\n✅ Rich Menu 建立完成！');
}

main().catch(err => {
  console.error('失敗:', err);
  process.exit(1);
});

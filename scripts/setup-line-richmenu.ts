/**
 * setup-line-richmenu.ts - LINE Rich Menu 設定腳本
 *
 * 用法：npx ts-node scripts/setup-line-richmenu.ts
 *
 * v2 布局 (2026-05-27)：Large menu 2500x1686，4 區「1+3」
 *   ┌─────────────────────────────────────┐
 *   │       一鍵叫車（全寬大）             │  2500x843
 *   ├─────────────┬──────────┬────────────┤
 *   │ 詳細叫車    │ 預約叫車  │ 查詢/取消  │  3 等分 x 843
 *   │  833x843    │ 834x843  │  833x843   │
 *   └─────────────┴──────────┴────────────┘
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { messagingApi } from '@line/bot-sdk';

dotenv.config();

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!channelAccessToken) {
  console.error('請設定 LINE_CHANNEL_ACCESS_TOKEN');
  process.exit(1);
}

const client = new messagingApi.MessagingApiClient({ channelAccessToken });

const LIFF_ID_BOOKING = process.env.LIFF_ID_BOOKING;
const LIFF_ID_TRACKING = process.env.LIFF_ID_TRACKING;

if (!LIFF_ID_BOOKING || !LIFF_ID_TRACKING) {
  console.error('請設定 LIFF_ID_BOOKING 和 LIFF_ID_TRACKING');
  process.exit(1);
}

async function setupRichMenu() {
  try {
    // 1. 建立 Rich Menu — Large (2500x1686) 4 區「1+3」layout
    const richMenu = await client.createRichMenu({
      size: { width: 2500, height: 1686 },
      selected: true,
      name: '花蓮計程車叫車選單 v2（含一鍵叫車）',
      chatBarText: '叫車選單',
      areas: [
        // 上半全寬 — 一鍵叫車
        {
          bounds: { x: 0, y: 0, width: 2500, height: 843 },
          action: {
            type: 'uri',
            uri: `https://liff.line.me/${LIFF_ID_BOOKING}?mode=oneclick`,
            label: '一鍵叫車',
          },
        },
        // 下半左 — 詳細叫車（原「叫車」flow）
        {
          bounds: { x: 0, y: 843, width: 833, height: 843 },
          action: {
            type: 'uri',
            uri: `https://liff.line.me/${LIFF_ID_BOOKING}?mode=call`,
            label: '詳細叫車',
          },
        },
        // 下半中 — 預約叫車（不動）
        {
          bounds: { x: 833, y: 843, width: 834, height: 843 },
          action: {
            type: 'uri',
            uri: `https://liff.line.me/${LIFF_ID_BOOKING}?mode=reserve`,
            label: '預約叫車',
          },
        },
        // 下半右 — 查詢/取消（不動）
        {
          bounds: { x: 1667, y: 843, width: 833, height: 843 },
          action: {
            type: 'uri',
            uri: `https://liff.line.me/${LIFF_ID_TRACKING}`,
            label: '查詢/取消',
          },
        },
      ],
    });

    console.log('Rich Menu 建立成功:', richMenu.richMenuId);

    // 2. 上傳圖片（如有提供）— 路徑：./richmenu-v2.png（同目錄）
    const imagePath = path.join(process.cwd(), 'richmenu-v2.png');
    if (fs.existsSync(imagePath)) {
      console.log(`\n發現圖片 ${imagePath}，自動上傳...`);
      const imageBuf = fs.readFileSync(imagePath);
      const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenu.richMenuId}/content`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channelAccessToken}`,
          'Content-Type': 'image/png',
        },
        body: imageBuf as any,
      });
      if (uploadRes.ok) {
        console.log('✓ 圖片上傳成功');
      } else {
        console.error('✗ 圖片上傳失敗:', uploadRes.status, await uploadRes.text());
      }
    } else {
      console.log(`\n⚠️  未發現 ${imagePath}，請手動上傳：`);
      console.log(`   圖片尺寸：2500 x 1686 px (PNG, ≤ 1MB)`);
      console.log(`   布局建議：上半（2500x843）「🚗 一鍵叫車」大字 / 下半 3 等分「詳細叫車｜預約叫車｜查詢取消」`);
      console.log(`\n   手動上傳指令：`);
      console.log(`   curl -X POST https://api-data.line.me/v2/bot/richmenu/${richMenu.richMenuId}/content \\`);
      console.log(`     -H "Authorization: Bearer \${LINE_CHANNEL_ACCESS_TOKEN}" \\`);
      console.log(`     -H "Content-Type: image/png" \\`);
      console.log(`     -T ./richmenu-v2.png`);
    }

    // 3. 設為預設 Rich Menu
    await client.setDefaultRichMenu(richMenu.richMenuId);
    console.log('\n✓ 已設為預設 Rich Menu，所有用戶下次開 LINE 會看到新版');

  } catch (error) {
    console.error('設定失敗:', error);
    process.exit(1);
  }
}

setupRichMenu();

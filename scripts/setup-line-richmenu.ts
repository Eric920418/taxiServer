/**
 * setup-line-richmenu.ts - LINE Rich Menu 設定腳本
 *
 * 用法：npx ts-node scripts/setup-line-richmenu.ts
 *
 * 建立三區塊 Rich Menu：叫車 | 預約叫車 | 查詢/取消
 */

import dotenv from 'dotenv';
import { messagingApi } from '@line/bot-sdk';

dotenv.config();

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!channelAccessToken) {
  console.error('請設定 LINE_CHANNEL_ACCESS_TOKEN');
  process.exit(1);
}

const client = new messagingApi.MessagingApiClient({ channelAccessToken });

async function setupRichMenu() {
  try {
    // 1. 建立 Rich Menu
    const richMenu = await client.createRichMenu({
      size: { width: 2500, height: 843 },
      selected: true,
      name: '花蓮計程車叫車選單',
      chatBarText: '叫車選單',
      areas: [
        {
          bounds: { x: 0, y: 0, width: 833, height: 843 },
          action: {
            type: 'postback',
            data: 'action=CALL_TAXI',
            displayText: '叫車',
          },
        },
        {
          bounds: { x: 833, y: 0, width: 834, height: 843 },
          action: {
            type: 'postback',
            data: 'action=RESERVE_TAXI',
            displayText: '預約叫車',
          },
        },
        {
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: {
            type: 'postback',
            data: 'action=CHECK_ORDER',
            displayText: '查詢/取消',
          },
        },
      ],
    });

    console.log('Rich Menu 建立成功:', richMenu.richMenuId);

    // 2. 設為預設 Rich Menu
    await client.setDefaultRichMenu(richMenu.richMenuId);
    console.log('已設為預設 Rich Menu');

    console.log('\n⚠️  請手動上傳 Rich Menu 圖片：');
    console.log(`   圖片尺寸：2500 x 843 px`);
    console.log(`   分三等份：叫車 | 預約叫車 | 查詢/取消`);
    console.log(`   上傳指令：curl -X POST https://api-data.line.me/v2/bot/richmenu/${richMenu.richMenuId}/content \\`);
    console.log(`     -H "Authorization: Bearer ${channelAccessToken?.substring(0, 20)}..." \\`);
    console.log(`     -H "Content-Type: image/png" \\`);
    console.log(`     -T ./richmenu.png`);

  } catch (error) {
    console.error('設定失敗:', error);
    process.exit(1);
  }
}

setupRichMenu();

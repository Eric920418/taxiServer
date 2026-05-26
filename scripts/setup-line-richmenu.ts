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

/** 清理：刪掉所有現存的 Rich Menu（避免後台堆積 empty/test menu） */
async function cleanupExistingMenus() {
  try {
    const res = await client.getRichMenuList();
    if (res.richmenus && res.richmenus.length > 0) {
      console.log(`[Cleanup] 發現 ${res.richmenus.length} 個現有 Rich Menu，全部刪除...`);
      for (const m of res.richmenus) {
        await client.deleteRichMenu(m.richMenuId);
        console.log(`  ✓ 已刪除 ${m.richMenuId} (${m.name})`);
      }
    } else {
      console.log('[Cleanup] 無現有 Rich Menu');
    }
  } catch (e: any) {
    console.warn('[Cleanup] 警告：清理舊 menu 失敗（不影響新建）:', e.message);
  }
}

async function setupRichMenu() {
  try {
    await cleanupExistingMenus();

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

    // 2. 上傳圖片（必要：LINE 規定 setDefault 前必須有圖）
    //    路徑：scripts/richmenu-v2.png（跟 script 同目錄，用 __dirname 才能無視 cwd）
    const imagePath = path.join(__dirname, 'richmenu-v2.png');
    if (!fs.existsSync(imagePath)) {
      console.error(`\n✗ 找不到圖片 ${imagePath}`);
      console.error('  請先把 richmenu-v2.png (2500x1686 PNG, ≤1MB) 放到 scripts/ 目錄');
      console.error(`  並手動清掉剛建的 menu: client.deleteRichMenu("${richMenu.richMenuId}")`);
      process.exit(1);
    }

    console.log(`\n發現圖片 ${imagePath}，上傳中...`);
    // line-bot-sdk v10 沒 setRichMenuImage method，要用 data-api endpoint
    // Node 18+ fetch 對 Buffer 支援不穩，改用 Uint8Array
    const imageBuf = fs.readFileSync(imagePath);
    const uploadRes = await fetch(
      `https://api-data.line.me/v2/bot/richmenu/${richMenu.richMenuId}/content`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channelAccessToken}`,
          'Content-Type': 'image/png',
          'Content-Length': String(imageBuf.length),
        },
        body: new Uint8Array(imageBuf),
      }
    );
    if (!uploadRes.ok) {
      console.error('✗ 圖片上傳失敗:', uploadRes.status, await uploadRes.text());
      console.error(`  手動清掉這個 menu: client.deleteRichMenu("${richMenu.richMenuId}")`);
      process.exit(1);
    }
    console.log('✓ 圖片上傳成功');

    // 3. 設為預設 Rich Menu
    await client.setDefaultRichMenu(richMenu.richMenuId);
    console.log('\n✓ 已設為預設 Rich Menu，所有用戶下次開 LINE 會看到新版');
    console.log(`   menu id: ${richMenu.richMenuId}`);

  } catch (error) {
    console.error('設定失敗:', error);
    process.exit(1);
  }
}

setupRichMenu();

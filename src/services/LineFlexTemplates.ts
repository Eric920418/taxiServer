/**
 * LineFlexTemplates - LINE Flex Message 模板集
 *
 * 集中管理所有 LINE Flex Message JSON 模板
 */

// 使用 messagingApi model 型別（v10 SDK 新 API）
import { messagingApi } from '@line/bot-sdk';
type Message = messagingApi.Message;
type FlexMessage = messagingApi.FlexMessage;
type FlexBubble = messagingApi.FlexBubble;

// ========== 歡迎訊息 ==========

/**
 * 主要入口 Bubble — 歡迎訊息和 IDLE 預設回覆共用
 *
 * 設計：一個大 CTA「立即叫車」+ 兩個小 link 按鈕（預約 / 查詢取消）
 * - Hero：簡潔藍底品牌
 * - Body：可點擊大盒子（主 CTA）+ 副提示
 * - Footer：兩個小 link 按鈕（次要動作）
 */
export function primaryEntryBubble(): FlexMessage {
  const liffBookingId = process.env.LIFF_ID_BOOKING || '';
  const liffTrackingId = process.env.LIFF_ID_TRACKING || '';

  const bookingUrl = liffBookingId ? `https://liff.line.me/${liffBookingId}?mode=call` : '';
  const reserveUrl = liffBookingId ? `https://liff.line.me/${liffBookingId}?mode=reserve` : '';
  const trackingUrl = liffTrackingId ? `https://liff.line.me/${liffTrackingId}` : '';

  // 主 CTA action：有 LIFF 用 URI，沒有 fallback 到 postback
  const primaryAction: any = bookingUrl
    ? { type: 'uri', label: '立即叫車', uri: bookingUrl }
    : { type: 'postback', label: '立即叫車', data: 'action=CALL_TAXI', displayText: '叫車' };

  // Footer 次要按鈕
  const footerContents: any[] = [
    {
      type: 'button',
      style: 'link',
      height: 'sm',
      flex: 1,
      action: reserveUrl
        ? { type: 'uri', label: '預約叫車', uri: reserveUrl }
        : { type: 'postback', label: '預約叫車', data: 'action=RESERVE_TAXI', displayText: '預約' },
    },
    {
      type: 'button',
      style: 'link',
      height: 'sm',
      flex: 1,
      action: trackingUrl
        ? { type: 'uri', label: '查詢/取消', uri: trackingUrl }
        : { type: 'postback', label: '查詢/取消', data: 'action=CHECK_ORDER', displayText: '查詢訂單' },
    },
  ];

  const bubble: FlexBubble = {
    type: 'bubble',
    size: 'mega',

    // Hero：簡潔品牌列
    hero: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#2196F3',
      paddingAll: '16px',
      contents: [
        {
          type: 'text',
          text: '花蓮計程車',
          weight: 'bold',
          size: 'xl',
          color: '#FFFFFF',
          align: 'center',
        },
        {
          type: 'text',
          text: 'Hualien Taxi',
          size: 'xs',
          color: '#E3F2FD',
          align: 'center',
          margin: 'xs',
        },
      ],
    },

    // Body：可點擊大 CTA 盒子 + 副提示
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      spacing: 'md',
      contents: [
        {
          // 可點擊的大盒子（取代普通 button，可控制大小）
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#1E88E5',
          cornerRadius: '12px',
          paddingAll: '24px',
          spacing: 'sm',
          action: primaryAction,
          contents: [
            {
              type: 'text',
              text: '🚕  立即叫車',
              color: '#FFFFFF',
              size: 'xxl',
              weight: 'bold',
              align: 'center',
            },
            {
              type: 'text',
              text: '點我開啟地圖選位置',
              color: '#BBDEFB',
              size: 'sm',
              align: 'center',
              margin: 'sm',
            },
          ],
        },
        {
          type: 'separator',
          margin: 'lg',
          color: '#EEEEEE',
        },
        {
          type: 'text',
          text: '或直接輸入上車地點傳給我',
          size: 'xs',
          color: '#AAAAAA',
          align: 'center',
          margin: 'md',
          wrap: true,
        },
      ],
    },

    // Footer：兩個小 link 按鈕水平排列
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      paddingAll: '8px',
      contents: footerContents,
    },
  };

  return {
    type: 'flex',
    altText: '花蓮計程車 - 立即叫車',
    contents: bubble,
  };
}

/**
 * 歡迎訊息（向後相容，delegate 到 primaryEntryBubble）
 */
export function welcomeMessage(): FlexMessage {
  return primaryEntryBubble();
}

// ========== 請求上車地點 ==========

export function askPickupMessage(): Message {
  return {
    type: 'text',
    text: '請傳送您的「位置」或輸入上車地址：',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'location',
            label: '傳送位置',
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '取消叫車',
            data: 'action=CANCEL_FLOW',
            displayText: '取消',
          },
        },
      ],
    },
  };
}

// ========== 請求目的地 ==========

export function askDestinationMessage(): Message {
  return {
    type: 'text',
    text: '請傳送目的地「位置」或輸入地址：',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'location',
            label: '傳送位置',
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '不指定目的地',
            data: 'action=SKIP_DESTINATION',
            displayText: '不指定目的地',
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '取消叫車',
            data: 'action=CANCEL_FLOW',
            displayText: '取消',
          },
        },
      ],
    },
  };
}

// ========== 叫車確認卡 ==========

export function orderConfirmCard(
  pickupAddress: string,
  destAddress: string | null,
  estimatedFare: number | null
): FlexMessage {
  const bodyContents: any[] = [
    {
      type: 'text',
      text: '確認叫車資訊',
      weight: 'bold',
      size: 'lg',
    },
    { type: 'separator', margin: 'md' },
    {
      type: 'box',
      layout: 'vertical',
      margin: 'md',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: '上車點', size: 'sm', color: '#999999', flex: 2 },
            { type: 'text', text: pickupAddress, size: 'sm', color: '#333333', flex: 5, wrap: true },
          ],
        },
        {
          type: 'box',
          layout: 'horizontal',
          margin: 'sm',
          contents: [
            { type: 'text', text: '目的地', size: 'sm', color: '#999999', flex: 2 },
            { type: 'text', text: destAddress || '未指定', size: 'sm', color: '#333333', flex: 5, wrap: true },
          ],
        },
      ],
    },
  ];

  if (estimatedFare) {
    bodyContents.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'md',
      contents: [
        { type: 'text', text: '預估車資', size: 'sm', color: '#999999', flex: 2 },
        { type: 'text', text: `$${estimatedFare}`, size: 'sm', color: '#FF6B35', weight: 'bold', flex: 5 },
      ],
    });
  }

  const bubble: FlexBubble = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: bodyContents,
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#2196F3',
          action: {
            type: 'postback',
            label: '確認叫車',
            data: 'action=CONFIRM_ORDER',
            displayText: '確認叫車',
          },
        },
        {
          type: 'button',
          style: 'secondary',
          action: {
            type: 'postback',
            label: '取消',
            data: 'action=CANCEL_FLOW',
            displayText: '取消',
          },
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: `確認叫車：${pickupAddress} → ${destAddress || '未指定'}`,
    contents: bubble,
  };
}

// ========== 訂單已建立 ==========

export function orderCreatedCard(orderId: string, pickupAddress: string): FlexMessage {
  const liffTrackingId = process.env.LIFF_ID_TRACKING || '';
  const trackingUrl = liffTrackingId ? `https://liff.line.me/${liffTrackingId}` : '';

  const bubble: FlexBubble = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '叫車成功！',
          weight: 'bold',
          size: 'xl',
          color: '#4CAF50',
        },
        {
          type: 'text',
          text: '正在為您媒合司機，請稍候',
          size: 'sm',
          color: '#666666',
          margin: 'xs',
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: '上車點', size: 'sm', color: '#999999', flex: 2 },
                { type: 'text', text: pickupAddress, size: 'sm', color: '#333333', flex: 5, wrap: true },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'sm',
              contents: [
                { type: 'text', text: '訂單', size: 'sm', color: '#999999', flex: 2 },
                { type: 'text', text: orderId, size: 'xs', color: '#AAAAAA', flex: 5, wrap: true },
              ],
            },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'lg',
              backgroundColor: '#FFF3E0',
              cornerRadius: '8px',
              paddingAll: '12px',
              contents: [
                {
                  type: 'text',
                  text: '🔍  尋找附近司機中...',
                  size: 'md',
                  color: '#E65100',
                  weight: 'bold',
                  align: 'center',
                },
                {
                  type: 'text',
                  text: '找到司機後會立即通知您',
                  size: 'xs',
                  color: '#999999',
                  align: 'center',
                  margin: 'xs',
                },
              ],
            },
          ],
        },
      ],
    },
    ...(trackingUrl ? {
      footer: {
        type: 'box' as const,
        layout: 'vertical' as const,
        contents: [
          {
            type: 'button' as const,
            style: 'secondary' as const,
            height: 'sm' as const,
            action: {
              type: 'uri' as const,
              label: '查看派單狀態',
              uri: trackingUrl,
            },
          },
        ],
      },
    } : {}),
  };

  return {
    type: 'flex',
    altText: `叫車成功！正在為您媒合司機，請稍候...`,
    contents: bubble,
  };
}

// ========== 司機接單通知 ==========

export function driverAcceptedCard(
  orderId: string,
  driverName: string,
  plate: string,
  etaMinutes: number | null
): FlexMessage {
  const etaText = etaMinutes ? `預計 ${etaMinutes} 分鐘後到達上車點` : '司機正在前往您的上車點';

  const liffTrackingId = process.env.LIFF_ID_TRACKING || '';
  const trackingUrl = liffTrackingId ? `https://liff.line.me/${liffTrackingId}` : '';

  const bubble: FlexBubble = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '已媒合到車！',
          weight: 'bold',
          size: 'xl',
          color: '#4CAF50',
        },
        {
          type: 'text',
          text: '司機正在路上，請稍候',
          size: 'sm',
          color: '#666666',
          margin: 'xs',
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: '司機', size: 'sm', color: '#999999', flex: 2 },
                { type: 'text', text: driverName, size: 'md', color: '#333333', weight: 'bold', flex: 5 },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'sm',
              contents: [
                { type: 'text', text: '車牌', size: 'sm', color: '#999999', flex: 2 },
                { type: 'text', text: plate, size: 'xl', color: '#FF6B35', weight: 'bold', flex: 5 },
              ],
            },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'lg',
              backgroundColor: '#E3F2FD',
              cornerRadius: '8px',
              paddingAll: '12px',
              contents: [
                {
                  type: 'text',
                  text: etaText,
                  size: 'md',
                  color: '#1976D2',
                  weight: 'bold',
                  align: 'center',
                  wrap: true,
                },
              ],
            },
          ],
        },
      ],
    },
    ...(trackingUrl ? {
      footer: {
        type: 'box' as const,
        layout: 'vertical' as const,
        contents: [
          {
            type: 'button' as const,
            style: 'primary' as const,
            color: '#2196F3',
            height: 'md' as const,
            action: {
              type: 'uri' as const,
              label: '即時追蹤司機位置',
              uri: trackingUrl,
            },
          },
        ],
      },
    } : {}),
  };

  return {
    type: 'flex',
    altText: `已媒合到車！司機 ${driverName}（${plate}）正在路上，${etaText}`,
    contents: bubble,
  };
}

// ========== 行程完成通知 ==========

export function tripCompletedCard(orderId: string, fare: number): FlexMessage {
  const bubble: FlexBubble = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '行程完成',
          weight: 'bold',
          size: 'lg',
          color: '#4CAF50',
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: '訂單編號', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: orderId, size: 'sm', color: '#333333', flex: 5 },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'sm',
              contents: [
                { type: 'text', text: '車資', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: `$${fare}`, size: 'xl', color: '#FF6B35', weight: 'bold', flex: 5 },
              ],
            },
          ],
        },
        {
          type: 'text',
          text: '感謝搭乘！歡迎下次再使用',
          size: 'sm',
          color: '#999999',
          margin: 'lg',
          wrap: true,
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: `行程完成，車資 $${fare}`,
    contents: bubble,
  };
}

// ========== 訂單取消通知 ==========

export function orderCancelledCard(orderId: string, reason: string): FlexMessage {
  const bubble: FlexBubble = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '訂單已取消',
          weight: 'bold',
          size: 'lg',
          color: '#F44336',
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: '訂單編號', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: orderId, size: 'sm', color: '#333333', flex: 5 },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'sm',
              contents: [
                { type: 'text', text: '原因', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: reason, size: 'sm', color: '#333333', flex: 5, wrap: true },
              ],
            },
          ],
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: `訂單 ${orderId} 已取消：${reason}`,
    contents: bubble,
  };
}

// ========== 無可用司機 ==========

export function noDriverCard(): Message {
  return {
    type: 'text',
    text: '目前附近沒有可用司機，請稍後再試。您也可以直接撥打叫車專線。',
  };
}

// ========== 取消確認卡 ==========

export function cancelConfirmCard(orderId: string, pickupAddress: string, status: string): FlexMessage {
  const statusMap: Record<string, string> = {
    WAITING: '等待派單',
    OFFERED: '等待司機接單',
    ACCEPTED: '司機已接單',
  };

  const bubble: FlexBubble = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '確認取消訂單？',
          weight: 'bold',
          size: 'lg',
          color: '#F44336',
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: '訂單編號', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: orderId, size: 'sm', color: '#333333', flex: 5 },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'sm',
              contents: [
                { type: 'text', text: '上車點', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: pickupAddress, size: 'sm', color: '#333333', flex: 5, wrap: true },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'sm',
              contents: [
                { type: 'text', text: '狀態', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: statusMap[status] || status, size: 'sm', color: '#333333', flex: 5 },
              ],
            },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#F44336',
          action: {
            type: 'postback',
            label: '確認取消',
            data: `action=CONFIRM_CANCEL&orderId=${orderId}`,
            displayText: '確認取消訂單',
          },
        },
        {
          type: 'button',
          style: 'secondary',
          action: {
            type: 'postback',
            label: '不取消',
            data: 'action=CANCEL_FLOW',
            displayText: '不取消',
          },
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: `確認取消訂單 ${orderId}？`,
    contents: bubble,
  };
}

// ========== 預約確認卡 ==========

export function scheduleConfirmCard(
  pickupAddress: string,
  destAddress: string | null,
  scheduledTime: string
): FlexMessage {
  const bubble: FlexBubble = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '確認預約叫車',
          weight: 'bold',
          size: 'lg',
          color: '#FF9800',
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: '預約時間', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: scheduledTime, size: 'sm', color: '#FF9800', weight: 'bold', flex: 5, wrap: true },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'sm',
              contents: [
                { type: 'text', text: '上車點', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: pickupAddress, size: 'sm', color: '#333333', flex: 5, wrap: true },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'sm',
              contents: [
                { type: 'text', text: '目的地', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: destAddress || '未指定', size: 'sm', color: '#333333', flex: 5, wrap: true },
              ],
            },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#FF9800',
          action: {
            type: 'postback',
            label: '確認預約',
            data: 'action=CONFIRM_SCHEDULE',
            displayText: '確認預約',
          },
        },
        {
          type: 'button',
          style: 'secondary',
          action: {
            type: 'postback',
            label: '取消',
            data: 'action=CANCEL_FLOW',
            displayText: '取消',
          },
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: `確認預約：${scheduledTime} 從 ${pickupAddress} 出發`,
    contents: bubble,
  };
}

// ========== 預約成功通知 ==========

export function scheduleCreatedCard(orderId: string, scheduledTime: string, pickupAddress: string): FlexMessage {
  const bubble: FlexBubble = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '預約成功！',
          weight: 'bold',
          size: 'lg',
          color: '#FF9800',
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: '訂單編號', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: orderId, size: 'sm', color: '#333333', flex: 5 },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'sm',
              contents: [
                { type: 'text', text: '預約時間', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: scheduledTime, size: 'sm', color: '#FF9800', weight: 'bold', flex: 5, wrap: true },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'sm',
              contents: [
                { type: 'text', text: '上車點', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: pickupAddress, size: 'sm', color: '#333333', flex: 5, wrap: true },
              ],
            },
          ],
        },
        {
          type: 'text',
          text: '我們會在出發前 15 分鐘通知您',
          size: 'sm',
          color: '#999999',
          margin: 'lg',
          wrap: true,
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: `預約成功！${scheduledTime} 從 ${pickupAddress} 出發`,
    contents: bubble,
  };
}

// ========== 預約提醒 ==========

export function scheduleReminderCard(orderId: string, scheduledTime: string, pickupAddress: string): FlexMessage {
  const bubble: FlexBubble = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '預約提醒',
          weight: 'bold',
          size: 'lg',
          color: '#FF9800',
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'text',
          text: `您預約的車將在 15 分鐘後出發`,
          size: 'md',
          margin: 'md',
          wrap: true,
        },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: '預約時間', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: scheduledTime, size: 'sm', color: '#FF9800', weight: 'bold', flex: 5 },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'sm',
              contents: [
                { type: 'text', text: '上車點', size: 'sm', color: '#999999', flex: 3 },
                { type: 'text', text: pickupAddress, size: 'sm', color: '#333333', flex: 5, wrap: true },
              ],
            },
          ],
        },
        {
          type: 'text',
          text: '請準備前往上車點',
          size: 'sm',
          color: '#2196F3',
          margin: 'lg',
          wrap: true,
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: `預約提醒：${scheduledTime} 的車即將出發`,
    contents: bubble,
  };
}

// ========== 請選擇預約時間 ==========

export function askScheduleTimeMessage(): Message {
  return {
    type: 'text',
    text: '請選擇預約時間：',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'datetimepicker',
            label: '選擇日期時間',
            data: 'action=PICK_DATETIME',
            mode: 'datetime',
            min: new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(0, 16),
            max: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '取消',
            data: 'action=CANCEL_FLOW',
            displayText: '取消',
          },
        },
      ],
    },
  };
}

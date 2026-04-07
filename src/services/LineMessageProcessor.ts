/**
 * LineMessageProcessor - LINE 叫車核心處理引擎
 *
 * 狀態機管理 LINE 使用者的對話流程：叫車、取消、預約
 */

import { Pool } from 'pg';
import { messagingApi, WebhookEvent, MessageEvent, PostbackEvent, FollowEvent, EventMessage } from '@line/bot-sdk';
import OpenAI from 'openai';
import { getSmartDispatcherV2, OrderData } from './SmartDispatcherV2';
import { getSocketIO, driverSockets } from '../socket';
import { hualienAddressDB } from './HualienAddressDB';
import { cacheApiResponse, getCachedApiResponse } from './cache';
import { getScheduledOrderService } from './ScheduledOrderService';
import * as templates from './LineFlexTemplates';

// ========== 類型定義 ==========

interface LineUser {
  line_user_id: string;
  passenger_id: string;
  display_name: string;
  conversation_state: string;
  conversation_data: any;
}

interface ConversationData {
  mode?: 'CALL' | 'RESERVE';
  pickupAddress?: string;
  pickupLat?: number;
  pickupLng?: number;
  destAddress?: string;
  destLat?: number;
  destLng?: number;
  scheduledAt?: string;
  estimatedFare?: number;
}

interface GeocodingResult {
  lat: number;
  lng: number;
  formattedAddress: string;
}

interface ParsedIntent {
  type: 'CALL_TAXI' | 'CANCEL' | 'RESERVE' | 'QUERY' | 'UNKNOWN';
  pickupAddress?: string;
  destAddress?: string;
  scheduledTime?: string;
}

// ========== 服務類 ==========

export class LineMessageProcessor {
  private pool: Pool;
  private lineClient: messagingApi.MessagingApiClient;
  private openai: OpenAI | null;
  private googleMapsApiKey: string;

  constructor(pool: Pool) {
    this.pool = pool;

    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!channelAccessToken) {
      throw new Error('LINE_CHANNEL_ACCESS_TOKEN is required');
    }

    this.lineClient = new messagingApi.MessagingApiClient({ channelAccessToken });
    this.googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || '';

    const openaiKey = process.env.OPENAI_API_KEY;
    this.openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;
  }

  // ========== 事件分派 ==========

  async processEvent(event: WebhookEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'follow':
          await this.handleFollow(event as FollowEvent);
          break;
        case 'message':
          await this.handleMessage(event as MessageEvent);
          break;
        case 'postback':
          await this.handlePostback(event as PostbackEvent);
          break;
        default:
          console.log(`[LINE] 忽略事件類型: ${event.type}`);
      }
    } catch (error: any) {
      console.error(`[LINE] 處理事件失敗:`, error);
    }
  }

  // ========== Follow 事件 ==========

  private async handleFollow(event: FollowEvent): Promise<void> {
    const userId = event.source.userId;
    if (!userId) return;

    console.log(`[LINE] 新好友加入: ${userId}`);
    await this.getOrCreateLineUser(userId);

    await this.lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [templates.welcomeMessage()],
    });
  }

  // ========== Message 事件 ==========

  private async handleMessage(event: MessageEvent): Promise<void> {
    const userId = event.source.userId;
    if (!userId) return;

    const lineUser = await this.getOrCreateLineUser(userId);

    if (event.message.type === 'text') {
      await this.handleTextMessage(userId, lineUser, event.message.text, event.replyToken);
    } else if (event.message.type === 'location') {
      const { latitude, longitude, address } = event.message;
      await this.handleLocationMessage(userId, lineUser, latitude, longitude, address || '', event.replyToken);
    } else {
      await this.lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '請傳送文字訊息或位置。輸入「叫車」開始叫車！' }],
      });
    }
  }

  // ========== Postback 事件 ==========

  private async handlePostback(event: PostbackEvent): Promise<void> {
    const userId = event.source.userId;
    if (!userId) return;

    const lineUser = await this.getOrCreateLineUser(userId);
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    console.log(`[LINE] Postback: userId=${userId}, action=${action}`);

    switch (action) {
      case 'CALL_TAXI':
        await this.startCallTaxi(userId, 'CALL', event.replyToken);
        break;

      case 'RESERVE_TAXI':
        await this.startCallTaxi(userId, 'RESERVE', event.replyToken);
        break;

      case 'CHECK_ORDER':
        await this.handleCheckOrCancel(userId, lineUser, event.replyToken);
        break;

      case 'SKIP_DESTINATION':
        await this.handleSkipDestination(userId, lineUser, event.replyToken);
        break;

      case 'CONFIRM_ORDER':
        await this.handleConfirmOrder(userId, lineUser, event.replyToken);
        break;

      case 'CONFIRM_SCHEDULE':
        await this.handleConfirmSchedule(userId, lineUser, event.replyToken);
        break;

      case 'CONFIRM_CANCEL': {
        const orderId = params.get('orderId');
        if (orderId) {
          await this.handleConfirmCancel(userId, orderId, event.replyToken);
        }
        break;
      }

      case 'CANCEL_FLOW':
        await this.resetConversation(userId);
        await this.lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '已取消。有需要隨時輸入「叫車」！' }],
        });
        break;

      case 'PICK_DATETIME': {
        const postbackParams = event.postback.params as any;
        const datetime = postbackParams?.datetime;
        if (datetime) {
          await this.handleDatetimePicked(userId, lineUser, datetime, event.replyToken);
        }
        break;
      }

      default:
        console.log(`[LINE] 未知 postback action: ${action}`);
    }
  }

  // ========== 文字訊息處理 ==========

  private async handleTextMessage(
    userId: string,
    lineUser: LineUser,
    text: string,
    replyToken: string
  ): Promise<void> {
    const trimmed = text.trim();
    const state = lineUser.conversation_state;

    // 關鍵字觸發（任何狀態都可以重新開始）
    if (/^(叫車|我要叫車|call|taxi)$/i.test(trimmed)) {
      await this.startCallTaxi(userId, 'CALL', replyToken);
      return;
    }
    if (/^(預約|預約叫車|reserve|book)$/i.test(trimmed)) {
      await this.startCallTaxi(userId, 'RESERVE', replyToken);
      return;
    }
    if (/^(取消|取消訂單|cancel)$/i.test(trimmed)) {
      await this.handleCheckOrCancel(userId, lineUser, replyToken);
      return;
    }
    if (/^(查詢|訂單|status|query)$/i.test(trimmed)) {
      await this.handleQueryOrder(userId, replyToken);
      return;
    }

    // 狀態機處理
    switch (state) {
      case 'AWAITING_PICKUP':
      case 'AWAITING_DESTINATION':
        // 使用者輸入地址文字
        await this.handleAddressInput(userId, lineUser, trimmed, replyToken);
        break;

      case 'IDLE':
      default:
        // GPT 自然語言解析 fallback
        if (this.openai && trimmed.length > 3) {
          await this.handleNaturalLanguage(userId, trimmed, replyToken);
        } else {
          // 顯示主要入口 Flex Bubble（與歡迎訊息一致）
          await this.lineClient.replyMessage({
            replyToken,
            messages: [templates.primaryEntryBubble()],
          });
        }
        break;
    }
  }

  // ========== 位置訊息處理 ==========

  private async handleLocationMessage(
    userId: string,
    lineUser: LineUser,
    lat: number,
    lng: number,
    address: string,
    replyToken: string
  ): Promise<void> {
    const state = lineUser.conversation_state;
    const data: ConversationData = lineUser.conversation_data || {};

    if (state === 'AWAITING_PICKUP' || state === 'IDLE') {
      // 儲存上車地點
      data.pickupLat = lat;
      data.pickupLng = lng;
      data.pickupAddress = address || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

      await this.updateConversationState(userId, 'AWAITING_DESTINATION', data);
      await this.lineClient.replyMessage({
        replyToken,
        messages: [templates.askDestinationMessage()],
      });

    } else if (state === 'AWAITING_DESTINATION') {
      // 儲存目的地
      data.destLat = lat;
      data.destLng = lng;
      data.destAddress = address || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

      await this.showConfirmCard(userId, data, replyToken);

    } else {
      // 非預期狀態，當作上車地點開始新流程
      const newData: ConversationData = {
        mode: 'CALL',
        pickupLat: lat,
        pickupLng: lng,
        pickupAddress: address || `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      };
      await this.updateConversationState(userId, 'AWAITING_DESTINATION', newData);
      await this.lineClient.replyMessage({
        replyToken,
        messages: [templates.askDestinationMessage()],
      });
    }
  }

  // ========== 業務邏輯 ==========

  private async startCallTaxi(userId: string, mode: 'CALL' | 'RESERVE', replyToken: string): Promise<void> {
    await this.updateConversationState(userId, 'AWAITING_PICKUP', { mode });
    await this.lineClient.replyMessage({
      replyToken,
      messages: [templates.askPickupMessage()],
    });
  }

  private async handleSkipDestination(userId: string, lineUser: LineUser, replyToken: string): Promise<void> {
    const data: ConversationData = lineUser.conversation_data || {};
    data.destAddress = undefined;
    data.destLat = undefined;
    data.destLng = undefined;
    await this.showConfirmCard(userId, data, replyToken);
  }

  private async showConfirmCard(userId: string, data: ConversationData, replyToken: string): Promise<void> {
    if (data.mode === 'RESERVE') {
      // 預約模式：先選時間
      await this.updateConversationState(userId, 'AWAITING_SCHEDULE_TIME', data);
      await this.lineClient.replyMessage({
        replyToken,
        messages: [templates.askScheduleTimeMessage()],
      });
    } else {
      // 即時叫車：顯示確認卡
      await this.updateConversationState(userId, 'AWAITING_CONFIRM', data);
      await this.lineClient.replyMessage({
        replyToken,
        messages: [templates.orderConfirmCard(
          data.pickupAddress || '未知',
          data.destAddress || null,
          data.estimatedFare || null,
        )],
      });
    }
  }

  private async handleDatetimePicked(
    userId: string,
    lineUser: LineUser,
    datetime: string,
    replyToken: string
  ): Promise<void> {
    const data: ConversationData = lineUser.conversation_data || {};
    const scheduledDate = new Date(datetime);
    const now = new Date();

    // 驗證：至少 30 分鐘後
    if (scheduledDate.getTime() - now.getTime() < 25 * 60 * 1000) {
      await this.lineClient.replyMessage({
        replyToken,
        messages: [
          { type: 'text', text: '預約時間至少要在 30 分鐘後，請重新選擇。' },
          templates.askScheduleTimeMessage(),
        ],
      });
      return;
    }

    // 驗證：最多 7 天後
    if (scheduledDate.getTime() - now.getTime() > 7 * 24 * 60 * 60 * 1000) {
      await this.lineClient.replyMessage({
        replyToken,
        messages: [
          { type: 'text', text: '預約時間不能超過 7 天，請重新選擇。' },
          templates.askScheduleTimeMessage(),
        ],
      });
      return;
    }

    data.scheduledAt = datetime;
    const formattedTime = this.formatDateTime(scheduledDate);

    await this.updateConversationState(userId, 'AWAITING_SCHEDULE_CONFIRM', data);
    await this.lineClient.replyMessage({
      replyToken,
      messages: [templates.scheduleConfirmCard(
        data.pickupAddress || '未知',
        data.destAddress || null,
        formattedTime,
      )],
    });
  }

  private async handleConfirmOrder(userId: string, lineUser: LineUser, replyToken: string): Promise<void> {
    const data: ConversationData = lineUser.conversation_data || {};

    if (!data.pickupAddress && !data.pickupLat) {
      await this.lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: '缺少上車地點資訊，請重新叫車。' }],
      });
      await this.resetConversation(userId);
      return;
    }

    try {
      // Geocoding（如果沒有座標）
      if (!data.pickupLat && data.pickupAddress) {
        const geo = await this.geocodeAddress(data.pickupAddress);
        if (geo) {
          data.pickupLat = geo.lat;
          data.pickupLng = geo.lng;
          data.pickupAddress = geo.formattedAddress;
        } else {
          // 使用花蓮預設座標
          data.pickupLat = 23.9871;
          data.pickupLng = 121.6015;
        }
      }

      if (data.destAddress && !data.destLat) {
        const geo = await this.geocodeAddress(data.destAddress);
        if (geo) {
          data.destLat = geo.lat;
          data.destLng = geo.lng;
          data.destAddress = geo.formattedAddress;
        }
      }

      // 建立訂單
      const orderId = await this.createLineOrder(userId, data);

      // 回覆確認
      await this.lineClient.replyMessage({
        replyToken,
        messages: [templates.orderCreatedCard(orderId, data.pickupAddress || '已定位')],
      });

      // 重置對話
      await this.resetConversation(userId);

      // 觸發派單
      const lineUser = await this.getLineUser(userId);
      if (!lineUser) return;

      const dispatcher = getSmartDispatcherV2();
      const orderData: OrderData = {
        orderId,
        passengerId: lineUser.passenger_id,
        passengerName: lineUser.display_name || 'LINE 用戶',
        passengerPhone: '',
        pickup: {
          lat: data.pickupLat!,
          lng: data.pickupLng!,
          address: data.pickupAddress || '',
        },
        destination: data.destLat ? {
          lat: data.destLat,
          lng: data.destLng!,
          address: data.destAddress || '',
        } : null,
        paymentType: 'CASH',
        createdAt: Date.now(),
        source: 'LINE',
      };

      await dispatcher.startDispatch(orderData);
      console.log(`[LINE] 訂單 ${orderId} 已派單`);

    } catch (error: any) {
      console.error(`[LINE] 建單失敗:`, error);
      await this.lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: `叫車失敗：${error.message}` }],
      });
      await this.resetConversation(userId);
    }
  }

  private async handleConfirmSchedule(userId: string, lineUser: LineUser, replyToken: string): Promise<void> {
    const data: ConversationData = lineUser.conversation_data || {};

    if (!data.pickupAddress || !data.scheduledAt) {
      await this.lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: '預約資訊不完整，請重新操作。' }],
      });
      await this.resetConversation(userId);
      return;
    }

    try {
      // Geocoding
      if (!data.pickupLat && data.pickupAddress) {
        const geo = await this.geocodeAddress(data.pickupAddress);
        if (geo) {
          data.pickupLat = geo.lat;
          data.pickupLng = geo.lng;
          data.pickupAddress = geo.formattedAddress;
        } else {
          data.pickupLat = 23.9871;
          data.pickupLng = 121.6015;
        }
      }

      if (data.destAddress && !data.destLat) {
        const geo = await this.geocodeAddress(data.destAddress);
        if (geo) {
          data.destLat = geo.lat;
          data.destLng = geo.lng;
          data.destAddress = geo.formattedAddress;
        }
      }

      // 建立預約訂單
      const orderId = await this.createScheduledOrder(userId, data);
      const formattedTime = this.formatDateTime(new Date(data.scheduledAt));

      // 加入 Bull Queue 排程
      const scheduler = getScheduledOrderService();
      if (scheduler) {
        await scheduler.scheduleOrder(orderId, new Date(data.scheduledAt));
      }

      await this.lineClient.replyMessage({
        replyToken,
        messages: [templates.scheduleCreatedCard(orderId, formattedTime, data.pickupAddress || '已定位')],
      });

      await this.resetConversation(userId);
      console.log(`[LINE] 預約訂單 ${orderId} 已建立，排程時間: ${data.scheduledAt}`);

    } catch (error: any) {
      console.error(`[LINE] 預約建單失敗:`, error);
      await this.lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: `預約失敗：${error.message}` }],
      });
      await this.resetConversation(userId);
    }
  }

  private async handleCheckOrCancel(userId: string, lineUser: LineUser, replyToken: string): Promise<void> {
    const activeOrder = await this.findActiveOrderByLineUser(userId);

    if (!activeOrder) {
      await this.lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: '您目前沒有進行中的訂單。' }],
      });
      return;
    }

    await this.updateConversationState(userId, 'AWAITING_CANCEL_CONFIRM', {});
    await this.lineClient.replyMessage({
      replyToken,
      messages: [templates.cancelConfirmCard(
        activeOrder.order_id,
        activeOrder.pickup_address,
        activeOrder.status,
      )],
    });
  }

  private async handleQueryOrder(userId: string, replyToken: string): Promise<void> {
    const activeOrder = await this.findActiveOrderByLineUser(userId);

    if (!activeOrder) {
      await this.lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: '您目前沒有進行中的訂單。' }],
      });
      return;
    }

    const statusMap: Record<string, string> = {
      WAITING: '等待派單中',
      OFFERED: '等待司機接單',
      ACCEPTED: '司機已接單',
      ARRIVED: '司機已到達上車點',
      ON_TRIP: '行程進行中',
      SCHEDULED: '已預約',
    };

    let msg = `訂單 ${activeOrder.order_id}\n狀態：${statusMap[activeOrder.status] || activeOrder.status}\n上車點：${activeOrder.pickup_address}`;
    if (activeOrder.driver_id) {
      const driver = await this.pool.query('SELECT name, plate FROM drivers WHERE driver_id = $1', [activeOrder.driver_id]);
      if (driver.rows[0]) {
        msg += `\n司機：${driver.rows[0].name}（${driver.rows[0].plate}）`;
      }
    }

    await this.lineClient.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: msg }],
    });
  }

  private async handleConfirmCancel(userId: string, orderId: string, replyToken: string): Promise<void> {
    try {
      const result = await this.pool.query(
        `UPDATE orders SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE order_id = $1 AND status IN ('WAITING', 'OFFERED', 'ACCEPTED', 'SCHEDULED') RETURNING driver_id, scheduled_at`,
        [orderId]
      );

      if (result.rowCount === 0) {
        await this.lineClient.replyMessage({
          replyToken,
          messages: [{ type: 'text', text: '訂單無法取消（可能已在行程中或已完成）。' }],
        });
        return;
      }

      // 取消 Bull Queue 預約排程
      if (result.rows[0]?.scheduled_at) {
        const scheduler = getScheduledOrderService();
        if (scheduler) {
          scheduler.cancelScheduled(orderId).catch(err => console.error('[LINE] 取消排程失敗:', err));
        }
      }

      // 通知司機
      const driverId = result.rows[0]?.driver_id;
      if (driverId) {
        const io = getSocketIO();
        const socketId = driverSockets.get(driverId);
        if (socketId) {
          io.to(socketId).emit('order:status', {
            orderId,
            status: 'CANCELLED',
            message: 'LINE 乘客取消訂單',
          });
        }
      }

      await this.lineClient.replyMessage({
        replyToken,
        messages: [templates.orderCancelledCard(orderId, '乘客取消')],
      });

      await this.resetConversation(userId);
      console.log(`[LINE] 訂單 ${orderId} 已取消`);

    } catch (error: any) {
      console.error(`[LINE] 取消訂單失敗:`, error);
      await this.lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: `取消失敗：${error.message}` }],
      });
    }
  }

  // ========== 地址輸入處理 ==========

  private async handleAddressInput(
    userId: string,
    lineUser: LineUser,
    address: string,
    replyToken: string
  ): Promise<void> {
    const state = lineUser.conversation_state;
    const data: ConversationData = lineUser.conversation_data || {};

    // 嘗試 Geocoding
    const geo = await this.geocodeAddress(address);

    if (state === 'AWAITING_PICKUP') {
      data.pickupAddress = geo?.formattedAddress || address;
      data.pickupLat = geo?.lat;
      data.pickupLng = geo?.lng;

      await this.updateConversationState(userId, 'AWAITING_DESTINATION', data);
      await this.lineClient.replyMessage({
        replyToken,
        messages: [templates.askDestinationMessage()],
      });

    } else if (state === 'AWAITING_DESTINATION') {
      data.destAddress = geo?.formattedAddress || address;
      data.destLat = geo?.lat;
      data.destLng = geo?.lng;

      await this.showConfirmCard(userId, data, replyToken);
    }
  }

  // ========== GPT 自然語言解析 ==========

  private async handleNaturalLanguage(userId: string, text: string, replyToken: string): Promise<void> {
    if (!this.openai) {
      await this.lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: '輸入「叫車」開始叫車！' }],
      });
      return;
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [
          {
            role: 'system',
            content: `你是花蓮計程車 LINE 叫車助手。分析使用者訊息，提取叫車意圖。
回傳 JSON 格式：
{
  "type": "CALL_TAXI" | "CANCEL" | "RESERVE" | "QUERY" | "UNKNOWN",
  "pickupAddress": "上車地址（若有）",
  "destAddress": "目的地（若有）",
  "scheduledTime": "預約時間 ISO 格式（若有）"
}
只回傳 JSON，不要其他文字。地點在花蓮縣。`
          },
          { role: 'user', content: text }
        ],
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content || '{}';
      const parsed: ParsedIntent = JSON.parse(content);

      if (parsed.type === 'CALL_TAXI' && parsed.pickupAddress) {
        // 直接跳到確認步驟
        const data: ConversationData = { mode: 'CALL' };

        const pickupGeo = await this.geocodeAddress(parsed.pickupAddress);
        data.pickupAddress = pickupGeo?.formattedAddress || parsed.pickupAddress;
        data.pickupLat = pickupGeo?.lat;
        data.pickupLng = pickupGeo?.lng;

        if (parsed.destAddress) {
          const destGeo = await this.geocodeAddress(parsed.destAddress);
          data.destAddress = destGeo?.formattedAddress || parsed.destAddress;
          data.destLat = destGeo?.lat;
          data.destLng = destGeo?.lng;
        }

        await this.showConfirmCard(userId, data, replyToken);

      } else if (parsed.type === 'CANCEL') {
        const lineUser = await this.getOrCreateLineUser(userId);
        await this.handleCheckOrCancel(userId, lineUser, replyToken);

      } else if (parsed.type === 'RESERVE') {
        await this.startCallTaxi(userId, 'RESERVE', replyToken);

      } else {
        await this.lineClient.replyMessage({
          replyToken,
          messages: [{ type: 'text', text: '輸入「叫車」立即叫車，「預約」預約叫車，「取消」取消訂單。' }],
        });
      }

    } catch (error) {
      console.error('[LINE] GPT 解析失敗:', error);
      await this.lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: '輸入「叫車」開始叫車！' }],
      });
    }
  }

  // ========== 訂單建立 ==========

  private async createLineOrder(userId: string, data: ConversationData): Promise<string> {
    const orderId = `ORD${Date.now()}`;
    const now = new Date();
    const lineUser = await this.getLineUser(userId);
    if (!lineUser) throw new Error('找不到 LINE 用戶');

    await this.pool.query(`
      INSERT INTO orders (
        order_id, passenger_id, status,
        pickup_lat, pickup_lng, pickup_address,
        dest_lat, dest_lng, dest_address,
        payment_type,
        created_at, offered_at,
        hour_of_day, day_of_week,
        source, line_user_id
      ) VALUES (
        $1, $2, 'OFFERED',
        $3, $4, $5,
        $6, $7, $8,
        'CASH',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        $9, $10,
        'LINE', $11
      )
    `, [
      orderId,
      lineUser.passenger_id,
      data.pickupLat || 23.9871,
      data.pickupLng || 121.6015,
      data.pickupAddress || '花蓮（LINE 叫車）',
      data.destLat || null,
      data.destLng || null,
      data.destAddress || null,
      now.getHours(),
      now.getDay(),
      userId,
    ]);

    // 更新統計
    await this.pool.query(
      `UPDATE line_users SET total_orders = total_orders + 1, updated_at = CURRENT_TIMESTAMP WHERE line_user_id = $1`,
      [userId]
    );

    console.log(`[LINE] 訂單已建立: ${orderId}`);
    return orderId;
  }

  private async createScheduledOrder(userId: string, data: ConversationData): Promise<string> {
    const orderId = `ORD${Date.now()}`;
    const now = new Date();
    const lineUser = await this.getLineUser(userId);
    if (!lineUser) throw new Error('找不到 LINE 用戶');

    // Geocoding fallback
    if (!data.pickupLat && data.pickupAddress) {
      const geo = await this.geocodeAddress(data.pickupAddress);
      if (geo) {
        data.pickupLat = geo.lat;
        data.pickupLng = geo.lng;
      }
    }

    await this.pool.query(`
      INSERT INTO orders (
        order_id, passenger_id, status,
        pickup_lat, pickup_lng, pickup_address,
        dest_lat, dest_lng, dest_address,
        payment_type,
        created_at,
        hour_of_day, day_of_week,
        source, line_user_id, scheduled_at
      ) VALUES (
        $1, $2, 'WAITING',
        $3, $4, $5,
        $6, $7, $8,
        'CASH',
        CURRENT_TIMESTAMP,
        $9, $10,
        'LINE', $11, $12
      )
    `, [
      orderId,
      lineUser.passenger_id,
      data.pickupLat || 23.9871,
      data.pickupLng || 121.6015,
      data.pickupAddress || '花蓮（LINE 預約）',
      data.destLat || null,
      data.destLng || null,
      data.destAddress || null,
      now.getHours(),
      now.getDay(),
      userId,
      data.scheduledAt,
    ]);

    // 更新統計
    await this.pool.query(
      `UPDATE line_users SET total_orders = total_orders + 1, updated_at = CURRENT_TIMESTAMP WHERE line_user_id = $1`,
      [userId]
    );

    console.log(`[LINE] 預約訂單已建立: ${orderId}, 排程: ${data.scheduledAt}`);
    return orderId;
  }

  // ========== Geocoding ==========

  private async geocodeAddress(address: string): Promise<GeocodingResult | null> {
    // 段數正規化：1段→一段
    const addr = hualienAddressDB.normalizeSegment(address);

    // 1. 本地 DB 查詢
    const isStreetAddress = /[路街道巷弄號]/.test(addr);
    const dbResult = hualienAddressDB.lookup(addr);
    if (dbResult && dbResult.entry.lat !== null && dbResult.entry.lng !== null) {
      if (isStreetAddress && dbResult.matchType === 'SUBSTRING') {
        // 街道地址跳過 SUBSTRING 命中
      } else {
        return {
          lat: dbResult.entry.lat,
          lng: dbResult.entry.lng,
          formattedAddress: dbResult.entry.address,
        };
      }
    }

    // 2. Google Geocoding API
    if (!this.googleMapsApiKey) return null;

    try {
      const cacheKey = `geocode:v2:${addr}`;
      try {
        const cached = await getCachedApiResponse(cacheKey);
        if (cached) return cached as GeocodingResult;
      } catch { /* Redis 失敗不阻斷 */ }

      const HUALIEN_TOWNSHIPS = ['吉安', '新城', '壽豐', '光復', '豐濱', '瑞穗', '富里', '秀林', '萬榮', '卓溪', '玉里', '鳳林'];
      const hasTownship = HUALIEN_TOWNSHIPS.some(t => addr.includes(t));
      const alreadyHasPrefix = addr.startsWith('花蓮');
      const prefix = hasTownship ? '花蓮縣' : '花蓮縣花蓮市';
      const fullAddress = alreadyHasPrefix ? addr : `${prefix}${addr}`;

      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(fullAddress)}&language=zh-TW&region=tw&components=country:TW&key=${this.googleMapsApiKey}`;
      const response = await fetch(url);
      const geoData = await response.json() as any;

      if (geoData.results && geoData.results.length > 0) {
        const result = geoData.results[0];
        const geo: GeocodingResult = {
          lat: result.geometry.location.lat,
          lng: result.geometry.location.lng,
          formattedAddress: hualienAddressDB.normalizeSegment(result.formatted_address || fullAddress),
        };

        try { await cacheApiResponse(cacheKey, geo, 3600); } catch { /* ignore */ }
        return geo;
      }
    } catch (error) {
      console.error('[LINE] Geocoding 失敗:', error);
    }

    return null;
  }

  // ========== LINE 使用者管理 ==========

  private async getOrCreateLineUser(userId: string): Promise<LineUser> {
    // 查找現有用戶
    const existing = await this.getLineUser(userId);
    if (existing) {
      // 更新互動時間
      await this.pool.query(
        'UPDATE line_users SET last_interaction_at = CURRENT_TIMESTAMP WHERE line_user_id = $1',
        [userId]
      );
      return existing;
    }

    // 取得 LINE Profile
    let displayName = 'LINE 用戶';
    let pictureUrl = '';
    try {
      const profile = await this.lineClient.getProfile(userId);
      displayName = profile.displayName || 'LINE 用戶';
      pictureUrl = profile.pictureUrl || '';
    } catch (error) {
      console.error('[LINE] 取得 Profile 失敗:', error);
    }

    // 建立 passenger 記錄
    const passengerId = `LINE_${userId.substring(0, 10)}`;
    const phone = `LINE_${userId.substring(0, 15)}`;

    await this.pool.query(`
      INSERT INTO passengers (passenger_id, name, phone)
      VALUES ($1, $2, $3)
      ON CONFLICT (phone) DO UPDATE SET
        name = EXCLUDED.name,
        updated_at = CURRENT_TIMESTAMP
      RETURNING passenger_id
    `, [passengerId, displayName, phone]);

    // 建立 line_users 記錄
    await this.pool.query(`
      INSERT INTO line_users (line_user_id, passenger_id, display_name, picture_url)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (line_user_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        picture_url = EXCLUDED.picture_url,
        updated_at = CURRENT_TIMESTAMP
    `, [userId, passengerId, displayName, pictureUrl]);

    console.log(`[LINE] 新用戶建立: ${userId} → ${passengerId} (${displayName})`);

    return {
      line_user_id: userId,
      passenger_id: passengerId,
      display_name: displayName,
      conversation_state: 'IDLE',
      conversation_data: {},
    };
  }

  private async getLineUser(userId: string): Promise<LineUser | null> {
    const result = await this.pool.query(
      'SELECT * FROM line_users WHERE line_user_id = $1',
      [userId]
    );
    return result.rows[0] || null;
  }

  private async updateConversationState(userId: string, state: string, data?: ConversationData): Promise<void> {
    await this.pool.query(`
      UPDATE line_users
      SET conversation_state = $1,
          conversation_data = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE line_user_id = $3
    `, [state, JSON.stringify(data || {}), userId]);
  }

  private async resetConversation(userId: string): Promise<void> {
    await this.updateConversationState(userId, 'IDLE', {});
  }

  private async findActiveOrderByLineUser(userId: string): Promise<any | null> {
    const result = await this.pool.query(`
      SELECT * FROM orders
      WHERE line_user_id = $1
        AND status IN ('WAITING', 'OFFERED', 'ACCEPTED', 'ARRIVED', 'ON_TRIP', 'SCHEDULED')
        AND created_at > NOW() - INTERVAL '4 hours'
      ORDER BY created_at DESC
      LIMIT 1
    `, [userId]);

    return result.rows[0] || null;
  }

  // ========== 訊息記錄 ==========

  async logMessage(messageId: string, userId: string, direction: 'IN' | 'OUT', messageType: string, content: string, orderId?: string): Promise<void> {
    try {
      await this.pool.query(`
        INSERT INTO line_messages (message_id, line_user_id, direction, message_type, content, related_order_id)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [messageId, userId, direction, messageType, content, orderId || null]);
    } catch (error) {
      // 記錄失敗不影響主流程
      console.error('[LINE] 訊息記錄失敗:', error);
    }
  }

  // ========== 工具方法 ==========

  private formatDateTime(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}/${m}/${d} ${h}:${min}`;
  }
}

// ========== 單例管理 ==========

let lineMessageProcessor: LineMessageProcessor | null = null;

export function initLineMessageProcessor(pool: Pool): void {
  lineMessageProcessor = new LineMessageProcessor(pool);
}

export function getLineMessageProcessor(): LineMessageProcessor {
  if (!lineMessageProcessor) {
    throw new Error('LineMessageProcessor 尚未初始化');
  }
  return lineMessageProcessor;
}

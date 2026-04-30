/**
 * PhoneCallProcessor - 電話叫車核心處理管線
 *
 * 流程：RECEIVED → DOWNLOADING → TRANSCRIBING → PARSING → [事件判定] → DISPATCHING/FOLLOW_UP → COMPLETED
 */

import { Pool } from 'pg';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { CallFieldExtractor, ParsedFields, CallEventType } from './CallFieldExtractor';
import { getSmartDispatcherV2, OrderData } from './SmartDispatcherV2';
import { getSocketIO, driverSockets, notifyAdmins } from '../socket';
import { hualienAddressDB, isAdministrativeAreaResult, pickBestPlaceResult } from './HualienAddressDB';
import { recordFailedQuery, attachGoogleResult, shouldLogFailure } from './AddressFailureLogger';
import { cacheApiResponse, getCachedApiResponse } from './cache';
import { getNotificationService } from './NotificationService';

// ========== 類型定義 ==========

export interface PhoneCallRecord {
  callId: string;
  callerNumber: string;
  durationSeconds: number;
  recordingUrl: string;
  processingStatus: string;
  transcript?: string;
  parsedFields?: ParsedFields;
  orderId?: string;
  eventType?: CallEventType;
  errorMessage?: string;
  retryCount: number;
}

interface GeocodingResult {
  lat: number;
  lng: number;
  formattedAddress: string;
  /**
   * 命中禁止上車區（例花蓮火車站）時設定。
   * 此情況下 lat/lng/formattedAddress 仍會填入命中地標座標供顯示用，
   * 但呼叫端應該偵測此欄位、不直接用座標建單，改走人工審核。
   */
  forbiddenPickup?: {
    matchedLandmark: string;
    alternatives: Array<{
      id: number;
      name: string;
      address: string;
      lat: number;
      lng: number;
    }>;
  };
}

// LANDMARK_COORDS 已移至 HualienAddressDB.ts（150+ 筆）

// ========== 服務類 ==========

export class PhoneCallProcessor {
  private pool: Pool;
  private openai: OpenAI;
  private fieldExtractor: CallFieldExtractor;
  private googleMapsApiKey: string;

  // 3CX 錄音存放路徑
  private recordingsBasePath: string;

  // 信心度閾值（低於此值轉人工審核）
  private readonly EVENT_CONFIDENCE_THRESHOLD = parseFloat(process.env.PHONE_EVENT_CONFIDENCE_THRESHOLD || '0.7');
  private readonly FIELD_CONFIDENCE_THRESHOLD = parseFloat(process.env.PHONE_FIELD_CONFIDENCE_THRESHOLD || '0.4');

  constructor(pool: Pool) {
    this.pool = pool;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for PhoneCallProcessor');
    }

    this.openai = new OpenAI({ apiKey });
    this.fieldExtractor = new CallFieldExtractor(this.openai);
    this.googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || '';
    this.recordingsBasePath = process.env.RECORDINGS_PATH || '/var/spool/asterisk/recording';
  }

  /**
   * 主處理管線：處理一通電話
   */
  async processCall(callId: string): Promise<void> {
    console.log(`\n[PhoneCallProcessor] ====== 開始處理電話 ${callId} ======`);

    try {
      // 1. 取得電話記錄
      const call = await this.getCallRecord(callId);
      if (!call) {
        console.error(`[PhoneCallProcessor] 找不到電話記錄: ${callId}`);
        return;
      }

      // 2. 下載錄音
      await this.updateStatus(callId, 'DOWNLOADING');
      const audioPath = await this.downloadRecording(call);
      console.log(`[PhoneCallProcessor] 錄音已就緒: ${audioPath}`);

      // 3. Whisper STT 語音轉文字
      await this.updateStatus(callId, 'TRANSCRIBING');
      const transcript = await this.transcribeAudio(audioPath);
      console.log(`[PhoneCallProcessor] 轉錄結果: "${transcript}"`);
      await this.updateTranscript(callId, transcript);

      // 3.5 Whisper 幻覺偵測 + 錄音品質檢查
      const HALLUCINATION_PATTERNS = [
        '請不吝點贊', '訂閱轉發', '明鏡與點點', '感謝收看',
        'Thank you for watching', 'Please subscribe', '字幕由',
        '謝謝觀看', '感谢收看', '请不吝点赞', '小編'
      ];
      const isHallucination = HALLUCINATION_PATTERNS.some(p => transcript.includes(p));
      // MixMonitor 錄全程（含 greeting ~3.5s），檔案大小無法判斷是否有客人語音
      // 改用通話時長：greeting 3.5s + Wait 0.5s = 4s 基線，< 5s 幾乎無開口時間
      const isTooShort = call.durationSeconds < 5;

      if (isHallucination || isTooShort) {
        const reason = isHallucination ? `STT幻覺: ${transcript.substring(0, 50)}` : `通話過短: ${call.durationSeconds}秒`;
        console.log(`[PhoneCallProcessor] ⚠️ 錄音品質不足: ${reason}`);
        await this.markFailed(callId, `錄音品質不足：${reason}`);
        return;
      }

      // 3.6 空白語音檢查（靜音來電）
      if (!transcript?.trim()) {
        console.log(`[PhoneCallProcessor] ⚠️ 來電無語音: ${call.callerNumber}`);
        await this.markFailed(callId, '來電無語音輸入（靜音或通話過短）');
        return;
      }

      // 4. 事件判定（新訂單 or 跟進電話）
      await this.updateStatus(callId, 'PARSING');
      const activeOrder = await this.findActiveOrderByPhone(call.callerNumber);

      const eventClassification = await this.fieldExtractor.classifyEvent(
        transcript,
        !!activeOrder,
        activeOrder ? {
          orderId: activeOrder.order_id,
          status: activeOrder.status,
          pickupAddress: activeOrder.pickup_address
        } : undefined
      );

      console.log(`[PhoneCallProcessor] 事件類型: ${eventClassification.eventType} (信心度: ${eventClassification.confidence})`);
      await this.updateEventType(callId, eventClassification.eventType);

      // 4.5 對 NEW_ORDER 預先提取欄位（以便 operator 審核時能看到）
      let parsedFields: ParsedFields | null = null;
      if (eventClassification.eventType === 'NEW_ORDER') {
        console.log('[PhoneCall] 轉錄原文:', transcript);
        parsedFields = await this.fieldExtractor.extractFields(transcript);
        console.log('[PhoneCall] GPT提取:', JSON.stringify(parsedFields));
        await this.updateParsedFields(callId, parsedFields);
      }

      // 4.6 持久化信心度分數
      await this.persistConfidenceScores(callId, eventClassification.confidence, parsedFields?.confidence ?? null);

      // 4.7 信心度閘門：低於閾值則轉人工審核
      const needsReview =
        eventClassification.confidence < this.EVENT_CONFIDENCE_THRESHOLD ||
        (parsedFields !== null && parsedFields.confidence < this.FIELD_CONFIDENCE_THRESHOLD);

      if (needsReview) {
        console.log(`[PhoneCallProcessor] ⚠️ 信心度不足，轉人工審核 (event: ${eventClassification.confidence}, field: ${parsedFields?.confidence ?? 'N/A'})`);
        await this.markNeedsReview(callId, call, transcript, eventClassification, parsedFields);
        return;
      }

      // 5. 根據事件類型處理
      switch (eventClassification.eventType) {
        case 'NEW_ORDER':
          await this.handleNewOrder(callId, call, transcript, parsedFields!);
          break;
        case 'URGE':
          await this.handleUrge(callId, call, activeOrder);
          break;
        case 'CANCEL':
          await this.handleCancel(callId, call, activeOrder);
          break;
        case 'CHANGE':
          await this.handleChange(callId, call, activeOrder, eventClassification.changeDetails);
          break;
      }

    } catch (error: any) {
      console.error(`[PhoneCallProcessor] 處理失敗 (${callId}):`, error);
      await this.markFailed(callId, error.message || '處理失敗');
    }
  }

  /**
   * 處理新訂單
   */
  private async handleNewOrder(
    callId: string,
    call: PhoneCallRecord,
    transcript: string,
    preExtractedFields?: ParsedFields | null
  ): Promise<void> {
    console.log(`[PhoneCallProcessor] 處理新訂單...`);

    // 使用預提取的欄位（信心度閘門已提取）或重新提取
    const parsedFields = preExtractedFields || await this.fieldExtractor.extractFields(transcript);
    if (!preExtractedFields) {
      console.log('[PhoneCall] 轉錄原文:', transcript);
      console.log('[PhoneCall] GPT提取:', JSON.stringify(parsedFields));
      await this.updateParsedFields(callId, parsedFields);
    }

    // 地址 Geocoding
    let pickupGeo: GeocodingResult | null = null;
    let destGeo: GeocodingResult | null = null;

    if (parsedFields.pickup_address) {
      pickupGeo = await this.geocodeAddress(parsedFields.pickup_address);
      console.log('[PhoneCall] 上車Geocoding:', JSON.stringify(pickupGeo));
    }
    if (parsedFields.destination_address) {
      destGeo = await this.geocodeAddress(parsedFields.destination_address);
      console.log('[PhoneCall] 目的地Geocoding:', JSON.stringify(destGeo));
    }

    // 上車點命中禁止上車區（例花蓮火車站）→ 不建單派單，改走人工審核
    if (pickupGeo?.forbiddenPickup) {
      const fp = pickupGeo.forbiddenPickup;
      const altsList = fp.alternatives.map(a => `「${a.name}」`).join('、');
      console.warn(`[PhoneCallProcessor] ⚠️ 上車點為禁止載客區 (${fp.matchedLandmark})，轉人工審核`);
      await this.handleForbiddenPickupCall(callId, call, transcript, parsedFields, fp, altsList);
      return;
    }

    // 如果上車點無法 geocoding，使用花蓮市中心作為預設
    if (!pickupGeo) {
      console.warn('[PhoneCallProcessor] 上車點無法定位，使用花蓮預設座標');
      pickupGeo = {
        lat: 23.9871,
        lng: 121.6015,
        formattedAddress: parsedFields.pickup_address
          ? `${parsedFields.pickup_address}（待確認地址）`
          : '花蓮市（電話訂單，待確認地址）'
      };
    }

    // 建立訂單
    await this.updateStatus(callId, 'DISPATCHING');
    const orderId = await this.createPhoneOrder(call, parsedFields, pickupGeo, destGeo, transcript);
    await this.linkOrderToCall(callId, orderId);

    // 觸發派單
    try {
      const dispatcher = getSmartDispatcherV2();
      const orderData: OrderData = {
        orderId,
        passengerId: `PHONE_${call.callerNumber}`,
        passengerName: parsedFields.customer_name || `來電 ${call.callerNumber}`,
        passengerPhone: call.callerNumber,
        pickup: {
          lat: pickupGeo.lat,
          lng: pickupGeo.lng,
          address: pickupGeo.formattedAddress
        },
        destination: destGeo ? {
          lat: destGeo.lat,
          lng: destGeo.lng,
          address: parsedFields.destination_address || destGeo.formattedAddress
        } : null,
        paymentType: parsedFields.subsidy_type !== 'NONE' ? 'SUBSIDY' : 'CASH',
        createdAt: Date.now(),
        // 電話訂單擴展欄位
        source: 'PHONE',
        subsidyType: parsedFields.subsidy_type,
        petPresent: parsedFields.pet_present,
        petCarrier: parsedFields.pet_carrier,
        customerPhone: call.callerNumber,
      };

      const dispatchResult = await dispatcher.startDispatch(orderData);
      console.log(`[PhoneCallProcessor] 派單結果:`, dispatchResult);

      await this.updateStatus(callId, 'COMPLETED');
    } catch (dispatchError: any) {
      console.error('[PhoneCallProcessor] 派單失敗:', dispatchError);
      // 電話訂單派單失敗時保持 PENDING，等司機上線後重新派單
      console.log(`[PhoneCallProcessor] 電話訂單保持 PENDING，等待司機上線: ${orderId}`);
      await this.pool.query(
        `UPDATE orders SET status = 'PENDING', cancel_reason = NULL WHERE order_id = $1`,
        [orderId]
      );
      await this.updateStatus(callId, 'COMPLETED');
    }
  }

  /**
   * 處理催單
   */
  private async handleUrge(
    callId: string,
    call: PhoneCallRecord,
    activeOrder: any
  ): Promise<void> {
    console.log(`[PhoneCallProcessor] 處理催單 - 訂單: ${activeOrder?.order_id}`);

    if (!activeOrder) {
      console.warn('[PhoneCallProcessor] 催單但無活動訂單，轉為新訂單處理');
      await this.updateEventType(callId, 'NEW_ORDER');
      return;
    }

    await this.updateStatus(callId, 'FOLLOW_UP');
    await this.linkOrderToCall(callId, activeOrder.order_id);

    // 通知司機催單
    if (activeOrder.driver_id) {
      const io = getSocketIO();
      const socketId = driverSockets.get(activeOrder.driver_id);
      if (socketId) {
        io.to(socketId).emit('order:urge', {
          orderId: activeOrder.order_id,
          message: `乘客 ${call.callerNumber} 來電催促`,
          callerNumber: call.callerNumber,
          urgencyLevel: 1
        });
        console.log(`[PhoneCallProcessor] 已通知司機 ${activeOrder.driver_id} 催單`);
      }
    }

    await this.updateStatus(callId, 'COMPLETED');
  }

  /**
   * 處理取消
   */
  private async handleCancel(
    callId: string,
    call: PhoneCallRecord,
    activeOrder: any
  ): Promise<void> {
    console.log(`[PhoneCallProcessor] 處理取消 - 訂單: ${activeOrder?.order_id}`);

    if (!activeOrder) {
      // 找不到活動訂單（可能已超過 4 小時或訂單已結束），記錄後完成
      console.warn(`[PhoneCallProcessor] 取消但無活動訂單 - 來電號碼: ${call.callerNumber}`);
      await this.pool.query(
        `UPDATE phone_calls SET error_message = '找不到活動訂單（訂單可能已完成或超時）', updated_at = CURRENT_TIMESTAMP WHERE call_id = $1`,
        [callId]
      );
      await this.updateStatus(callId, 'COMPLETED');
      return;
    }

    await this.updateStatus(callId, 'FOLLOW_UP');
    await this.linkOrderToCall(callId, activeOrder.order_id);

    // 更新訂單狀態
    await this.pool.query(
      `UPDATE orders SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancel_reason = '乘客來電取消' WHERE order_id = $1`,
      [activeOrder.order_id]
    );

    // 通知司機
    if (activeOrder.driver_id) {
      const io = getSocketIO();
      const socketId = driverSockets.get(activeOrder.driver_id);
      if (socketId) {
        io.to(socketId).emit('order:status', {
          orderId: activeOrder.order_id,
          status: 'CANCELLED',
          message: `乘客 ${call.callerNumber} 來電取消訂單`
        });
      }
    }

    await this.updateStatus(callId, 'COMPLETED');
  }

  /**
   * 處理變更
   */
  private async handleChange(
    callId: string,
    call: PhoneCallRecord,
    activeOrder: any,
    changeDetails?: string
  ): Promise<void> {
    console.log(`[PhoneCallProcessor] 處理變更 - 訂單: ${activeOrder?.order_id}, 變更: ${changeDetails}`);

    if (!activeOrder) {
      console.warn('[PhoneCallProcessor] 變更但無活動訂單，轉為新訂單');
      await this.updateEventType(callId, 'NEW_ORDER');
      return;
    }

    await this.updateStatus(callId, 'FOLLOW_UP');
    await this.linkOrderToCall(callId, activeOrder.order_id);

    // 通知司機有變更
    if (activeOrder.driver_id) {
      const io = getSocketIO();
      const socketId = driverSockets.get(activeOrder.driver_id);
      if (socketId) {
        io.to(socketId).emit('order:status', {
          orderId: activeOrder.order_id,
          status: activeOrder.status,
          message: `乘客來電變更：${changeDetails || '請確認變更內容'}`,
          changeDetails
        });
      }
    }

    await this.updateStatus(callId, 'COMPLETED');
  }

  // ========== 輔助方法 ==========

  /**
   * Whisper STT 語音轉文字
   */
  private async transcribeAudio(audioPath: string): Promise<string> {
    const audioFile = fs.createReadStream(audioPath);

    const response = await this.openai.audio.transcriptions.create({
      file: audioFile,
      model: 'gpt-4o-transcribe',
      language: 'zh',
      response_format: 'text',
      prompt: '花蓮縣計程車叫車，說話者可能帶有台語腔調（ㄋ/ㄌ混淆、ㄓ/ㄗ混淆）。常見地點：花蓮火車站、東大門夜市、慈濟醫院、門諾醫院、花蓮航空站、太魯閣、七星潭、遠東百貨、家樂福花蓮店、吉安鄉、壽豐鄉。常見路名：中山路、中正路、中華路、林森路、博愛街、民權路、自強路、府前路。取消訂單常用語：不要了、取消、不叫了、不需要了。錄音開頭包含系統問候語「大豐您好請說您的位置跟要去哪裡」和可能的嗶聲提示音，問候語可能被乘客語音打斷而不完整。請完全忽略問候語和嗶聲部分，只轉錄乘客說的【上車地點】和【目的地】兩個資訊。'
    });

    return response as unknown as string;
  }

  /**
   * 下載/取得錄音檔
   */
  private async downloadRecording(call: PhoneCallRecord): Promise<string> {
    // 優先使用客人專屬音軌（不含系統歡迎語，辨識更準確）
    const callerOnlyPath = path.join(this.recordingsBasePath, `${call.callId}-caller.wav`);
    if (fs.existsSync(callerOnlyPath)) {
      const stat = fs.statSync(callerOnlyPath);
      if (stat.size > 1000) { // 確保不是空檔案
        console.log(`[PhoneCallProcessor] 使用客人專屬音軌: ${callerOnlyPath}`);
        return callerOnlyPath;
      }
    }

    // 退回混合音軌
    const localPath = path.join(this.recordingsBasePath, `${call.callId}.wav`);

    if (fs.existsSync(localPath)) {
      return localPath;
    }

    // 嘗試從 URL 下載
    if (call.recordingUrl) {
      const tmpPath = path.join('/tmp', `call_${call.callId}.wav`);

      // 如果是本機路徑
      if (call.recordingUrl.startsWith('/')) {
        if (fs.existsSync(call.recordingUrl)) {
          return call.recordingUrl;
        }
      }

      // HTTP 下載
      const response = await fetch(call.recordingUrl);
      if (!response.ok) {
        throw new Error(`下載錄音失敗: ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(tmpPath, buffer);
      return tmpPath;
    }

    throw new Error(`找不到錄音檔: ${call.callId}`);
  }

  /**
   * 偵測命中地標是否禁止上車，並組裝替代點清單。
   * 命中時呼叫端應走人工審核（電話客人沒法點選 UI）。
   */
  private buildForbiddenPickup(landmarkName: string): GeocodingResult['forbiddenPickup'] {
    const alts = hualienAddressDB.getForbiddenAlternatives(landmarkName);
    if (alts.length === 0) return undefined;
    return {
      matchedLandmark: landmarkName,
      alternatives: alts.map(a => ({
        id: a.id!,
        name: a.name,
        address: a.address,
        lat: a.lat as number,
        lng: a.lng as number,
      })),
    };
  }

  /**
   * 用座標反查是否落在禁止上車地標 100 公尺內。
   * Google API 回傳「花蓮車站」、「Hualien Station」等變體時的最後防線。
   */
  private buildForbiddenPickupByCoords(lat: number, lng: number): GeocodingResult['forbiddenPickup'] {
    const forbidden = hualienAddressDB.findNearbyForbidden(lat, lng, 100);
    if (!forbidden) return undefined;
    return this.buildForbiddenPickup(forbidden.name);
  }

  /**
   * 四層式地址 Geocoding：
   * ① HualienAddressDB（150+ 筆本地比對，含台語別名）
   * ② 街道地址 → Geocoding API（精確）
   * ③ 地標/景點 → Places Text Search（帶 location bias）
   * ④ 花蓮市中心預設座標（失敗保底，由呼叫端處理）
   *
   * Redis 快取：DB 命中 24h、Google API 結果 1h
   * forbiddenPickup 結果不快取（每次都要攔截）
   */
  private async geocodeAddress(address: string): Promise<GeocodingResult | null> {
    if (!this.googleMapsApiKey) {
      console.warn('[PhoneCallProcessor] 未設定 GOOGLE_MAPS_API_KEY，跳過 Geocoding');
      return null;
    }

    // 段數正規化：1段→一段
    const addr = hualienAddressDB.normalizeSegment(address);

    // Redis 快取查詢
    const cacheKey = `geocode:v2:${addr}`;
    try {
      const cached = await getCachedApiResponse(cacheKey);
      if (cached) {
        console.log(`[PhoneCallProcessor] Geocoding 快取命中: ${addr}`);
        return cached as GeocodingResult;
      }
    } catch { /* Redis 失敗不阻斷主流程 */ }

    let result: GeocodingResult | null = null;
    let cacheTtl = 3600; // 預設 1 小時

    // ① 本地 DB 查詢（含台語別名，O(1)）
    // 街道門牌不允許 SUBSTRING 命中，避免「吉安路一段16號」誤判為「吉安鄉」
    const isStreetAddress = /[路街道巷弄號]/.test(addr);
    const dbResult = hualienAddressDB.lookup(addr);
    // 記錄未能高信心命中的查詢（fire-and-forget，不影響主流程）
    if (shouldLogFailure(dbResult)) {
      recordFailedQuery(address, 'PHONE', dbResult).catch(() => {});
    }
    if (dbResult && dbResult.entry.lat !== null && dbResult.entry.lng !== null) {
      if (isStreetAddress && dbResult.matchType === 'SUBSTRING') {
        console.log(`[HualienAddressDB] 街道地址跳過 SUBSTRING 命中: ${addr} → ${dbResult.entry.name}，改用 Geocoding API`);
      } else {
        console.log(`[HualienAddressDB] 命中: ${dbResult.matchedAlias} → ${dbResult.entry.name} (${dbResult.matchType})`);
        const forbiddenInfo = this.buildForbiddenPickup(dbResult.entry.name);
        result = {
          lat: dbResult.entry.lat,
          lng: dbResult.entry.lng,
          formattedAddress: dbResult.entry.address,
          ...(forbiddenInfo ? { forbiddenPickup: forbiddenInfo } : {}),
        };
        cacheTtl = 86400; // DB 命中快取 24 小時
      }
    }

    // ② 街道地址 → Geocoding API
    if (!result) {
      if (isStreetAddress) {
        const geocoded = await this.geocodeWithGeocodingAPI(addr);
        if (geocoded && !this.isDefaultCoords(geocoded.lat, geocoded.lng)) {
          result = {
            ...geocoded,
            formattedAddress: hualienAddressDB.cleanupDisplay(geocoded.formattedAddress),
          };
        } else {
          console.warn(`[PhoneCallProcessor] Geocoding 無效結果，改用 Places Search: ${addr}`);
        }
      }
    }

    // ③ 地標/景點 → Places Search
    if (!result) {
      const placesResult = await this.geocodeWithPlacesSearch(addr);
      if (placesResult) {
        result = {
          ...placesResult,
          formattedAddress: hualienAddressDB.cleanupDisplay(placesResult.formattedAddress),
        };
      }
    }

    // 寫入 Redis 快取（forbiddenPickup 結果不快取，每次都要攔截）
    if (result) {
      if (!result.forbiddenPickup) {
        try {
          await cacheApiResponse(cacheKey, result, cacheTtl);
        } catch { /* Redis 失敗不阻斷 */ }
      }
      // 若 lookup 失敗但 google 補救成功，附加到失敗佇列供 Admin 查看
      if (shouldLogFailure(dbResult)) {
        attachGoogleResult(address, 'PHONE', {
          lat: result.lat,
          lng: result.lng,
          formattedAddress: result.formattedAddress,
        }).catch(() => {});
      }
    }

    return result;
  }

  /**
   * 判斷座標是否為花蓮市中心預設值（Geocoding 失敗的假陽性）
   */
  private isDefaultCoords(lat: number, lng: number): boolean {
    const dist = Math.sqrt(Math.pow(lat - 23.9871, 2) + Math.pow(lng - 121.6015, 2));
    return dist < 0.002; // ~200 公尺
  }

  /**
   * Geocoding API - 專門處理街道門牌地址
   */
  private async geocodeWithGeocodingAPI(address: string): Promise<GeocodingResult | null> {
    const HUALIEN_TOWNSHIPS = ['吉安', '新城', '壽豐', '光復', '豐濱', '瑞穗', '富里', '秀林', '萬榮', '卓溪', '玉里', '鳳林'];
    const hasTownship = HUALIEN_TOWNSHIPS.some(t => address.includes(t));
    const alreadyHasPrefix = address.startsWith('花蓮');
    const prefix = hasTownship ? '花蓮縣' : '花蓮縣花蓮市';
    const fullAddress = alreadyHasPrefix ? address : `${prefix}${address}`;

    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json`
        + `?address=${encodeURIComponent(fullAddress)}`
        + `&language=zh-TW&region=tw`
        + `&bounds=23.20,121.30|24.16,121.66`
        + `&components=country:TW`
        + `&key=${this.googleMapsApiKey}`;

      console.log(`[PhoneCallProcessor] Geocoding API 查詢: ${fullAddress}`);
      const response = await fetch(url);
      const data = await response.json() as any;

      if (data.results && data.results.length > 0) {
        const result = data.results[0];
        const lat = result.geometry.location.lat;
        const lng = result.geometry.location.lng;

        // 驗證 1：範圍檢查
        if (!hualienAddressDB.isWithinBounds(lat, lng)) {
          console.warn(`[PhoneCallProcessor] Geocoding 結果超出花蓮範圍，丟棄: ${fullAddress} → lat=${lat}, lng=${lng}`);
          return null;
        }

        // 驗證 2：拒絕行政區級別粗糙結果（讓 caller fallback 到 Places Search）
        if (isAdministrativeAreaResult(result.types)) {
          console.warn(`[PhoneCallProcessor] Geocoding 僅回傳行政區級別，fallback: ${fullAddress} → types=${JSON.stringify(result.types)}`);
          return null;
        }

        const googleAddr = result.formatted_address || fullAddress;
        const hasDetail = /[路街道巷弄號]/.test(googleAddr) ||
          (result.types || []).some((t: string) =>
            ['street_address','premise','establishment','point_of_interest'].includes(t)
          );
        const forbiddenInfo = this.buildForbiddenPickupByCoords(lat, lng);
        return {
          lat,
          lng,
          formattedAddress: hualienAddressDB.cleanupDisplay(hasDetail ? googleAddr : fullAddress),
          ...(forbiddenInfo ? { forbiddenPickup: forbiddenInfo } : {}),
        };
      }

      return null;
    } catch (error) {
      console.error('[PhoneCallProcessor] Geocoding API 失敗:', error);
      return null;
    }
  }

  /**
   * Places Text Search - 處理地標/景點，附帶花蓮縣 location bias
   */
  private async geocodeWithPlacesSearch(address: string): Promise<GeocodingResult | null> {
    try {
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json`
        + `?query=${encodeURIComponent(`${address} 花蓮`)}`
        + `&location=23.9871,121.6015&radius=50000`
        + `&language=zh-TW&region=tw`
        + `&key=${this.googleMapsApiKey}`;

      console.log(`[PhoneCallProcessor] Places Search 查詢: ${address} 花蓮`);
      const response = await fetch(url);
      const data = await response.json() as any;

      if (data.results && data.results.length > 0) {
        // 智慧挑選：過濾 ATM、優先選分行（對台新銀行/中國信託等 POI 尤其重要）
        const result = pickBestPlaceResult(data.results, address);
        if (!result) {
          console.warn(`[PhoneCallProcessor] Places Search 挑選後無結果: ${address}`);
          return null;
        }

        const lat = result.geometry.location.lat;
        const lng = result.geometry.location.lng;

        // 驗證結果在花蓮縣範圍內
        if (!hualienAddressDB.isWithinBounds(lat, lng)) {
          console.warn(`[PhoneCallProcessor] Places Search 結果超出花蓮範圍，丟棄: ${address} → lat=${lat}, lng=${lng}`);
          return null;
        }

        const googleAddr = result.formatted_address || address;
        const hasDetail = /[路街道巷弄號]/.test(googleAddr) ||
          (result.types || []).some((t: string) =>
            ['street_address','premise','establishment','point_of_interest'].includes(t)
          );

        console.log(`[PhoneCallProcessor] Places Search 命中: ${result.name || address} → ${googleAddr}`);
        const forbiddenInfo = this.buildForbiddenPickupByCoords(lat, lng);
        return {
          lat,
          lng,
          formattedAddress: hualienAddressDB.cleanupDisplay(hasDetail ? googleAddr : address),
          ...(forbiddenInfo ? { forbiddenPickup: forbiddenInfo } : {}),
        };
      }

      console.warn(`[PhoneCallProcessor] Places Search 無結果: ${address}`);
      return null;
    } catch (error) {
      console.error('[PhoneCallProcessor] Places Search 失敗:', error);
      return null;
    }
  }

  /**
   * 建立電話訂單
   */
  private async createPhoneOrder(
    call: PhoneCallRecord,
    fields: ParsedFields,
    pickup: GeocodingResult,
    dest: GeocodingResult | null,
    transcript: string
  ): Promise<string> {
    const orderId = `ORD${Date.now()}`;
    const now = new Date();
    const passengerId = `PHONE_${call.callerNumber}`;

    // 確保電話乘客記錄存在（以 phone 為衝突鍵，避免 phone UNIQUE 約束衝突）
    const passengerResult = await this.pool.query(`
      INSERT INTO passengers (passenger_id, name, phone)
      VALUES ($1, $2, $3)
      ON CONFLICT (phone) DO UPDATE SET
        name = EXCLUDED.name,
        updated_at = CURRENT_TIMESTAMP
      RETURNING passenger_id
    `, [passengerId, fields.customer_name || `來電 ${call.callerNumber}`, call.callerNumber]);

    const actualPassengerId = passengerResult.rows[0].passenger_id;

    await this.pool.query(`
      INSERT INTO orders (
        order_id, passenger_id, status,
        pickup_lat, pickup_lng, pickup_address,
        dest_lat, dest_lng, dest_address,
        payment_type,
        created_at, offered_at,
        hour_of_day, day_of_week,
        source, subsidy_type, pet_present, pet_carrier, pet_note,
        dropoff_original, destination_confirmed,
        call_id, audio_url, transcript, customer_phone
      ) VALUES (
        $1, $2, 'OFFERED',
        $3, $4, $5,
        $6, $7, $8,
        $9,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        $10, $11,
        'PHONE', $12, $13, $14, $15,
        $16, FALSE,
        $17, $18, $19, $20
      )
    `, [
      orderId,
      actualPassengerId,
      pickup.lat, pickup.lng, pickup.formattedAddress,
      dest?.lat || null, dest?.lng || null, fields.destination_address || dest?.formattedAddress || null,
      fields.subsidy_type !== 'NONE' ? 'SUBSIDY' : 'CASH',
      now.getHours(), now.getDay(),
      fields.subsidy_type, fields.pet_present, fields.pet_carrier, fields.pet_note,
      fields.destination_address,
      call.callId, call.recordingUrl, transcript, call.callerNumber
    ]);

    console.log(`[PhoneCallProcessor] 電話訂單已建立: ${orderId}`);
    return orderId;
  }

  /**
   * 查詢同號碼 4 小時內的活動訂單
   */
  private async findActiveOrderByPhone(callerNumber: string): Promise<any | null> {
    const result = await this.pool.query(`
      SELECT * FROM orders
      WHERE customer_phone = $1
        AND status IN ('OFFERED', 'WAITING', 'ACCEPTED', 'ARRIVED', 'ON_TRIP')
        AND created_at > NOW() - INTERVAL '4 hours'
      ORDER BY created_at DESC
      LIMIT 1
    `, [callerNumber]);

    return result.rows[0] || null;
  }

  // ========== DB 操作 ==========

  private async getCallRecord(callId: string): Promise<PhoneCallRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM phone_calls WHERE call_id = $1',
      [callId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      callId: row.call_id,
      callerNumber: row.caller_number,
      durationSeconds: row.duration_seconds,
      recordingUrl: row.recording_url,
      processingStatus: row.processing_status,
      transcript: row.transcript,
      parsedFields: row.parsed_fields,
      orderId: row.order_id,
      eventType: row.event_type,
      errorMessage: row.error_message,
      retryCount: row.retry_count
    };
  }

  private async updateStatus(callId: string, status: string): Promise<void> {
    await this.pool.query(
      'UPDATE phone_calls SET processing_status = $1, updated_at = CURRENT_TIMESTAMP WHERE call_id = $2',
      [status, callId]
    );
    console.log(`[PhoneCallProcessor] 狀態更新: ${callId} → ${status}`);
  }

  private async updateTranscript(callId: string, transcript: string): Promise<void> {
    await this.pool.query(
      'UPDATE phone_calls SET transcript = $1, updated_at = CURRENT_TIMESTAMP WHERE call_id = $2',
      [transcript, callId]
    );
  }

  private async updateParsedFields(callId: string, fields: ParsedFields): Promise<void> {
    await this.pool.query(
      'UPDATE phone_calls SET parsed_fields = $1, updated_at = CURRENT_TIMESTAMP WHERE call_id = $2',
      [JSON.stringify(fields), callId]
    );
  }

  private async updateEventType(callId: string, eventType: string): Promise<void> {
    await this.pool.query(
      'UPDATE phone_calls SET event_type = $1, updated_at = CURRENT_TIMESTAMP WHERE call_id = $2',
      [eventType, callId]
    );
  }

  private async linkOrderToCall(callId: string, orderId: string): Promise<void> {
    await this.pool.query(
      'UPDATE phone_calls SET order_id = $1, updated_at = CURRENT_TIMESTAMP WHERE call_id = $2',
      [orderId, callId]
    );
  }

  /**
   * 持久化信心度分數
   */
  private async persistConfidenceScores(callId: string, eventConfidence: number, fieldConfidence: number | null): Promise<void> {
    await this.pool.query(
      `UPDATE phone_calls SET event_confidence = $1, field_confidence = $2, updated_at = CURRENT_TIMESTAMP WHERE call_id = $3`,
      [eventConfidence, fieldConfidence, callId]
    );
  }

  /**
   * 上車點命中禁止上車區（例花蓮火車站）的處理：
   *  - 不建單、不派單
   *  - 標記 phone_calls.processing_status='NEEDS_REVIEW'
   *  - error_message 記錄禁止地點 + 替代點清單，operator 撥回客人時直接念
   *  - 推 admin Socket 即時通知（type=phone:forbidden_pickup）
   */
  private async handleForbiddenPickupCall(
    callId: string,
    call: PhoneCallRecord,
    transcript: string,
    parsedFields: ParsedFields,
    forbiddenPickup: NonNullable<GeocodingResult['forbiddenPickup']>,
    alternativesText: string
  ): Promise<void> {
    const reviewNote = `⚠️ 上車點為禁止載客區「${forbiddenPickup.matchedLandmark}」，請聯繫客人改至：${alternativesText}`;

    await this.pool.query(
      `UPDATE phone_calls
       SET processing_status = 'NEEDS_REVIEW',
           error_message = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE call_id = $2`,
      [reviewNote, callId]
    );

    // 後台通知（復用既有審核通知通道，附上完整提示）
    try {
      const notificationService = getNotificationService();
      await notificationService.notifyPhoneCallNeedsReview(
        callId,
        call.callerNumber,
        `${reviewNote}\n\n原始錄音內容：${transcript}`
      );
    } catch (err) {
      console.error('[PhoneCallProcessor] 建立禁止上車審核通知失敗:', err);
    }

    // Socket 即時推播
    try {
      notifyAdmins('phone:forbidden_pickup', {
        callId,
        callerNumber: call.callerNumber,
        transcript: transcript?.substring(0, 100),
        matchedLandmark: forbiddenPickup.matchedLandmark,
        alternatives: forbiddenPickup.alternatives.map(a => ({ id: a.id, name: a.name })),
        pickupAddress: parsedFields.pickup_address,
        createdAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('[PhoneCallProcessor] Socket 推播失敗:', err);
    }

    console.log(`[PhoneCallProcessor] 已標記禁止上車區人工審核: ${callId}`);
  }

  /**
   * 標記為需人工審核
   */
  private async markNeedsReview(
    callId: string,
    call: PhoneCallRecord,
    transcript: string,
    eventClassification: { eventType: string; confidence: number },
    parsedFields: ParsedFields | null
  ): Promise<void> {
    await this.pool.query(
      `UPDATE phone_calls SET processing_status = 'NEEDS_REVIEW', updated_at = CURRENT_TIMESTAMP WHERE call_id = $1`,
      [callId]
    );

    // 建立後台通知
    try {
      const notificationService = getNotificationService();
      await notificationService.notifyPhoneCallNeedsReview(callId, call.callerNumber, transcript);
    } catch (err) {
      console.error('[PhoneCallProcessor] 建立審核通知失敗:', err);
    }

    // Socket 即時推播給在線管理員
    try {
      notifyAdmins('phone:needs_review', {
        callId,
        callerNumber: call.callerNumber,
        transcript: transcript?.substring(0, 100),
        eventType: eventClassification.eventType,
        eventConfidence: eventClassification.confidence,
        fieldConfidence: parsedFields?.confidence ?? null,
        createdAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('[PhoneCallProcessor] Socket 推播失敗:', err);
    }

    console.log(`[PhoneCallProcessor] 已標記為 NEEDS_REVIEW: ${callId}`);
  }

  /**
   * Operator 審核通過後恢復處理
   */
  async resumeAfterApproval(callId: string, editedFields?: Record<string, any>): Promise<void> {
    console.log(`\n[PhoneCallProcessor] ====== 審核通過，恢復處理 ${callId} ======`);

    try {
      const call = await this.getCallRecord(callId);
      if (!call) {
        throw new Error(`找不到電話記錄: ${callId}`);
      }

      // 合併 operator 編輯的欄位到原始 parsed_fields
      let finalFields: ParsedFields | null = call.parsedFields || null;
      if (editedFields) {
        finalFields = { ...(finalFields || {} as ParsedFields), ...editedFields };
        await this.updateParsedFields(callId, finalFields);
      }

      const transcript = call.transcript || '';
      const eventType = call.eventType || 'NEW_ORDER';

      // 重新進入事件處理流程
      // 注意：URGE/CHANGE 在找不到活動訂單時會 updateEventType 為 NEW_ORDER 然後 return
      // 審核後直接以 operator 核准的 eventType 處理，若無活動訂單則一律走 NEW_ORDER
      switch (eventType) {
        case 'NEW_ORDER':
          await this.handleNewOrder(callId, call, transcript, finalFields);
          break;
        case 'URGE': {
          const activeOrder = await this.findActiveOrderByPhone(call.callerNumber);
          if (!activeOrder) {
            console.log(`[PhoneCallProcessor] 審核後催單無活動訂單，轉新訂單處理`);
            await this.handleNewOrder(callId, call, transcript, finalFields);
          } else {
            await this.handleUrge(callId, call, activeOrder);
          }
          break;
        }
        case 'CANCEL': {
          const activeOrder = await this.findActiveOrderByPhone(call.callerNumber);
          await this.handleCancel(callId, call, activeOrder);
          break;
        }
        case 'CHANGE': {
          const activeOrder = await this.findActiveOrderByPhone(call.callerNumber);
          if (!activeOrder) {
            console.log(`[PhoneCallProcessor] 審核後變更無活動訂單，轉新訂單處理`);
            await this.handleNewOrder(callId, call, transcript, finalFields);
          } else {
            await this.handleChange(callId, call, activeOrder, editedFields?.changeDetails);
          }
          break;
        }
      }
    } catch (error: any) {
      console.error(`[PhoneCallProcessor] 審核後處理失敗 (${callId}):`, error);
      await this.markFailed(callId, `審核後處理失敗: ${error.message}`);
    }
  }

  private async markFailed(callId: string, errorMessage: string): Promise<void> {
    await this.pool.query(
      `UPDATE phone_calls
       SET processing_status = 'FAILED',
           error_message = $1,
           retry_count = retry_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE call_id = $2`,
      [errorMessage, callId]
    );
  }
}

// ========== 單例 ==========

let processorInstance: PhoneCallProcessor | null = null;

export function initPhoneCallProcessor(pool: Pool): PhoneCallProcessor {
  if (!processorInstance) {
    processorInstance = new PhoneCallProcessor(pool);
    console.log('[PhoneCallProcessor] 初始化完成');
  }
  return processorInstance;
}

export function getPhoneCallProcessor(): PhoneCallProcessor {
  if (!processorInstance) {
    throw new Error('PhoneCallProcessor 尚未初始化');
  }
  return processorInstance;
}

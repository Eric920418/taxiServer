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
import { getSocketIO, driverSockets } from '../socket';

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
}

// ========== 服務類 ==========

export class PhoneCallProcessor {
  private pool: Pool;
  private openai: OpenAI;
  private fieldExtractor: CallFieldExtractor;
  private googleMapsApiKey: string;

  // 3CX 錄音存放路徑
  private recordingsBasePath: string;

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

      // 5. 根據事件類型處理
      switch (eventClassification.eventType) {
        case 'NEW_ORDER':
          await this.handleNewOrder(callId, call, transcript);
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
    transcript: string
  ): Promise<void> {
    console.log(`[PhoneCallProcessor] 處理新訂單...`);

    // GPT 欄位提取
    const parsedFields = await this.fieldExtractor.extractFields(transcript);
    console.log(`[PhoneCallProcessor] 解析結果:`, JSON.stringify(parsedFields, null, 2));
    await this.updateParsedFields(callId, parsedFields);

    // 地址 Geocoding
    let pickupGeo: GeocodingResult | null = null;
    let destGeo: GeocodingResult | null = null;

    if (parsedFields.pickup_address) {
      pickupGeo = await this.geocodeAddress(parsedFields.pickup_address);
    }
    if (parsedFields.destination_address) {
      destGeo = await this.geocodeAddress(parsedFields.destination_address);
    }

    // 如果上車點無法 geocoding，使用花蓮市中心作為預設
    if (!pickupGeo) {
      console.warn('[PhoneCallProcessor] 上車點無法定位，使用花蓮預設座標');
      pickupGeo = {
        lat: 23.9871,
        lng: 121.6015,
        formattedAddress: parsedFields.pickup_address || '花蓮市（電話訂單，待確認地址）'
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
          address: destGeo.formattedAddress
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
    } catch (dispatchError) {
      console.error('[PhoneCallProcessor] 派單失敗:', dispatchError);
      // 派單失敗不影響訂單建立
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
      console.warn('[PhoneCallProcessor] 取消但無活動訂單');
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
      model: 'whisper-1',
      language: 'zh',
      response_format: 'text'
    });

    return response as unknown as string;
  }

  /**
   * 下載/取得錄音檔
   */
  private async downloadRecording(call: PhoneCallRecord): Promise<string> {
    // 3CX 錄音路徑直接在本機
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
   * Google Places Geocoding
   */
  private async geocodeAddress(address: string): Promise<GeocodingResult | null> {
    if (!this.googleMapsApiKey) {
      console.warn('[PhoneCallProcessor] 未設定 GOOGLE_MAPS_API_KEY，跳過 Geocoding');
      return null;
    }

    try {
      const encodedAddress = encodeURIComponent(`${address} 花蓮`);
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodedAddress}&key=${this.googleMapsApiKey}&language=zh-TW&region=tw`;

      const response = await fetch(url);
      const data = await response.json() as any;

      if (data.results && data.results.length > 0) {
        const result = data.results[0];
        return {
          lat: result.geometry.location.lat,
          lng: result.geometry.location.lng,
          formattedAddress: result.formatted_address || address
        };
      }

      console.warn(`[PhoneCallProcessor] Geocoding 無結果: ${address}`);
      return null;
    } catch (error) {
      console.error('[PhoneCallProcessor] Geocoding 失敗:', error);
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

    // 確保電話乘客記錄存在
    await this.pool.query(`
      INSERT INTO passengers (passenger_id, name, phone)
      VALUES ($1, $2, $3)
      ON CONFLICT (passenger_id) DO UPDATE SET phone = $3, updated_at = CURRENT_TIMESTAMP
    `, [passengerId, fields.customer_name || `來電 ${call.callerNumber}`, call.callerNumber]);

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
      passengerId,
      pickup.lat, pickup.lng, pickup.formattedAddress,
      dest?.lat || null, dest?.lng || null, dest?.formattedAddress || null,
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
   * 查詢同號碼 30 分鐘內的活動訂單
   */
  private async findActiveOrderByPhone(callerNumber: string): Promise<any | null> {
    const result = await this.pool.query(`
      SELECT * FROM orders
      WHERE customer_phone = $1
        AND status IN ('OFFERED', 'WAITING', 'ACCEPTED', 'ARRIVED', 'ON_TRIP')
        AND created_at > NOW() - INTERVAL '30 minutes'
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

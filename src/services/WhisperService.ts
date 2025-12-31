/**
 * WhisperService - 語音轉文字 + 意圖解析服務
 * 使用 OpenAI Whisper API 進行語音轉錄
 * 使用 GPT-4o-mini 進行自然語言意圖解析
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

// ========== 類型定義 ==========

// 司機端指令
export type DriverVoiceAction =
  | 'ACCEPT_ORDER'
  | 'REJECT_ORDER'
  | 'MARK_ARRIVED'
  | 'START_TRIP'
  | 'END_TRIP'
  | 'UPDATE_STATUS'
  | 'QUERY_EARNINGS'
  | 'NAVIGATE'
  | 'EMERGENCY'
  | 'UNKNOWN';

// 乘客端指令
export type PassengerVoiceAction =
  | 'BOOK_RIDE'        // 叫車（包含目的地）
  | 'SET_DESTINATION'  // 設置目的地
  | 'SET_PICKUP'       // 設置上車點
  | 'CANCEL_ORDER'     // 取消訂單
  | 'CALL_DRIVER'      // 聯絡司機
  | 'CHECK_STATUS'     // 查詢訂單狀態
  | 'UNKNOWN';

export type VoiceAction = DriverVoiceAction | PassengerVoiceAction;

export interface VoiceCommandParams {
  orderId?: string;
  rejectionReason?: string;
  status?: string;
  destination?: string;       // 目的地地址
  destinationQuery?: string;  // 目的地搜尋關鍵字（乘客端）
  pickupAddress?: string;     // 上車點地址（乘客端）
  pickupQuery?: string;       // 上車點搜尋關鍵字（乘客端）
  query?: string;
}

export interface VoiceCommand {
  action: VoiceAction;
  params: VoiceCommandParams;
  confidence: number;
  rawText: string;
  transcription: string;
}

export interface DriverContext {
  driverId: string;
  currentStatus: string;  // OFFLINE | REST | AVAILABLE | ON_TRIP
  currentOrderId?: string;
  currentOrderStatus?: string;
  pickupAddress?: string;
  destinationAddress?: string;
}

export interface PassengerContext {
  passengerId: string;
  hasActiveOrder: boolean;
  orderStatus?: string;       // WAITING | ACCEPTED | ON_TRIP | etc.
  currentPickupAddress?: string;
  currentDestinationAddress?: string;
  driverName?: string;
  driverPhone?: string;
}

export type UserContext =
  | { type: 'driver'; context: DriverContext }
  | { type: 'passenger'; context: PassengerContext };

export interface TranscribeResult {
  success: boolean;
  command?: VoiceCommand;
  error?: string;
  processingTimeMs?: number;
}

interface UsageStats {
  dailyMinutes: number;
  dailyTokens: number;
  monthlyMinutes: number;
  monthlyTokens: number;
  monthlyEstimatedCostUSD: number;
  lastResetDate: string;
}

// ========== 服務類 ==========

class WhisperService {
  private openai: OpenAI | null = null;
  private isInitialized = false;

  // 用量追蹤
  private dailyMinutes = 0;
  private dailyTokens = 0;
  private monthlyMinutes = 0;
  private monthlyTokens = 0;
  private lastResetDate: string = '';

  // 配置
  private readonly DAILY_LIMIT_MINUTES: number;
  private readonly MONTHLY_BUDGET_USD: number;
  private readonly WHISPER_COST_PER_MINUTE = 0.006;  // USD
  private readonly GPT_COST_PER_1K_TOKENS = 0.00015; // GPT-4o-mini

  constructor() {
    this.DAILY_LIMIT_MINUTES = parseInt(process.env.WHISPER_DAILY_LIMIT_MINUTES || '60');
    this.MONTHLY_BUDGET_USD = parseInt(process.env.WHISPER_MONTHLY_BUDGET_USD || '50');
  }

  /**
   * 初始化服務
   */
  init(): void {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.warn('[WhisperService] 警告：未設置 OPENAI_API_KEY，語音功能將不可用');
      return;
    }

    this.openai = new OpenAI({ apiKey });
    this.isInitialized = true;
    this.lastResetDate = this.getTodayDate();

    console.log('[WhisperService] 初始化完成');
    console.log(`[WhisperService] 每日限制: ${this.DAILY_LIMIT_MINUTES} 分鐘`);
    console.log(`[WhisperService] 月預算: $${this.MONTHLY_BUDGET_USD} USD`);
  }

  /**
   * 檢查服務是否可用
   */
  isAvailable(): boolean {
    return this.isInitialized && this.openai !== null;
  }

  /**
   * 語音轉錄 + 意圖解析（司機端）
   */
  async transcribeAndParse(
    audioFilePath: string,
    context: DriverContext
  ): Promise<TranscribeResult> {
    return this.transcribeAndParseUnified(audioFilePath, { type: 'driver', context });
  }

  /**
   * 語音轉錄 + 意圖解析（乘客端）
   */
  async transcribeAndParsePassenger(
    audioFilePath: string,
    context: PassengerContext
  ): Promise<TranscribeResult> {
    return this.transcribeAndParseUnified(audioFilePath, { type: 'passenger', context });
  }

  /**
   * 統一語音處理方法
   */
  private async transcribeAndParseUnified(
    audioFilePath: string,
    userContext: UserContext
  ): Promise<TranscribeResult> {
    const startTime = Date.now();

    if (!this.isAvailable()) {
      return {
        success: false,
        error: '語音服務未初始化，請設置 OPENAI_API_KEY'
      };
    }

    // 檢查配額
    this.checkAndResetDaily();
    if (!this.checkQuota()) {
      return {
        success: false,
        error: '已達到每日用量限制，請明天再試'
      };
    }

    try {
      // Step 1: Whisper 語音轉錄
      console.log('[WhisperService] 開始語音轉錄...');
      const transcription = await this.transcribe(audioFilePath);
      console.log(`[WhisperService] 轉錄結果: "${transcription}"`);

      if (!transcription || transcription.trim().length === 0) {
        return {
          success: false,
          error: '無法識別語音內容，請再試一次',
          processingTimeMs: Date.now() - startTime
        };
      }

      // Step 2: GPT-4o-mini 意圖解析
      console.log('[WhisperService] 開始意圖解析...');
      const command = userContext.type === 'driver'
        ? await this.parseIntent(transcription, userContext.context)
        : await this.parsePassengerIntent(transcription, userContext.context);
      console.log(`[WhisperService] 解析結果: ${command.action} (信心度: ${command.confidence})`);

      return {
        success: true,
        command,
        processingTimeMs: Date.now() - startTime
      };

    } catch (error: any) {
      console.error('[WhisperService] 處理失敗:', error);
      return {
        success: false,
        error: error.message || '語音處理失敗',
        processingTimeMs: Date.now() - startTime
      };
    }
  }

  /**
   * 使用 Whisper API 進行語音轉錄
   */
  private async transcribe(audioFilePath: string): Promise<string> {
    if (!this.openai) throw new Error('OpenAI client not initialized');

    // 獲取音檔時長（估算用於計費）
    const stats = fs.statSync(audioFilePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    const estimatedMinutes = Math.max(0.1, fileSizeMB / 0.5); // 粗略估算

    const audioFile = fs.createReadStream(audioFilePath);

    const response = await this.openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      language: 'zh',  // 指定繁體中文
      response_format: 'text'
    });

    // 更新用量
    this.dailyMinutes += estimatedMinutes;
    this.monthlyMinutes += estimatedMinutes;

    return response as unknown as string;
  }

  /**
   * 使用 GPT-4o-mini 解析意圖
   */
  private async parseIntent(
    transcription: string,
    context: DriverContext
  ): Promise<VoiceCommand> {
    if (!this.openai) throw new Error('OpenAI client not initialized');

    const systemPrompt = this.buildSystemPrompt(context);
    const userPrompt = `司機說：「${transcription}」`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1,  // 低溫度確保一致性
      max_tokens: 200,
      response_format: { type: 'json_object' }
    });

    // 更新 token 用量
    const tokensUsed = response.usage?.total_tokens || 0;
    this.dailyTokens += tokensUsed;
    this.monthlyTokens += tokensUsed;

    // 解析回應
    const content = response.choices[0]?.message?.content || '{}';

    try {
      const parsed = JSON.parse(content);
      return {
        action: this.validateAction(parsed.action),
        params: parsed.params || {},
        confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
        rawText: transcription,
        transcription
      };
    } catch (e) {
      console.error('[WhisperService] JSON 解析失敗:', content);
      return {
        action: 'UNKNOWN',
        params: {},
        confidence: 0,
        rawText: transcription,
        transcription
      };
    }
  }

  /**
   * 使用 GPT-4o-mini 解析乘客端意圖
   */
  private async parsePassengerIntent(
    transcription: string,
    context: PassengerContext
  ): Promise<VoiceCommand> {
    if (!this.openai) throw new Error('OpenAI client not initialized');

    const systemPrompt = this.buildPassengerSystemPrompt(context);
    const userPrompt = `乘客說：「${transcription}」`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: 'json_object' }
    });

    // 更新 token 用量
    const tokensUsed = response.usage?.total_tokens || 0;
    this.dailyTokens += tokensUsed;
    this.monthlyTokens += tokensUsed;

    // 解析回應
    const content = response.choices[0]?.message?.content || '{}';

    try {
      const parsed = JSON.parse(content);
      return {
        action: this.validatePassengerAction(parsed.action),
        params: parsed.params || {},
        confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
        rawText: transcription,
        transcription
      };
    } catch (e) {
      console.error('[WhisperService] JSON 解析失敗:', content);
      return {
        action: 'UNKNOWN',
        params: {},
        confidence: 0,
        rawText: transcription,
        transcription
      };
    }
  }

  /**
   * 構建乘客端 GPT 系統提示詞
   */
  private buildPassengerSystemPrompt(context: PassengerContext): string {
    let statusDescription = '';
    if (context.hasActiveOrder) {
      statusDescription = `目前有進行中的訂單（狀態：${context.orderStatus || '處理中'}）`;
      if (context.driverName) {
        statusDescription += `\n司機：${context.driverName}`;
      }
      if (context.currentPickupAddress) {
        statusDescription += `\n上車點：${context.currentPickupAddress}`;
      }
      if (context.currentDestinationAddress) {
        statusDescription += `\n目的地：${context.currentDestinationAddress}`;
      }
    } else {
      statusDescription = '目前沒有進行中的訂單，可以叫車';
    }

    return `你是花蓮計程車乘客語音助理。解析乘客的台灣口語指令並轉換為結構化 JSON。

## 當前狀態
乘客ID：${context.passengerId}
${statusDescription}

## 可用指令

1. BOOK_RIDE - 叫車（包含目的地）
   觸發詞：「去xxx」「到xxx」「我要去xxx」「叫車到xxx」「載我去xxx」
   params.destinationQuery：目的地關鍵字（如「火車站」「太魯閣」「七星潭」）
   適用狀態：沒有進行中的訂單

2. SET_DESTINATION - 單獨設置目的地
   觸發詞：「目的地xxx」「終點是xxx」「要去xxx」
   params.destinationQuery：目的地關鍵字
   適用狀態：沒有進行中的訂單

3. SET_PICKUP - 設置上車點
   觸發詞：「在xxx上車」「上車點是xxx」「來xxx接我」「我在xxx」
   params.pickupQuery：上車點關鍵字
   適用狀態：沒有進行中的訂單

4. CANCEL_ORDER - 取消訂單
   觸發詞：「取消」「不要了」「取消訂單」「不叫了」
   適用狀態：有進行中的訂單（WAITING 狀態）

5. CALL_DRIVER - 聯絡司機
   觸發詞：「打給司機」「聯絡司機」「打電話」
   適用狀態：有進行中的訂單且已被司機接受

6. CHECK_STATUS - 查詢訂單狀態
   觸發詞：「司機在哪」「多久到」「訂單狀態」「現在什麼情況」
   適用狀態：有進行中的訂單

7. UNKNOWN - 無法識別
   當無法明確識別意圖時使用

## 花蓮常見地點參考
- 火車站：花蓮火車站、新城火車站
- 景點：太魯閣、七星潭、鯉魚潭、東大門夜市、松園別館
- 醫院：慈濟醫院、花蓮醫院
- 學校：東華大學、慈濟大學、花蓮高中
- 商圈：中山路、中正路、遠百

## 輸出格式
必須回傳有效的 JSON：
{
  "action": "指令類型",
  "params": {
    "destinationQuery": "目的地關鍵字（如有）",
    "pickupQuery": "上車點關鍵字（如有）"
  },
  "confidence": 0.0-1.0
}

## 注意事項
- 台灣口語常省略「我要」「請」等詞
- 「去火車站」= BOOK_RIDE + destinationQuery: "火車站"
- 提取地點名稱時保留完整名稱（如「花蓮火車站」不要縮寫）
- 信心度低於 0.6 時，建議設為 UNKNOWN`;
  }

  /**
   * 驗證乘客端 action 類型
   */
  private validatePassengerAction(action: string): PassengerVoiceAction {
    const validActions: PassengerVoiceAction[] = [
      'BOOK_RIDE', 'SET_DESTINATION', 'SET_PICKUP',
      'CANCEL_ORDER', 'CALL_DRIVER', 'CHECK_STATUS', 'UNKNOWN'
    ];

    if (validActions.includes(action as PassengerVoiceAction)) {
      return action as PassengerVoiceAction;
    }
    return 'UNKNOWN';
  }

  /**
   * 構建 GPT 系統提示詞
   */
  private buildSystemPrompt(context: DriverContext): string {
    let statusDescription = '';
    switch (context.currentStatus) {
      case 'OFFLINE':
        statusDescription = '目前離線';
        break;
      case 'REST':
        statusDescription = '目前休息中';
        break;
      case 'AVAILABLE':
        statusDescription = '目前可接單';
        break;
      case 'ON_TRIP':
        statusDescription = '目前執行訂單中';
        break;
    }

    let orderDescription = '';
    if (context.currentOrderId) {
      orderDescription = `\n當前訂單ID：${context.currentOrderId}`;
      orderDescription += `\n訂單狀態：${context.currentOrderStatus || '未知'}`;
      if (context.pickupAddress) {
        orderDescription += `\n上車點：${context.pickupAddress}`;
      }
      if (context.destinationAddress) {
        orderDescription += `\n目的地：${context.destinationAddress}`;
      }
    }

    return `你是花蓮計程車司機語音助理。解析司機的台灣口語指令並轉換為結構化 JSON。

## 當前狀態
司機ID：${context.driverId}
狀態：${statusDescription}${orderDescription}

## 可用指令
根據當前狀態，解析以下指令：

1. ACCEPT_ORDER - 接受訂單
   觸發詞：「好」「接」「可以」「我來」「OK」「沒問題」
   適用狀態：收到新訂單時

2. REJECT_ORDER - 拒絕訂單
   觸發詞：「不要」「拒絕」「不接」「太遠」「不去」
   params.rejectionReason：TOO_FAR / LOW_FARE / UNWANTED_AREA / OFF_DUTY / OTHER
   適用狀態：收到新訂單時

3. MARK_ARRIVED - 已到達上車點
   觸發詞：「到了」「我到了」「到達」「已抵達」
   適用狀態：ON_TRIP 且訂單狀態為 ACCEPTED

4. START_TRIP - 開始行程（乘客上車）
   觸發詞：「上車了」「出發」「開始」「走了」
   適用狀態：ON_TRIP 且訂單狀態為 ARRIVED

5. END_TRIP - 結束行程
   觸發詞：「到了」「結束」「完成」「下車」
   適用狀態：ON_TRIP 且訂單狀態為 ON_TRIP

6. UPDATE_STATUS - 更新上線狀態
   觸發詞：「上線」「下線」「休息」「開工」「收工」
   params.status：AVAILABLE / REST / OFFLINE

7. QUERY_EARNINGS - 查詢收入
   觸發詞：「今天賺多少」「收入」「業績」「跑了多少」

8. NAVIGATE - 導航
   觸發詞：「導航到」「去」「怎麼走」
   params.destination：目的地地址

9. EMERGENCY - 緊急求助
   觸發詞：「救命」「報警」「緊急」「SOS」

10. UNKNOWN - 無法識別
    當無法明確識別意圖時使用

## 輸出格式
必須回傳有效的 JSON：
{
  "action": "指令類型",
  "params": { ... },
  "confidence": 0.0-1.0
}

## 注意事項
- 台灣口語可能省略主詞或使用簡短表達
- 「到了」根據訂單狀態判斷是 MARK_ARRIVED 還是 END_TRIP
- 信心度低於 0.6 時，建議設為 UNKNOWN
- params 只包含該指令需要的參數`;
  }

  /**
   * 驗證 action 類型
   */
  private validateAction(action: string): VoiceAction {
    const validActions: VoiceAction[] = [
      'ACCEPT_ORDER', 'REJECT_ORDER', 'MARK_ARRIVED',
      'START_TRIP', 'END_TRIP', 'UPDATE_STATUS',
      'QUERY_EARNINGS', 'NAVIGATE', 'EMERGENCY', 'UNKNOWN'
    ];

    if (validActions.includes(action as VoiceAction)) {
      return action as VoiceAction;
    }
    return 'UNKNOWN';
  }

  /**
   * 檢查並重置每日計數
   */
  private checkAndResetDaily(): void {
    const today = this.getTodayDate();
    if (this.lastResetDate !== today) {
      console.log('[WhisperService] 重置每日計數');
      this.dailyMinutes = 0;
      this.dailyTokens = 0;
      this.lastResetDate = today;

      // 每月 1 日重置月計數
      if (today.endsWith('-01')) {
        console.log('[WhisperService] 重置每月計數');
        this.monthlyMinutes = 0;
        this.monthlyTokens = 0;
      }
    }
  }

  /**
   * 檢查配額
   */
  private checkQuota(): boolean {
    // 檢查每日限制
    if (this.dailyMinutes >= this.DAILY_LIMIT_MINUTES) {
      console.warn(`[WhisperService] 已達每日限制: ${this.dailyMinutes}/${this.DAILY_LIMIT_MINUTES} 分鐘`);
      return false;
    }

    // 檢查月預算
    const estimatedCost = this.getEstimatedMonthlyCost();
    if (estimatedCost >= this.MONTHLY_BUDGET_USD) {
      console.warn(`[WhisperService] 已達月預算: $${estimatedCost.toFixed(2)}/$${this.MONTHLY_BUDGET_USD}`);
      return false;
    }

    return true;
  }

  /**
   * 獲取預估月成本
   */
  private getEstimatedMonthlyCost(): number {
    const whisperCost = this.monthlyMinutes * this.WHISPER_COST_PER_MINUTE;
    const gptCost = (this.monthlyTokens / 1000) * this.GPT_COST_PER_1K_TOKENS;
    return whisperCost + gptCost;
  }

  /**
   * 獲取今天日期字串
   */
  private getTodayDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * 獲取用量統計
   */
  getUsageStats(): UsageStats {
    return {
      dailyMinutes: Math.round(this.dailyMinutes * 100) / 100,
      dailyTokens: this.dailyTokens,
      monthlyMinutes: Math.round(this.monthlyMinutes * 100) / 100,
      monthlyTokens: this.monthlyTokens,
      monthlyEstimatedCostUSD: Math.round(this.getEstimatedMonthlyCost() * 100) / 100,
      lastResetDate: this.lastResetDate
    };
  }
}

// ========== 單例導出 ==========

let whisperServiceInstance: WhisperService | null = null;

export function initWhisperService(): void {
  if (!whisperServiceInstance) {
    whisperServiceInstance = new WhisperService();
    whisperServiceInstance.init();
  }
}

export function getWhisperService(): WhisperService {
  if (!whisperServiceInstance) {
    throw new Error('WhisperService 尚未初始化，請先呼叫 initWhisperService()');
  }
  return whisperServiceInstance;
}

export default WhisperService;

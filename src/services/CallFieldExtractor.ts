/**
 * CallFieldExtractor - GPT 電話訂單欄位提取服務
 * 使用 GPT-4.1-mini 從電話錄音轉錄文本中提取訂單欄位
 */

import OpenAI from 'openai';

// ========== 類型定義 ==========

export interface ParsedFields {
  pickup_address: string | null;
  destination_address: string | null;
  customer_name: string | null;
  passenger_count: number;
  subsidy_type: 'SENIOR_CARD' | 'LOVE_CARD' | 'PENDING' | 'NONE';
  pet_present: 'YES' | 'NO' | 'UNKNOWN';
  pet_carrier: 'YES' | 'NO' | 'UNKNOWN';
  pet_note: string | null;
  special_notes: string | null;
  confidence: number;
}

export type CallEventType = 'NEW_ORDER' | 'URGE' | 'CANCEL' | 'CHANGE';

export interface EventClassification {
  eventType: CallEventType;
  confidence: number;
  relatedOrderId?: string;
  changeDetails?: string;
}

// 花蓮地標映射
const HUALIEN_LANDMARKS: Record<string, string> = {
  '火車站': '花蓮火車站',
  '車站': '花蓮火車站',
  '東大門': '東大門夜市',
  '夜市': '東大門夜市',
  '遠百': '遠東百貨花蓮店',
  '遠東': '遠東百貨花蓮店',
  '百貨': '遠東百貨花蓮店',
  '慈濟': '慈濟醫院',
  '慈濟醫院': '花蓮慈濟醫院',
  '門諾': '門諾醫院',
  '部立': '衛生福利部花蓮醫院',
  '花蓮醫院': '衛生福利部花蓮醫院',
  '機場': '花蓮航空站',
  '航空站': '花蓮航空站',
  '太魯閣': '太魯閣國家公園遊客中心',
  '七星潭': '七星潭風景區',
  '松園': '松園別館',
  '鯉魚潭': '鯉魚潭風景區',
  '新天堂樂園': '花蓮新天堂樂園',
  '花蓮港': '花蓮港',
  '南濱': '南濱公園',
  '北濱': '北濱公園',
  '美崙': '美崙山',
  '中正路': '花蓮市中正路',
  '中華路': '花蓮市中華路',
  '國聯': '花蓮市國聯一路',
  '林森路': '花蓮市林森路',
  '中山路': '花蓮市中山路',
  '家樂福': '家樂福花蓮店',
  '好市多': '好市多花蓮店',
  '大潤發': '大潤發花蓮店',
  '花蓮高中': '國立花蓮高級中學',
  '花中': '國立花蓮高級中學',
  '花女': '國立花蓮女子高級中學',
  '東華': '國立東華大學',
  '慈濟大學': '慈濟大學',
};

// ========== 服務類 ==========

export class CallFieldExtractor {
  private openai: OpenAI;

  constructor(openai: OpenAI) {
    this.openai = openai;
  }

  /**
   * 從轉錄文本提取訂單欄位
   */
  async extractFields(transcript: string): Promise<ParsedFields> {
    const systemPrompt = this.buildExtractionPrompt();

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `電話錄音轉錄：「${transcript}」` }
      ],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content || '{}';

    try {
      const parsed = JSON.parse(content);
      return {
        pickup_address: parsed.pickup_address || null,
        destination_address: this.normalizeAddress(parsed.destination_address),
        customer_name: parsed.customer_name || null,
        passenger_count: parsed.passenger_count || 1,
        subsidy_type: this.validateSubsidyType(parsed.subsidy_type),
        pet_present: this.validateTriState(parsed.pet_present),
        pet_carrier: this.validateTriState(parsed.pet_carrier),
        pet_note: parsed.pet_note || null,
        special_notes: parsed.special_notes || null,
        confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5))
      };
    } catch (e) {
      console.error('[CallFieldExtractor] JSON 解析失敗:', content);
      return {
        pickup_address: null,
        destination_address: null,
        customer_name: null,
        passenger_count: 1,
        subsidy_type: 'NONE',
        pet_present: 'UNKNOWN',
        pet_carrier: 'UNKNOWN',
        pet_note: null,
        special_notes: transcript,
        confidence: 0
      };
    }
  }

  /**
   * 分類電話事件類型（新訂單 / 催單 / 取消 / 變更）
   */
  async classifyEvent(
    transcript: string,
    hasActiveOrder: boolean,
    activeOrderInfo?: { orderId: string; status: string; pickupAddress: string }
  ): Promise<EventClassification> {
    const systemPrompt = `你是計程車電話叫車系統的意圖分類器。根據通話內容判斷來電者的意圖。請以 json 格式回覆。

## 背景資訊
${hasActiveOrder
  ? `該號碼有活動訂單：
  - 訂單ID：${activeOrderInfo?.orderId}
  - 訂單狀態：${activeOrderInfo?.status}
  - 上車地址：${activeOrderInfo?.pickupAddress}`
  : '該號碼目前沒有活動訂單。'
}

## 分類規則
1. NEW_ORDER - 新訂單：叫車、要去某地、派車
2. URGE - 催單：「車怎麼還沒來」「快一點」「到了沒」「多久到」（前提：有活動訂單）
3. CANCEL - 取消：「不要了」「取消」「不叫了」（前提：有活動訂單）
4. CHANGE - 變更：「改地址」「改目的地」「改時間」「多帶一個人」（前提：有活動訂單）

## 判斷邏輯
- 沒有活動訂單 → 一律視為 NEW_ORDER
- 有活動訂單時，根據內容語意判斷
- 如果無法確定，預設 NEW_ORDER

## 輸出格式
{
  "eventType": "NEW_ORDER/URGE/CANCEL/CHANGE",
  "confidence": 0.0-1.0,
  "changeDetails": "變更內容描述（僅 CHANGE 時提供）"
}`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `通話內容：「${transcript}」` }
      ],
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content || '{}';

    try {
      const parsed = JSON.parse(content);
      return {
        eventType: this.validateEventType(parsed.eventType),
        confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
        relatedOrderId: hasActiveOrder ? activeOrderInfo?.orderId : undefined,
        changeDetails: parsed.changeDetails || undefined
      };
    } catch (e) {
      console.error('[CallFieldExtractor] 事件分類 JSON 解析失敗:', content);
      return {
        eventType: 'NEW_ORDER',
        confidence: 0.3
      };
    }
  }

  /**
   * 建立欄位提取 prompt
   */
  private buildExtractionPrompt(): string {
    return `你是花蓮計程車電話叫車系統的欄位提取器。從客戶電話錄音的轉錄文本中提取訂單資訊。請以 json 格式回覆。

## 花蓮常用地標對照
- 火車站/車站 → 花蓮火車站
- 東大門/夜市 → 東大門夜市
- 遠百/遠東/百貨 → 遠東百貨花蓮店
- 慈濟 → 花蓮慈濟醫院
- 門諾 → 門諾醫院
- 機場 → 花蓮航空站
- 太魯閣 → 太魯閣國家公園遊客中心
- 七星潭 → 七星潭風景區

## 補貼卡類型辨識
- 敬老卡/老人卡/長者卡 → SENIOR_CARD
- 愛心卡/身障卡/殘障卡 → LOVE_CARD
- 提到「刷卡」但不確定類型 → PENDING
- 未提及 → NONE

## 寵物辨識
- 明確提到有寵物/帶狗/帶貓 → pet_present: YES
- 提到有籠子/提籠/寵物箱 → pet_carrier: YES
- 提到寵物但沒提籠子 → pet_carrier: UNKNOWN
- 未提及寵物 → pet_present: UNKNOWN
- 明確說沒帶寵物 → pet_present: NO

## 輸出格式（必須為 JSON）
{
  "pickup_address": "上車地點完整地址或地標名稱",
  "destination_address": "目的地完整地址或地標名稱",
  "customer_name": "客戶姓名（如有）",
  "passenger_count": 1,
  "subsidy_type": "NONE",
  "pet_present": "UNKNOWN",
  "pet_carrier": "UNKNOWN",
  "pet_note": "寵物相關備註",
  "special_notes": "其他特殊需求",
  "confidence": 0.8
}

## 注意事項
- 花蓮口語可能會用簡稱，請對照地標表轉換
- 如果只提到「來我家」或「來接我」，pickup_address 設為 null（需靠來電號碼地址簿查詢）
- confidence 反映提取結果的可信度：
  - 0.8-1.0：地址明確
  - 0.6-0.8：地址需要確認
  - 0.4-0.6：資訊模糊
  - < 0.4：幾乎無法辨識`;
  }

  /**
   * 正規化地址（套用花蓮地標映射）
   */
  private normalizeAddress(address: string | null): string | null {
    if (!address) return null;

    for (const [shortName, fullName] of Object.entries(HUALIEN_LANDMARKS)) {
      if (address.includes(shortName) && !address.includes(fullName)) {
        return address.replace(shortName, fullName);
      }
    }
    return address;
  }

  private validateSubsidyType(val: string): ParsedFields['subsidy_type'] {
    const valid = ['SENIOR_CARD', 'LOVE_CARD', 'PENDING', 'NONE'];
    return valid.includes(val) ? val as ParsedFields['subsidy_type'] : 'NONE';
  }

  private validateTriState(val: string): 'YES' | 'NO' | 'UNKNOWN' {
    const valid = ['YES', 'NO', 'UNKNOWN'];
    return valid.includes(val) ? val as 'YES' | 'NO' | 'UNKNOWN' : 'UNKNOWN';
  }

  private validateEventType(val: string): CallEventType {
    const valid: CallEventType[] = ['NEW_ORDER', 'URGE', 'CANCEL', 'CHANGE'];
    return valid.includes(val as CallEventType) ? val as CallEventType : 'NEW_ORDER';
  }
}

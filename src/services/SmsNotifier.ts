/**
 * SmsNotifier - 三竹 Mitake 簡訊推播服務
 *
 * 用於客人反向通知（司機接單、抵達、派單失敗），當客人無 LINE 時啟用。
 *
 * API 文件：https://sms.mitake.com.tw/spec/MitakeSMS_API_SmSendGet.pdf
 * Endpoint：https://smexpress.mitake.com.tw:9601/SmSendGet.asp
 *
 * 本服務為 PR1 基礎建設，尚未接入訂單流程；PR2 由 CustomerNotificationService 呼叫。
 */

export interface SmsSendResult {
  success: boolean;
  statusCode?: string;        // 三竹 statuscode（0/1/2/4 視為成功）
  messageId?: string;         // 三竹 msgid
  errorCode?: string;         // 失敗時的 statuscode 或內部錯誤碼
  errorMessage?: string;      // 完整錯誤訊息（遵守 CLAUDE.md 錯誤完整顯示規則）
  rawResponse?: string;       // 原始回應（debug 用）
}

/**
 * 三竹 statuscode 對照表
 * 參考：三竹官方 API 文件
 */
const MITAKE_STATUS_CODES: Record<string, { success: boolean; description: string }> = {
  '0': { success: true,  description: '已收取，待發送' },
  '1': { success: true,  description: '已送達行動電話' },
  '2': { success: true,  description: '已送達 SMSC（簡訊中心）' },
  '4': { success: true,  description: '已送達系統待發' },
  '5': { success: false, description: '內容有錯誤' },
  '6': { success: false, description: '門號有錯誤' },
  '7': { success: false, description: '系統暫停或故障' },
  '8': { success: false, description: '逾時' },
  'a': { success: false, description: '帳號錯誤' },
  'b': { success: false, description: '密碼錯誤' },
  'c': { success: false, description: '帳號已被停用' },
  'e': { success: false, description: '未設定發送 IP' },
  'h': { success: false, description: '超過可發送門號數限制' },
  'k': { success: false, description: '帳號已達到本月額度上限' },
  'm': { success: false, description: '必須變更密碼後才能使用' },
};

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 每支手機每小時的發送上限（防濫用 / 省錢）
 * in-memory 實作：PR1 夠用；多節點部署再升級到 Redis
 */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 3;

export class SmsNotifier {
  private readonly username: string;
  private readonly password: string;
  private readonly apiUrl: string;
  private readonly timeoutMs: number;

  /** phone → 發送時間戳陣列（for rate limiting） */
  private readonly sendHistory = new Map<string, number[]>();

  constructor(options?: {
    username?: string;
    password?: string;
    apiUrl?: string;
    timeoutMs?: number;
  }) {
    this.username = options?.username ?? process.env.MITAKE_SMS_USERNAME ?? '';
    this.password = options?.password ?? process.env.MITAKE_SMS_PASSWORD ?? '';
    this.apiUrl = options?.apiUrl ?? process.env.MITAKE_SMS_API_URL ?? '';
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!this.username || !this.password || !this.apiUrl) {
      throw new Error(
        'SmsNotifier 缺少必要環境變數：MITAKE_SMS_USERNAME / MITAKE_SMS_PASSWORD / MITAKE_SMS_API_URL'
      );
    }
  }

  /**
   * 發送簡訊
   * @param rawPhone 手機號（容許各種格式，內部會 normalize）
   * @param message 訊息內容（UTF-8，建議 ≤ 70 個中文字避免被拆兩則計費）
   */
  async send(rawPhone: string, message: string): Promise<SmsSendResult> {
    // Step 1: 手機號正規化
    const phone = this.normalizeTaiwanMobile(rawPhone);
    if (!phone) {
      return {
        success: false,
        errorCode: 'INVALID_PHONE',
        errorMessage: `無效的台灣手機號格式：${rawPhone}`,
      };
    }

    // Step 2: 訊息驗證
    if (!message || message.trim().length === 0) {
      return {
        success: false,
        errorCode: 'EMPTY_MESSAGE',
        errorMessage: '訊息內容不得為空',
      };
    }

    // Step 3: Rate limit 檢查
    if (!this.checkRateLimit(phone)) {
      return {
        success: false,
        errorCode: 'RATE_LIMITED',
        errorMessage: `手機 ${phone} 於 1 小時內已達 ${RATE_LIMIT_MAX} 則上限`,
      };
    }

    // Step 4: 組 URL
    const params = new URLSearchParams({
      username: this.username,
      password: this.password,
      dstaddr: phone,
      smbody: message,
      encoding: 'UTF8',
    });
    const url = `${this.apiUrl}?${params.toString()}`;

    // Step 5: 發送 HTTP 請求（含 timeout）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let rawText: string;
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      rawText = await res.text();

      if (!res.ok) {
        return {
          success: false,
          errorCode: `HTTP_${res.status}`,
          errorMessage: `三竹 API HTTP ${res.status}：${rawText}`,
          rawResponse: rawText,
        };
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return {
          success: false,
          errorCode: 'TIMEOUT',
          errorMessage: `三竹 API 請求逾時 (${this.timeoutMs}ms)`,
        };
      }
      return {
        success: false,
        errorCode: 'NETWORK_ERROR',
        errorMessage: `三竹 API 網路錯誤：${err?.message ?? String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }

    // Step 6: 解析回應
    const parsed = this.parseMitakeResponse(rawText);

    if (parsed.success) {
      this.recordSent(phone);
    }

    return { ...parsed, rawResponse: rawText };
  }

  /**
   * 解析三竹回應
   *
   * 三竹回應格式（純文字，非 JSON）：
   *   [0]
   *   msgid=1234567
   *   statuscode=1
   *   AccountPoint=9999
   *
   * 多筆發送時每筆之間以 [序號] 分隔。本服務單發，只解析第一筆。
   */
  private parseMitakeResponse(text: string): SmsSendResult {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const kv: Record<string, string> = {};
    for (const line of lines) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        kv[key] = val;
      }
    }

    const statuscode = kv['statuscode'];
    const msgid = kv['msgid'];

    if (!statuscode) {
      return {
        success: false,
        errorCode: 'PARSE_ERROR',
        errorMessage: `三竹回應無 statuscode 欄位：${text}`,
      };
    }

    const status = MITAKE_STATUS_CODES[statuscode];
    if (!status) {
      return {
        success: false,
        statusCode: statuscode,
        errorCode: statuscode,
        errorMessage: `未知的三竹 statuscode=${statuscode}`,
      };
    }

    if (status.success) {
      return {
        success: true,
        statusCode: statuscode,
        messageId: msgid,
      };
    }

    return {
      success: false,
      statusCode: statuscode,
      errorCode: statuscode,
      errorMessage: `三竹發送失敗 (statuscode=${statuscode})：${status.description}`,
    };
  }

  /**
   * 檢查 rate limit，若未超限回 true 且不會扣計數（扣計數在實際發送成功後）
   */
  private checkRateLimit(phone: string): boolean {
    const now = Date.now();
    const history = this.sendHistory.get(phone) ?? [];
    const valid = history.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
    this.sendHistory.set(phone, valid);
    return valid.length < RATE_LIMIT_MAX;
  }

  private recordSent(phone: string): void {
    const history = this.sendHistory.get(phone) ?? [];
    history.push(Date.now());
    this.sendHistory.set(phone, history);
  }

  /**
   * 台灣手機號正規化：將各種輸入格式統一為 09xxxxxxxx
   *
   * ★ 決策點 C — 由你決定要支援的格式範圍 ★
   *
   * 目前實作：僅接受嚴格的 09xxxxxxxx 或 +8869xxxxxxxx / 8869xxxxxxxx，
   *           以及允許 dash/空格分隔（會自動移除）。
   *
   * 可能的擴充方向（請依實際電話叫車客人輸入習慣調整）：
   *   - 是否接受全形數字？（長輩有時用全形輸入法）
   *   - 是否接受開頭 "+886 " 後有多個空格？
   *   - 是否接受省略前導 0 的 "9xxxxxxxx"？
   *   - 是否要偵測「0912-345-678 分機 123」這種帶分機的錯誤輸入？
   *
   * @returns 正規化後的 09xxxxxxxx；無法正規化時回 null
   */
  normalizeTaiwanMobile(input: string): string | null {
    if (!input) return null;

    // 移除所有空格、dash、括號
    const cleaned = input.replace(/[\s\-()]/g, '');

    // +886 或 886 前綴 → 補 0
    const withoutIntl = cleaned
      .replace(/^\+886/, '0')
      .replace(/^886/, '0');

    // 最終應為 09 開頭 + 8 位數字
    if (/^09\d{8}$/.test(withoutIntl)) {
      return withoutIntl;
    }

    return null;
  }
}

// ========== 單例管理（與 LineNotifier 風格一致） ==========

let smsNotifier: SmsNotifier | null = null;

export function initSmsNotifier(options?: ConstructorParameters<typeof SmsNotifier>[0]): void {
  smsNotifier = new SmsNotifier(options);
}

export function getSmsNotifier(): SmsNotifier | null {
  return smsNotifier;
}

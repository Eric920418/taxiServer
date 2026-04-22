/**
 * 統一驗證與格式化工具
 * 供 admin API / 未來司機 App 端 API 共用
 */

export type ValidateResult = {
    ok: boolean;
    normalized?: string;
    reason?: string;
};

/**
 * 驗證並 normalize 台灣手機號碼
 * 接受格式：
 *   09xxxxxxxx（10 碼）
 *   +8869xxxxxxxx（13 碼含國碼）
 *   0912-345-678 / 0912 345 678（允許連字號或空白）
 * 輸出統一格式：+8869xxxxxxxx（不含連字號 / 空白）
 */
export function validateTaiwanPhone(input: string | null | undefined): ValidateResult {
    if (!input || typeof input !== 'string') {
        return { ok: false, reason: '手機號碼不可為空' };
    }

    // 去除空白與連字號
    const cleaned = input.replace(/[\s-]/g, '');

    // 國際格式 +8869XXXXXXXX
    const intlMatch = cleaned.match(/^\+8869(\d{8})$/);
    if (intlMatch) {
        return { ok: true, normalized: `+8869${intlMatch[1]}` };
    }

    // 本地格式 09XXXXXXXX
    const localMatch = cleaned.match(/^09(\d{8})$/);
    if (localMatch) {
        return { ok: true, normalized: `+8869${localMatch[1]}` };
    }

    return { ok: false, reason: '手機號碼格式錯誤，應為 09xxxxxxxx 或 +8869xxxxxxxx' };
}

/**
 * 驗證並 normalize 台灣車牌號碼
 * 接受：
 *   ABC-1234 / ABC1234 / abc 1234
 *   1234-AB / 1234AB
 *   AB-1234 / AB1234
 *   8888-XX
 *   其他 3-4 碼 + 3-4 碼組合
 * 輸出統一格式：大寫、無空白、有連字號分隔
 */
export function validatePlate(input: string | null | undefined): ValidateResult {
    if (!input || typeof input !== 'string') {
        return { ok: false, reason: '車牌號碼不可為空' };
    }

    // 去空白與連字號，轉大寫
    const cleaned = input.replace(/[\s-]/g, '').toUpperCase();

    // 總長 4-8 碼、只允許 A-Z 0-9（台灣車牌包含老式純數字、新式英數混合）
    if (!/^[A-Z0-9]{4,8}$/.test(cleaned)) {
        return { ok: false, reason: '車牌號碼格式錯誤（只允許英數字，總長 4-8 碼）' };
    }

    // Normalize：依常見台灣車牌拆分規則
    // 注意 — 不同年份 / 車種有不同規則，以下覆蓋絕大多數情境：
    // - 4 碼：維持原樣（老式小車牌 "2328"）
    // - 5 碼：2-3 或 3-2（罕見）
    // - 6 碼：3-3（"ABC-123"）或老式 4-2（"1234-56"）
    // - 7 碼：字母開頭 3-4（"ABC-1234"）；數字開頭 4-3（"1234-ABC"）
    // - 8 碼：4-4（"ABCD-1234" 或 "1234-ABCD"）
    let normalized = cleaned;
    const len = cleaned.length;
    if (len === 7) {
        normalized = /^\d/.test(cleaned)
            ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
            : `${cleaned.slice(0, 3)}-${cleaned.slice(3)}`;
    } else if (len === 8) {
        normalized = `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
    } else if (len === 6) {
        normalized = `${cleaned.slice(0, 3)}-${cleaned.slice(3)}`;
    } else if (len === 5) {
        normalized = `${cleaned.slice(0, 2)}-${cleaned.slice(2)}`;
    }
    // len === 4 不加連字號（純數字或純字母老式車牌保留原貌）

    return { ok: true, normalized };
}

/**
 * 可接案件類型 enum
 * 司機端多選：能接哪些類別的訂單
 */
export const ORDER_TYPES = [
    'CASH', // 一般現金單
    'CREDIT_CARD', // 刷卡單
    'SENIOR_CARD', // 敬老卡
    'LOVE_CARD', // 愛心卡
    'WHEELCHAIR', // 輪椅單
    'PET', // 寵物單
    'LONG_DISTANCE', // 長途單
    'NIGHT', // 夜間單
] as const;
export type OrderType = typeof ORDER_TYPES[number];

/** 訂單類型中文顯示 */
export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
    CASH: '一般現金單',
    CREDIT_CARD: '刷卡單',
    SENIOR_CARD: '敬老卡',
    LOVE_CARD: '愛心卡',
    WHEELCHAIR: '輪椅單',
    PET: '寵物單',
    LONG_DISTANCE: '長途單',
    NIGHT: '夜間單',
};

/**
 * 可接受回饋金折減級距 enum（新台幣元）
 * 司機多選：能接受哪些價位級距的單
 */
export const REBATE_LEVELS = [0, 5, 10, 15, 20, 30] as const;
export type RebateLevel = typeof REBATE_LEVELS[number];

/** 帳號狀態（管理員設定，與 availability runtime 狀態分離） */
export const ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED', 'PENDING', 'ARCHIVED'] as const;
export type AccountStatus = typeof ACCOUNT_STATUSES[number];

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
    ACTIVE: '啟用',
    SUSPENDED: '停權',
    PENDING: '待審核',
    ARCHIVED: '封存',
};

/** 司機類型 */
export const DRIVER_TYPES = ['HIGH_VOLUME', 'REGULAR', 'PART_TIME', 'CONTRACT'] as const;
export type DriverType = typeof DRIVER_TYPES[number];

export const DRIVER_TYPE_LABELS: Record<DriverType, string> = {
    HIGH_VOLUME: '高量司機',
    REGULAR: '一般司機',
    PART_TIME: '兼職司機',
    CONTRACT: '合約司機',
};

/** 車色選項 */
export const CAR_COLORS = ['白', '黑', '銀', '灰', '紅', '藍', '綠', '黃', '橙', '紫', '棕', '其他'] as const;
export type CarColor = typeof CAR_COLORS[number];

/**
 * 驗證 array 內的值都落在允許 enum 內
 * 用於 acceptedOrderTypes / acceptedRebateLevels 的白名單檢查
 */
export function validateEnumArray<T extends readonly (string | number)[]>(
    values: unknown,
    allowed: T,
    fieldName: string
): { ok: boolean; reason?: string } {
    if (values === undefined || values === null) {
        return { ok: true };
    }
    if (!Array.isArray(values)) {
        return { ok: false, reason: `${fieldName} 必須是 array` };
    }
    const allowedSet = new Set(allowed);
    for (const v of values) {
        if (!allowedSet.has(v as any)) {
            return { ok: false, reason: `${fieldName} 含不允許的值：${v}` };
        }
    }
    return { ok: true };
}

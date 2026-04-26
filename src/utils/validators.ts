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
    'WHEELCHAIR', // 輪椅單（保留：固定/不分類型輪椅）
    'FOLDING_WHEELCHAIR', // 折疊輪椅單（2026-04 新增）
    'PET', // 寵物單（保留：不分籠廣義）
    'PET_CAGED', // 寵物有籠單（2026-04 新增）
    'PET_UNCAGED', // 寵物無籠單（2026-04 新增）
    'LONG_DISTANCE', // 長途單
    'SHORT_TRIP', // 短途單（2026-04 新增）
    'NIGHT', // 夜間單
    'BICYCLE', // 腳踏車單（2026-04 新增）
] as const;
export type OrderType = typeof ORDER_TYPES[number];

/** 訂單類型中文顯示 */
export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
    CASH: '一般現金單',
    CREDIT_CARD: '刷卡單',
    SENIOR_CARD: '敬老卡',
    LOVE_CARD: '愛心卡',
    WHEELCHAIR: '輪椅單',
    FOLDING_WHEELCHAIR: '折疊輪椅單',
    PET: '寵物單',
    PET_CAGED: '寵物有籠單',
    PET_UNCAGED: '寵物無籠單',
    LONG_DISTANCE: '長途單',
    SHORT_TRIP: '短途單',
    NIGHT: '夜間單',
    BICYCLE: '腳踏車單',
};

/**
 * 可接受回饋金折減級距 enum（新台幣元）
 * 司機多選：能接受哪些價位級距的單
 *
 * 2026-04 改版：5/15 移除，新增 40/50；0 元語意改為「外調車輛」（車隊忙線時可調的排班車）
 * 舊資料 5→10、15→20 由 migration 014 自動轉換
 */
export const REBATE_LEVELS = [0, 10, 20, 30, 40, 50] as const;
export type RebateLevel = typeof REBATE_LEVELS[number];

export const REBATE_LEVEL_LABELS: Record<number, string> = {
    0: '外調車輛（車隊忙線可調）',
    10: '10 元',
    20: '20 元',
    30: '30 元',
    40: '40 元',
    50: '50 元',
};

/** 帳號狀態（管理員設定，與 availability runtime 狀態分離） */
export const ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED', 'PENDING', 'ARCHIVED'] as const;
export type AccountStatus = typeof ACCOUNT_STATUSES[number];

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
    ACTIVE: '啟用',
    SUSPENDED: '停權',
    PENDING: '待審核',
    ARCHIVED: '封存',
};

/**
 * 司機類型
 *
 * 2026-04 改版：HIGH_VOLUME → FULL_TIME（全職）、CONTRACT → COOPERATIVE（合作）、新增 SPECIAL（特約）
 * 舊資料由 migration 014 自動轉換
 *
 * 業務語意：
 *   FULL_TIME    全職司機（核心派單對象）
 *   REGULAR      一般司機（彈性接單）
 *   PART_TIME    兼職司機
 *   COOPERATIVE  合作司機（外部車行合作）
 *   SPECIAL      特約司機（可接預約單，需設班次）
 */
export const DRIVER_TYPES = ['FULL_TIME', 'REGULAR', 'PART_TIME', 'COOPERATIVE', 'SPECIAL'] as const;
export type DriverType = typeof DRIVER_TYPES[number];

export const DRIVER_TYPE_LABELS: Record<DriverType, string> = {
    FULL_TIME: '全職司機',
    REGULAR: '一般司機',
    PART_TIME: '兼職司機',
    COOPERATIVE: '合作司機',
    SPECIAL: '特約司機',
};

/**
 * 車型乘客容量（司機端設、乘客端可指定偏好）
 * 2026-04 新增
 */
export const VEHICLE_CAPACITIES = [
    'CAPACITY_4',          // 四人內
    'CAPACITY_5',          // 五人內
    'CAPACITY_6',          // 六人
    'CAPACITY_8',          // 八人
    'WHEELCHAIR_VEHICLE',  // 無障礙
] as const;
export type VehicleCapacity = typeof VEHICLE_CAPACITIES[number];

export const VEHICLE_CAPACITY_LABELS: Record<VehicleCapacity, string> = {
    CAPACITY_4: '四人內',
    CAPACITY_5: '五人內',
    CAPACITY_6: '六人',
    CAPACITY_8: '八人',
    WHEELCHAIR_VEHICLE: '無障礙',
};

/**
 * 司機班次（2026-04 新增）
 * 所有司機均可設定，但派單篩選時僅 SPECIAL 司機強制檢查
 */
export const SHIFT_TYPES = ['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT'] as const;
export type ShiftType = typeof SHIFT_TYPES[number];

export const SHIFT_TYPE_LABELS: Record<ShiftType, string> = {
    MORNING: '早班',
    AFTERNOON: '中班',
    EVENING: '晚班',
    NIGHT: '夜班',
};

/**
 * 班次配置 — 存於 drivers.shifts JSONB 欄位的單一 element 結構
 */
export interface ShiftSlot {
    shift_type: ShiftType;
    start: string; // HH:MM
    end: string;   // HH:MM
    is_active: boolean;
}

/**
 * 驗證 shifts JSONB 結構：必須是 array 且每個 element 結構正確
 */
export function validateShifts(shifts: unknown): { ok: true; value: ShiftSlot[] } | { ok: false; error: string } {
    if (shifts === null || shifts === undefined) return { ok: true, value: [] };
    if (!Array.isArray(shifts)) return { ok: false, error: 'shifts 必須為陣列' };

    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (const [i, s] of shifts.entries()) {
        if (typeof s !== 'object' || s === null) {
            return { ok: false, error: `shifts[${i}] 必須為物件` };
        }
        const slot = s as Partial<ShiftSlot>;
        if (!slot.shift_type || !(SHIFT_TYPES as readonly string[]).includes(slot.shift_type)) {
            return { ok: false, error: `shifts[${i}].shift_type 不在允許範圍：${SHIFT_TYPES.join(', ')}` };
        }
        if (typeof slot.start !== 'string' || !timeRegex.test(slot.start)) {
            return { ok: false, error: `shifts[${i}].start 格式必須為 HH:MM` };
        }
        if (typeof slot.end !== 'string' || !timeRegex.test(slot.end)) {
            return { ok: false, error: `shifts[${i}].end 格式必須為 HH:MM` };
        }
        if (typeof slot.is_active !== 'boolean') {
            return { ok: false, error: `shifts[${i}].is_active 必須為布林` };
        }
    }
    return { ok: true, value: shifts as ShiftSlot[] };
}

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

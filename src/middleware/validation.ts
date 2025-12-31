/**
 * 請求驗證中間件
 * 提供強大的輸入驗證和清理功能
 */

import { Request, Response, NextFunction } from 'express';
import { body, param, query, validationResult, ValidationChain } from 'express-validator';
import Joi from 'joi';
import logger from '../services/logger';

// ============================================
// 通用驗證器
// ============================================

/**
 * 處理驗證錯誤
 */
export const handleValidationErrors = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(error => ({
      field: error.type === 'field' ? (error as any).path : 'unknown',
      message: error.msg,
      value: (error as any).value
    }));

    logger.warn('Validation failed', {
      path: req.path,
      errors: errorMessages
    });

    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: '請求參數驗證失敗',
      details: errorMessages
    });
  }

  next();
};

// ============================================
// 司機相關驗證
// ============================================

export const driverValidation = {
  // 司機登入驗證
  login: [
    body('phone')
      .isMobilePhone('zh-TW')
      .withMessage('無效的手機號碼格式'),
    body('firebaseUid')
      .isString()
      .isLength({ min: 10, max: 128 })
      .withMessage('無效的 Firebase UID'),
    handleValidationErrors
  ],

  // 位置更新驗證
  updateLocation: [
    param('driverId')
      .isAlphanumeric()
      .isLength({ min: 3, max: 20 })
      .withMessage('無效的司機 ID'),
    body('lat')
      .isFloat({ min: -90, max: 90 })
      .withMessage('緯度必須在 -90 到 90 之間'),
    body('lng')
      .isFloat({ min: -180, max: 180 })
      .withMessage('經度必須在 -180 到 180 之間'),
    body('speed')
      .optional()
      .isFloat({ min: 0, max: 200 })
      .withMessage('速度必須在 0 到 200 km/h 之間'),
    body('bearing')
      .optional()
      .isFloat({ min: 0, max: 360 })
      .withMessage('方向必須在 0 到 360 度之間'),
    handleValidationErrors
  ],

  // 狀態更新驗證
  updateStatus: [
    param('driverId')
      .isAlphanumeric()
      .isLength({ min: 3, max: 20 }),
    body('availability')
      .isIn(['OFFLINE', 'REST', 'AVAILABLE', 'ON_TRIP'])
      .withMessage('無效的狀態值'),
    handleValidationErrors
  ]
};

// ============================================
// 訂單相關驗證
// ============================================

export const orderValidation = {
  // 創建訂單驗證
  create: [
    body('pickupLat')
      .isFloat({ min: -90, max: 90 })
      .withMessage('上車點緯度無效'),
    body('pickupLng')
      .isFloat({ min: -180, max: 180 })
      .withMessage('上車點經度無效'),
    body('pickupAddress')
      .isString()
      .isLength({ min: 1, max: 200 })
      .trim()
      .escape()
      .withMessage('上車地址無效'),
    body('destLat')
      .optional()
      .isFloat({ min: -90, max: 90 })
      .withMessage('目的地緯度無效'),
    body('destLng')
      .optional()
      .isFloat({ min: -180, max: 180 })
      .withMessage('目的地經度無效'),
    body('destAddress')
      .optional()
      .isString()
      .isLength({ max: 200 })
      .trim()
      .escape()
      .withMessage('目的地地址無效'),
    body('paymentType')
      .isIn(['CASH', 'CARD', 'MOBILE'])
      .withMessage('無效的付款方式'),
    body('passengerName')
      .optional()
      .isString()
      .isLength({ min: 1, max: 50 })
      .trim()
      .escape(),
    body('passengerPhone')
      .optional()
      .isMobilePhone('zh-TW')
      .withMessage('乘客電話格式無效'),
    handleValidationErrors
  ],

  // 接受訂單驗證
  accept: [
    param('orderId')
      .matches(/^ORD\d+$/)
      .withMessage('無效的訂單 ID 格式'),
    body('driverId')
      .isAlphanumeric()
      .isLength({ min: 3, max: 20 })
      .withMessage('無效的司機 ID'),
    handleValidationErrors
  ],

  // 完成訂單驗證
  complete: [
    param('orderId')
      .matches(/^ORD\d+$/)
      .withMessage('無效的訂單 ID 格式'),
    body('actualDistance')
      .isFloat({ min: 0, max: 500 })
      .withMessage('實際距離必須在 0 到 500 公里之間'),
    body('actualDuration')
      .isInt({ min: 1, max: 600 })
      .withMessage('實際時間必須在 1 到 600 分鐘之間'),
    body('totalAmount')
      .isFloat({ min: 0, max: 10000 })
      .withMessage('金額必須在 0 到 10000 之間'),
    body('rating')
      .optional()
      .isInt({ min: 1, max: 5 })
      .withMessage('評分必須在 1 到 5 之間'),
    handleValidationErrors
  ],

  // 查詢訂單驗證
  query: [
    query('status')
      .optional()
      .isIn(['OFFERED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'TIMEOUT'])
      .withMessage('無效的訂單狀態'),
    query('driverId')
      .optional()
      .isAlphanumeric(),
    query('passengerId')
      .optional()
      .isAlphanumeric(),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('限制數量必須在 1 到 100 之間'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('偏移量必須大於等於 0'),
    handleValidationErrors
  ]
};

// ============================================
// 乘客相關驗證
// ============================================

export const passengerValidation = {
  // 乘客註冊/登入驗證
  register: [
    body('phone')
      .isMobilePhone('zh-TW')
      .withMessage('無效的手機號碼格式'),
    body('firebaseUid')
      .isString()
      .isLength({ min: 10, max: 128 })
      .withMessage('無效的 Firebase UID'),
    body('name')
      .optional()
      .isString()
      .isLength({ min: 1, max: 50 })
      .trim()
      .escape()
      .withMessage('姓名格式無效'),
    handleValidationErrors
  ],

  // 查詢附近司機驗證
  getNearbyDrivers: [
    query('lat')
      .isFloat({ min: -90, max: 90 })
      .withMessage('緯度必須在 -90 到 90 之間'),
    query('lng')
      .isFloat({ min: -180, max: 180 })
      .withMessage('經度必須在 -180 到 180 之間'),
    query('radius')
      .optional()
      .isFloat({ min: 0.1, max: 50 })
      .withMessage('半徑必須在 0.1 到 50 公里之間'),
    handleValidationErrors
  ]
};

// ============================================
// 管理員相關驗證
// ============================================

export const adminValidation = {
  // 管理員登入驗證
  login: [
    body('username')
      .isAlphanumeric()
      .isLength({ min: 3, max: 20 })
      .withMessage('用戶名格式無效'),
    body('password')
      .isLength({ min: 6, max: 100 })
      .withMessage('密碼長度必須在 6 到 100 之間'),
    handleValidationErrors
  ],

  // 創建管理員驗證
  create: [
    body('username')
      .isAlphanumeric()
      .isLength({ min: 3, max: 20 })
      .withMessage('用戶名格式無效'),
    body('email')
      .isEmail()
      .normalizeEmail()
      .withMessage('郵箱格式無效'),
    body('password')
      .isLength({ min: 8 })
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .withMessage('密碼必須包含大小寫字母和數字'),
    body('role')
      .isIn(['super_admin', 'admin', 'operator'])
      .withMessage('無效的角色'),
    handleValidationErrors
  ]
};

// ============================================
// Joi Schema 驗證（用於複雜對象）
// ============================================

export const joiSchemas = {
  // 派單請求 Schema
  dispatchRequest: Joi.object({
    orderId: Joi.string().pattern(/^ORD\d+$/).required(),
    pickupLat: Joi.number().min(-90).max(90).required(),
    pickupLng: Joi.number().min(-180).max(180).required(),
    destLat: Joi.number().min(-90).max(90).required(),
    destLng: Joi.number().min(-180).max(180).required(),
    passengerId: Joi.string().alphanum().min(3).max(20).optional(),
    priority: Joi.string().valid('normal', 'high', 'urgent').default('normal'),
    requirements: Joi.object({
      vehicleType: Joi.string().valid('sedan', 'suv', 'van').optional(),
      features: Joi.array().items(
        Joi.string().valid('child_seat', 'wheelchair', 'pet_friendly')
      ).optional()
    }).optional()
  }),

  // 統計查詢 Schema
  statsQuery: Joi.object({
    startDate: Joi.date().iso().required(),
    endDate: Joi.date().iso().greater(Joi.ref('startDate')).required(),
    groupBy: Joi.string().valid('hour', 'day', 'week', 'month').default('day'),
    metrics: Joi.array().items(
      Joi.string().valid('revenue', 'orders', 'distance', 'duration', 'drivers')
    ).min(1).required(),
    filters: Joi.object({
      driverId: Joi.string().alphanum().optional(),
      status: Joi.string().valid('COMPLETED', 'CANCELLED').optional(),
      minAmount: Joi.number().min(0).optional(),
      maxAmount: Joi.number().greater(Joi.ref('minAmount')).optional()
    }).optional()
  }),

  // 批次操作 Schema
  batchOperation: Joi.object({
    operation: Joi.string().valid('update', 'delete').required(),
    table: Joi.string().valid('orders', 'drivers', 'passengers').required(),
    ids: Joi.array().items(Joi.string()).min(1).max(100).required(),
    data: Joi.object().when('operation', {
      is: 'update',
      then: Joi.required(),
      otherwise: Joi.optional()
    })
  })
};

/**
 * Joi 驗證中間件
 */
export const validateJoi = (schema: Joi.Schema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));

      logger.warn('Joi validation failed', {
        path: req.path,
        errors
      });

      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: '請求參數驗證失敗',
        details: errors
      });
    }

    // 替換請求體為清理後的值
    req.body = value;
    next();
  };
};

// ============================================
// 自定義驗證器
// ============================================

/**
 * 驗證台灣車牌號碼
 */
export const validateTaiwanPlate = (value: string): boolean => {
  const plateRegex = /^[A-Z]{2,3}-\d{3,4}$/;
  return plateRegex.test(value);
};

/**
 * 驗證座標是否在花蓮範圍內
 */
export const validateHualienCoordinates = (lat: number, lng: number): boolean => {
  // 花蓮縣大致範圍
  return lat >= 23.5 && lat <= 24.4 && lng >= 121.3 && lng <= 121.8;
};

/**
 * 清理和轉換手機號碼格式
 */
export const sanitizePhoneNumber = (phone: string): string => {
  // 移除所有非數字字符
  let cleaned = phone.replace(/\D/g, '');

  // 處理台灣手機號碼格式
  if (cleaned.startsWith('886')) {
    cleaned = '0' + cleaned.substring(3);
  }

  // 確保以 0 開頭
  if (!cleaned.startsWith('0')) {
    cleaned = '0' + cleaned;
  }

  return cleaned;
};

// ============================================
// 複合驗證器
// ============================================

/**
 * 時間範圍驗證
 */
export const validateTimeRange = [
  query('startTime')
    .optional()
    .isISO8601()
    .withMessage('開始時間格式無效'),
  query('endTime')
    .optional()
    .isISO8601()
    .custom((value, { req }) => {
      if (req.query?.startTime && value) {
        return new Date(value) > new Date(req.query.startTime);
      }
      return true;
    })
    .withMessage('結束時間必須晚於開始時間'),
  handleValidationErrors
];

/**
 * 分頁參數驗證
 */
export const validatePagination = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('頁碼必須大於 0'),
  query('pageSize')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('每頁數量必須在 1 到 100 之間'),
  query('sortBy')
    .optional()
    .isIn(['created_at', 'updated_at', 'amount', 'distance', 'rating'])
    .withMessage('無效的排序欄位'),
  query('sortOrder')
    .optional()
    .isIn(['ASC', 'DESC'])
    .withMessage('排序順序必須是 ASC 或 DESC'),
  handleValidationErrors
];

export default {
  handleValidationErrors,
  driverValidation,
  orderValidation,
  passengerValidation,
  adminValidation,
  joiSchemas,
  validateJoi,
  validateTaiwanPlate,
  validateHualienCoordinates,
  sanitizePhoneNumber,
  validateTimeRange,
  validatePagination
};
/**
 * Whisper API 路由
 * 處理語音轉錄和意圖解析
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getWhisperService, DriverContext, PassengerContext } from '../services/WhisperService';

const router = Router();

// 配置 multer 用於處理音檔上傳
const uploadDir = path.join(__dirname, '../../uploads/audio');

// 確保上傳目錄存在
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || '.m4a';
    cb(null, `audio-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 最大 10MB
  },
  fileFilter: (req, file, cb) => {
    // 允許的音檔格式
    const allowedMimes = [
      'audio/mpeg',
      'audio/mp4',
      'audio/m4a',
      'audio/x-m4a',
      'audio/wav',
      'audio/webm',
      'audio/ogg',
      'audio/aac',
      'audio/3gpp',
      'application/octet-stream' // Android 有時會用這個
    ];

    if (allowedMimes.includes(file.mimetype) || file.originalname.match(/\.(mp3|m4a|wav|webm|ogg|aac|3gp)$/i)) {
      cb(null, true);
    } else {
      cb(new Error(`不支援的音檔格式: ${file.mimetype}`));
    }
  }
});

/**
 * POST /api/whisper/transcribe
 * 語音轉錄 + 意圖解析
 *
 * Request:
 * - multipart/form-data
 * - audio: 音檔 (必填)
 * - driverId: 司機ID (必填)
 * - currentStatus: 當前狀態 (必填)
 * - currentOrderId: 當前訂單ID (選填)
 * - currentOrderStatus: 當前訂單狀態 (選填)
 * - pickupAddress: 上車點地址 (選填)
 * - destinationAddress: 目的地地址 (選填)
 *
 * Response:
 * {
 *   success: boolean,
 *   command?: {
 *     action: string,
 *     params: object,
 *     confidence: number,
 *     rawText: string,
 *     transcription: string
 *   },
 *   error?: string,
 *   processingTimeMs?: number
 * }
 */
router.post('/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
  const startTime = Date.now();
  let audioFilePath: string | null = null;

  try {
    // 檢查音檔
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: '請上傳音檔'
      });
    }

    audioFilePath = req.file.path;
    console.log(`[Whisper API] 收到音檔: ${req.file.originalname} (${req.file.size} bytes)`);

    // 解析請求參數
    const {
      driverId,
      currentStatus,
      currentOrderId,
      currentOrderStatus,
      pickupAddress,
      destinationAddress
    } = req.body;

    // 驗證必填參數
    if (!driverId) {
      return res.status(400).json({
        success: false,
        error: '缺少 driverId 參數'
      });
    }

    if (!currentStatus) {
      return res.status(400).json({
        success: false,
        error: '缺少 currentStatus 參數'
      });
    }

    // 構建上下文
    const context: DriverContext = {
      driverId,
      currentStatus,
      currentOrderId,
      currentOrderStatus,
      pickupAddress,
      destinationAddress
    };

    console.log(`[Whisper API] 司機: ${driverId}, 狀態: ${currentStatus}`);

    // 呼叫 WhisperService
    const whisperService = getWhisperService();

    if (!whisperService.isAvailable()) {
      return res.status(503).json({
        success: false,
        error: '語音服務暫時不可用，請稍後再試'
      });
    }

    const result = await whisperService.transcribeAndParse(audioFilePath, context);

    // 回傳結果
    res.json({
      ...result,
      processingTimeMs: Date.now() - startTime
    });

  } catch (error: any) {
    console.error('[Whisper API] 錯誤:', error);

    res.status(500).json({
      success: false,
      error: error.message || '處理語音時發生錯誤',
      processingTimeMs: Date.now() - startTime
    });

  } finally {
    // 清理臨時音檔
    if (audioFilePath && fs.existsSync(audioFilePath)) {
      try {
        fs.unlinkSync(audioFilePath);
        console.log(`[Whisper API] 已刪除臨時音檔: ${audioFilePath}`);
      } catch (e) {
        console.warn(`[Whisper API] 無法刪除臨時音檔: ${audioFilePath}`);
      }
    }
  }
});

/**
 * GET /api/whisper/usage
 * 查詢用量統計
 */
router.get('/usage', (req: Request, res: Response) => {
  try {
    const whisperService = getWhisperService();
    const stats = whisperService.getUsageStats();

    res.json({
      success: true,
      usage: stats,
      limits: {
        dailyMinutes: parseInt(process.env.WHISPER_DAILY_LIMIT_MINUTES || '60'),
        monthlyBudgetUSD: parseInt(process.env.WHISPER_MONTHLY_BUDGET_USD || '50')
      }
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/whisper/health
 * 健康檢查
 */
router.get('/health', (req: Request, res: Response) => {
  try {
    const whisperService = getWhisperService();
    const isAvailable = whisperService.isAvailable();

    res.json({
      success: true,
      available: isAvailable,
      message: isAvailable ? '語音服務正常運作' : '語音服務未初始化（缺少 OPENAI_API_KEY）'
    });
  } catch (error: any) {
    res.json({
      success: false,
      available: false,
      message: '語音服務未初始化'
    });
  }
});

/**
 * POST /api/whisper/transcribe-passenger
 * 乘客端語音轉錄 + 意圖解析
 *
 * Request:
 * - multipart/form-data
 * - audio: 音檔 (必填)
 * - passengerId: 乘客ID (必填)
 * - hasActiveOrder: 是否有進行中訂單 (必填, "true"/"false")
 * - orderStatus: 訂單狀態 (選填)
 * - currentPickupAddress: 上車點地址 (選填)
 * - currentDestinationAddress: 目的地地址 (選填)
 * - driverName: 司機姓名 (選填)
 * - driverPhone: 司機電話 (選填)
 *
 * Response:
 * {
 *   success: boolean,
 *   command?: {
 *     action: string,
 *     params: object,
 *     confidence: number,
 *     rawText: string,
 *     transcription: string
 *   },
 *   error?: string,
 *   processingTimeMs?: number
 * }
 */
router.post('/transcribe-passenger', upload.single('audio'), async (req: Request, res: Response) => {
  const startTime = Date.now();
  let audioFilePath: string | null = null;

  try {
    // 檢查音檔
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: '請上傳音檔'
      });
    }

    audioFilePath = req.file.path;
    console.log(`[Whisper API] 收到乘客音檔: ${req.file.originalname} (${req.file.size} bytes)`);

    // 解析請求參數
    const {
      passengerId,
      hasActiveOrder,
      orderStatus,
      currentPickupAddress,
      currentDestinationAddress,
      driverName,
      driverPhone
    } = req.body;

    // 驗證必填參數
    if (!passengerId) {
      return res.status(400).json({
        success: false,
        error: '缺少 passengerId 參數'
      });
    }

    // 構建上下文
    const context: PassengerContext = {
      passengerId,
      hasActiveOrder: hasActiveOrder === 'true' || hasActiveOrder === true,
      orderStatus,
      currentPickupAddress,
      currentDestinationAddress,
      driverName,
      driverPhone
    };

    console.log(`[Whisper API] 乘客: ${passengerId}, 有訂單: ${context.hasActiveOrder}`);

    // 呼叫 WhisperService
    const whisperService = getWhisperService();

    if (!whisperService.isAvailable()) {
      return res.status(503).json({
        success: false,
        error: '語音服務暫時不可用，請稍後再試'
      });
    }

    const result = await whisperService.transcribeAndParsePassenger(audioFilePath, context);

    // 回傳結果
    res.json({
      ...result,
      processingTimeMs: Date.now() - startTime
    });

  } catch (error: any) {
    console.error('[Whisper API] 乘客端錯誤:', error);

    res.status(500).json({
      success: false,
      error: error.message || '處理語音時發生錯誤',
      processingTimeMs: Date.now() - startTime
    });

  } finally {
    // 清理臨時音檔
    if (audioFilePath && fs.existsSync(audioFilePath)) {
      try {
        fs.unlinkSync(audioFilePath);
        console.log(`[Whisper API] 已刪除乘客臨時音檔: ${audioFilePath}`);
      } catch (e) {
        console.warn(`[Whisper API] 無法刪除乘客臨時音檔: ${audioFilePath}`);
      }
    }
  }
});

/**
 * POST /api/whisper/test-passenger
 * 測試乘客端意圖解析（不需要音檔，直接輸入文字）
 * 僅供開發測試使用
 */
router.post('/test-passenger', async (req: Request, res: Response) => {
  try {
    const { text, passengerId, hasActiveOrder, orderStatus, driverName } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        error: '缺少 text 參數'
      });
    }

    const context: PassengerContext = {
      passengerId: passengerId || 'TEST_PASSENGER',
      hasActiveOrder: hasActiveOrder === 'true' || hasActiveOrder === true || false,
      orderStatus,
      driverName
    };

    // 直接呼叫 GPT 解析意圖（跳過 Whisper）
    const whisperService = getWhisperService();

    if (!whisperService.isAvailable()) {
      return res.status(503).json({
        success: false,
        error: '語音服務暫時不可用'
      });
    }

    // 使用反射呼叫私有方法（僅測試用）
    const parsePassengerIntent = (whisperService as any).parsePassengerIntent.bind(whisperService);
    const command = await parsePassengerIntent(text, context);

    res.json({
      success: true,
      command,
      note: '這是乘客端測試端點，直接解析文字意圖，不經過語音轉錄'
    });

  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/whisper/test
 * 測試意圖解析（不需要音檔，直接輸入文字）
 * 僅供開發測試使用
 */
router.post('/test', async (req: Request, res: Response) => {
  try {
    const { text, driverId, currentStatus, currentOrderId, currentOrderStatus } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        error: '缺少 text 參數'
      });
    }

    const context: DriverContext = {
      driverId: driverId || 'TEST001',
      currentStatus: currentStatus || 'AVAILABLE',
      currentOrderId,
      currentOrderStatus
    };

    // 直接呼叫 GPT 解析意圖（跳過 Whisper）
    const whisperService = getWhisperService();

    if (!whisperService.isAvailable()) {
      return res.status(503).json({
        success: false,
        error: '語音服務暫時不可用'
      });
    }

    // 使用反射呼叫私有方法（僅測試用）
    const parseIntent = (whisperService as any).parseIntent.bind(whisperService);
    const command = await parseIntent(text, context);

    res.json({
      success: true,
      command,
      note: '這是測試端點，直接解析文字意圖，不經過語音轉錄'
    });

  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;

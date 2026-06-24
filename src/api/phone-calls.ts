/**
 * phone-calls.ts - 電話叫車 Webhook 路由 + Operator 審核 API
 *
 * 接收 3CX CallCompleted webhook，管理電話處理管線
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { query, queryOne, queryMany } from '../db/connection';
import { getPhoneCallProcessor } from '../services/PhoneCallProcessor';
import { authenticateAdmin } from './admin';

// 跟 PhoneCallProcessor.recordingsBasePath 同步（Asterisk 預設）
const RECORDINGS_BASE_PATH = process.env.RECORDINGS_PATH || '/var/spool/asterisk/recording';

const router = Router();

// 擴展 Request 以包含 admin 資訊
interface AuthenticatedRequest extends Request {
  admin?: {
    admin_id: string;
    username: string;
    role: string;
    email: string;
  };
}

/**
 * 3CX Webhook - 接收通話完成事件
 * POST /api/phone-calls/webhook
 *
 * 3CX 會在通話結束後推送此事件
 */
router.post('/webhook', async (req, res) => {
  try {
    const {
      call_id,
      callId,        // 支援兩種命名風格
      caller_number,
      callerNumber,
      duration,
      duration_seconds,
      recording_url,
      recordingUrl,
      recording_path,
      event_type,
    } = req.body;

    const finalCallId = call_id || callId || `3CX_${Date.now()}`;
    const finalCallerNumber = caller_number || callerNumber || 'unknown';
    const finalDuration = duration_seconds || duration || 0;
    const finalRecordingUrl = recording_url || recordingUrl || recording_path || '';

    console.log(`[PhoneCalls Webhook] 收到通話完成事件`);
    console.log(`  通話ID: ${finalCallId}`);
    console.log(`  來電號碼: ${finalCallerNumber}`);
    console.log(`  通話時長: ${finalDuration}秒`);
    console.log(`  錄音路徑: ${finalRecordingUrl}`);

    // 過濾太短的通話（< 3 秒可能是誤撥）
    if (finalDuration < 5) {
      console.log(`[PhoneCalls Webhook] 通話太短(${finalDuration}秒)，忽略`);
      return res.json({ success: true, message: '通話太短，已忽略' });
    }

    // 寫入 phone_calls 表
    await query(`
      INSERT INTO phone_calls (call_id, caller_number, duration_seconds, recording_url, processing_status)
      VALUES ($1, $2, $3, $4, 'RECEIVED')
      ON CONFLICT (call_id) DO NOTHING
    `, [finalCallId, finalCallerNumber, finalDuration, finalRecordingUrl]);

    // 立即回應 200（避免 3CX webhook 超時）
    res.json({
      success: true,
      callId: finalCallId,
      message: '已接收，開始處理'
    });

    // 非同步啟動處理管線
    setImmediate(async () => {
      try {
        const processor = getPhoneCallProcessor();
        await processor.processCall(finalCallId);
      } catch (error) {
        console.error(`[PhoneCalls Webhook] 非同步處理失敗:`, error);
      }
    });

  } catch (error) {
    console.error('[PhoneCalls Webhook] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 即時 AI 語音客服建單 — bridge 在 OpenAI function call 時呼叫
 * POST /api/phone-calls/realtime-order
 * body: { call_id, customer_phone, pickup_address, destination_address?, special_notes? }
 * 回: { ok, orderId? } 或 { ok:false, forbiddenPickup? }（讓 AI 即時回覆客人）
 */
router.post('/realtime-order', async (req, res) => {
  try {
    const secret = process.env.BRIDGE_SECRET || '';
    if (secret && req.headers['x-bridge-secret'] !== secret) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const { call_id, customer_phone, pickup_address, destination_address, special_notes } = req.body || {};
    if (!pickup_address) {
      return res.status(400).json({ ok: false, error: 'pickup_address required' });
    }
    console.log(`[Realtime-Order] caller=${customer_phone} pickup=${pickup_address} dest=${destination_address}`);
    const processor = getPhoneCallProcessor();
    const result = await processor.dispatchRealtimeOrder({
      callId: call_id || `RT_${Date.now()}`,
      customerPhone: customer_phone || 'unknown',
      pickup_address,
      destination_address: destination_address || null,
      special_notes: special_notes || null,
    });
    res.json(result);
  } catch (error: any) {
    console.error('[Realtime-Order] 錯誤:', error);
    res.status(500).json({ ok: false, error: error?.message || 'INTERNAL_ERROR' });
  }
});

// ========== Operator 審核 API（需驗證，放在 /:callId 之前）==========

/**
 * 取得待審核電話列表
 * GET /api/phone-calls/needs-review
 */
router.get('/needs-review', authenticateAdmin as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const calls = await queryMany(
      `SELECT * FROM phone_calls
       WHERE processing_status = 'NEEDS_REVIEW'
       ORDER BY created_at ASC`,
      []
    );

    res.json({
      success: true,
      calls: calls.map(c => ({
        callId: c.call_id,
        callerNumber: c.caller_number,
        durationSeconds: c.duration_seconds,
        recordingUrl: c.recording_url,
        processingStatus: c.processing_status,
        transcript: c.transcript,
        parsedFields: c.parsed_fields,
        orderId: c.order_id,
        eventType: c.event_type,
        eventConfidence: c.event_confidence ? parseFloat(c.event_confidence) : null,
        fieldConfidence: c.field_confidence ? parseFloat(c.field_confidence) : null,
        relatedCallId: c.related_call_id,
        errorMessage: c.error_message,
        retryCount: c.retry_count,
        reviewedBy: c.reviewed_by,
        reviewAction: c.review_action,
        editedFields: c.edited_fields,
        createdAt: c.created_at,
        updatedAt: c.updated_at
      })),
      total: calls.length
    });
  } catch (error) {
    console.error('[PhoneCalls NeedsReview] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 取得待審核數量
 * GET /api/phone-calls/needs-review/count
 */
router.get('/needs-review/count', authenticateAdmin as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await queryOne(
      `SELECT COUNT(*) as count FROM phone_calls WHERE processing_status = 'NEEDS_REVIEW'`,
      []
    );
    res.json({ success: true, count: parseInt(result?.count || '0') });
  } catch (error) {
    console.error('[PhoneCalls NeedsReviewCount] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 列出電話記錄
 * GET /api/phone-calls
 */
router.get('/', async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;

  try {
    let sql = 'SELECT * FROM phone_calls WHERE 1=1';
    const params: any[] = [];

    if (status) {
      params.push(status);
      sql += ` AND processing_status = $${params.length}`;
    }

    params.push(limit, offset);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const calls = await queryMany(sql, params);

    res.json({
      calls: calls.map(c => ({
        callId: c.call_id,
        callerNumber: c.caller_number,
        durationSeconds: c.duration_seconds,
        recordingUrl: c.recording_url,
        processingStatus: c.processing_status,
        transcript: c.transcript,
        parsedFields: c.parsed_fields,
        orderId: c.order_id,
        eventType: c.event_type,
        eventConfidence: c.event_confidence ? parseFloat(c.event_confidence) : null,
        fieldConfidence: c.field_confidence ? parseFloat(c.field_confidence) : null,
        errorMessage: c.error_message,
        retryCount: c.retry_count,
        createdAt: c.created_at,
        updatedAt: c.updated_at
      })),
      total: calls.length
    });
  } catch (error) {
    console.error('[PhoneCalls GET] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 查看單一電話記錄
 * GET /api/phone-calls/:callId
 */
router.get('/:callId', async (req, res) => {
  const { callId } = req.params;

  try {
    const call = await queryOne(
      'SELECT * FROM phone_calls WHERE call_id = $1',
      [callId]
    );

    if (!call) {
      return res.status(404).json({ error: '電話記錄不存在' });
    }

    res.json({
      callId: call.call_id,
      callerNumber: call.caller_number,
      durationSeconds: call.duration_seconds,
      recordingUrl: call.recording_url,
      processingStatus: call.processing_status,
      transcript: call.transcript,
      parsedFields: call.parsed_fields,
      orderId: call.order_id,
      eventType: call.event_type,
      eventConfidence: call.event_confidence ? parseFloat(call.event_confidence) : null,
      fieldConfidence: call.field_confidence ? parseFloat(call.field_confidence) : null,
      relatedCallId: call.related_call_id,
      errorMessage: call.error_message,
      retryCount: call.retry_count,
      reviewedBy: call.reviewed_by,
      reviewedAt: call.reviewed_at,
      reviewAction: call.review_action,
      reviewNote: call.review_note,
      editedFields: call.edited_fields,
      createdAt: call.created_at,
      updatedAt: call.updated_at
    });
  } catch (error) {
    console.error('[PhoneCalls GET/:id] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * Operator 審核電話
 * POST /api/phone-calls/:callId/review
 */
router.post('/:callId/review', authenticateAdmin as any, async (req: AuthenticatedRequest, res: Response) => {
  const { callId } = req.params;
  const { action, editedFields, note } = req.body;

  try {
    // 驗證 action
    if (!action || !['APPROVED', 'REJECTED'].includes(action)) {
      return res.status(400).json({ error: 'action 必須為 APPROVED 或 REJECTED' });
    }

    // 原子性更新：只更新 NEEDS_REVIEW 狀態的記錄（防競態）
    const result = await query(
      `UPDATE phone_calls SET
        processing_status = $1,
        review_action = $1,
        reviewed_by = $2,
        reviewed_at = CURRENT_TIMESTAMP,
        review_note = $3,
        edited_fields = $4,
        updated_at = CURRENT_TIMESTAMP
       WHERE call_id = $5 AND processing_status = 'NEEDS_REVIEW'
       RETURNING call_id`,
      [
        action,
        req.admin?.admin_id || 'unknown',
        note || null,
        editedFields ? JSON.stringify(editedFields) : null,
        callId
      ]
    );

    if (result.rows.length === 0) {
      // 沒有更新到任何行：不存在或已被其他 operator 處理
      const existing = await queryOne('SELECT processing_status FROM phone_calls WHERE call_id = $1', [callId]);
      if (!existing) {
        return res.status(404).json({ error: '電話記錄不存在' });
      }
      return res.status(409).json({
        error: '此電話已被審核',
        currentStatus: existing.processing_status
      });
    }

    console.log(`[PhoneCalls Review] ${req.admin?.username} ${action} 電話 ${callId}`);

    // APPROVED：非同步恢復處理管線
    if (action === 'APPROVED') {
      res.json({
        success: true,
        callId,
        action,
        message: '已核准，開始處理訂單'
      });

      setImmediate(async () => {
        try {
          const processor = getPhoneCallProcessor();
          await processor.resumeAfterApproval(callId, editedFields);
        } catch (error) {
          console.error(`[PhoneCalls Review] 審核後處理失敗:`, error);
        }
      });
    } else {
      // REJECTED
      res.json({
        success: true,
        callId,
        action,
        message: '已拒絕'
      });
    }

  } catch (error) {
    console.error('[PhoneCalls Review] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 取得電話音檔（給 admin panel <audio> 元素用）
 * GET /api/phone-calls/:callId/audio[?token=xxx]
 *
 * 支援 HTTP Range request（讓 audio 元素可以 seek）。
 * Token 可走 Bearer header 或 ?token= query param —
 * <audio> 標籤無法自訂 header，必須走 query param（admin 內部 page 用、不外洩）。
 *
 * 檔案名 fallback 跟 PhoneCallProcessor.downloadRecording() 一致：
 *   1. {callId}-caller.wav（Asterisk 客人專屬音軌）
 *   2. {callId}.wav（混合音軌）
 *   3. {callId}.m4a（備用格式）
 */
router.get('/:callId/audio', authenticateAdmin as any, async (req: AuthenticatedRequest, res: Response) => {
  const { callId } = req.params;

  // 防 path traversal：callId 只能含英數、底線、連字號
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(callId)) {
    return res.status(400).json({ error: 'INVALID_CALL_ID' });
  }

  // 確認 DB 真的有這筆紀錄
  const call = await queryOne(
    'SELECT call_id, recording_url FROM phone_calls WHERE call_id = $1',
    [callId]
  );
  if (!call) {
    return res.status(404).json({ error: '電話記錄不存在' });
  }

  // 找實體檔案（caller 音軌優先、退回混合音軌、再退 m4a）
  const candidates = [
    path.join(RECORDINGS_BASE_PATH, path.basename(`${callId}-caller.wav`)),
    path.join(RECORDINGS_BASE_PATH, path.basename(`${callId}.wav`)),
    path.join(RECORDINGS_BASE_PATH, path.basename(`${callId}.m4a`)),
  ];
  const audioPath = candidates.find(p => fs.existsSync(p));
  if (!audioPath) {
    return res.status(404).json({ error: '該通電話沒有錄音檔' });
  }

  const ext = path.extname(audioPath).toLowerCase();
  const contentType = ext === '.m4a' ? 'audio/mp4' : 'audio/wav';

  // Range request 支援（讓 audio 元素可 seek）
  const stat = fs.statSync(audioPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) {
      return res.status(416).json({ error: 'INVALID_RANGE' });
    }
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
    if (start >= fileSize || end >= fileSize || start > end) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).json({ error: 'RANGE_NOT_SATISFIABLE' });
    }
    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(chunkSize));
    res.setHeader('Content-Type', contentType);
    fs.createReadStream(audioPath, { start, end }).pipe(res);
  } else {
    res.status(200);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(fileSize));
    res.setHeader('Content-Type', contentType);
    fs.createReadStream(audioPath).pipe(res);
  }
});

/**
 * 手動重試失敗的處理
 * POST /api/phone-calls/:callId/retry
 */
router.post('/:callId/retry', async (req, res) => {
  const { callId } = req.params;

  try {
    const call = await queryOne(
      'SELECT * FROM phone_calls WHERE call_id = $1',
      [callId]
    );

    if (!call) {
      return res.status(404).json({ error: '電話記錄不存在' });
    }

    if (call.processing_status !== 'FAILED') {
      return res.status(400).json({
        error: `只能重試失敗的記錄，當前狀態: ${call.processing_status}`
      });
    }

    // 重置狀態為 RECEIVED
    await query(
      `UPDATE phone_calls SET processing_status = 'RECEIVED', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE call_id = $1`,
      [callId]
    );

    res.json({
      success: true,
      callId,
      message: '已排入重試佇列'
    });

    // 非同步處理
    setImmediate(async () => {
      try {
        const processor = getPhoneCallProcessor();
        await processor.processCall(callId);
      } catch (error) {
        console.error(`[PhoneCalls Retry] 重試失敗:`, error);
      }
    });

  } catch (error) {
    console.error('[PhoneCalls Retry] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;

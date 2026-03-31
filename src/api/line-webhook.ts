/**
 * line-webhook.ts - LINE Messaging API Webhook 路由
 *
 * 接收 LINE Webhook 事件，管理 LINE 叫車流程
 */

import { Router } from 'express';
import { getLineMessageProcessor } from '../services/LineMessageProcessor';
import { query, queryMany } from '../db/connection';

const router = Router();

/**
 * LINE Webhook - 接收 LINE 平台事件
 * POST /api/line/webhook
 *
 * 注意：此路由的 body 由 LINE SDK middleware 在 index.ts 中處理
 * middleware 會自動驗證簽名並解析 body
 */
router.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events;

    if (!events || events.length === 0) {
      // LINE 驗證 webhook URL 時會送空 events
      return res.json({ success: true });
    }

    console.log(`[LINE Webhook] 收到 ${events.length} 個事件`);

    // 立即回應 200（LINE 要求快速回應）
    res.json({ success: true });

    // 非同步處理事件
    const processor = getLineMessageProcessor();
    for (const event of events) {
      setImmediate(async () => {
        try {
          await processor.processEvent(event);
        } catch (error) {
          console.error(`[LINE Webhook] 事件處理失敗:`, error);
        }
      });
    }

  } catch (error) {
    console.error('[LINE Webhook] 錯誤:', error);
    // LINE webhook 即使出錯也盡量回 200，避免重試風暴
    res.status(200).json({ success: false });
  }
});

/**
 * 列出 LINE 使用者
 * GET /api/line/users
 */
router.get('/users', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  try {
    const users = await queryMany(`
      SELECT lu.*, p.name as passenger_name, p.phone as passenger_phone
      FROM line_users lu
      LEFT JOIN passengers p ON lu.passenger_id = p.passenger_id
      ORDER BY lu.last_interaction_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    res.json({
      users: users.map(u => ({
        lineUserId: u.line_user_id,
        passengerId: u.passenger_id,
        displayName: u.display_name,
        passengerName: u.passenger_name,
        conversationState: u.conversation_state,
        totalOrders: u.total_orders,
        lastInteractionAt: u.last_interaction_at,
        createdAt: u.created_at,
      })),
      total: users.length,
    });
  } catch (error) {
    console.error('[LINE Users] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 查看單一 LINE 使用者
 * GET /api/line/users/:userId
 */
router.get('/users/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await query(
      `SELECT lu.*, p.name as passenger_name, p.phone as passenger_phone
       FROM line_users lu
       LEFT JOIN passengers p ON lu.passenger_id = p.passenger_id
       WHERE lu.line_user_id = $1`,
      [userId]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'LINE 用戶不存在' });
    }

    const u = user.rows[0];
    res.json({
      lineUserId: u.line_user_id,
      passengerId: u.passenger_id,
      displayName: u.display_name,
      passengerName: u.passenger_name,
      conversationState: u.conversation_state,
      conversationData: u.conversation_data,
      totalOrders: u.total_orders,
      lastInteractionAt: u.last_interaction_at,
      createdAt: u.created_at,
    });
  } catch (error) {
    console.error('[LINE User] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * LINE 訊息記錄
 * GET /api/line/messages
 */
router.get('/messages', async (req, res) => {
  const { userId, limit = 50, offset = 0 } = req.query;

  try {
    let sql = 'SELECT * FROM line_messages WHERE 1=1';
    const params: any[] = [];

    if (userId) {
      params.push(userId);
      sql += ` AND line_user_id = $${params.length}`;
    }

    params.push(limit, offset);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const messages = await queryMany(sql, params);

    res.json({
      messages: messages.map(m => ({
        id: m.id,
        messageId: m.message_id,
        lineUserId: m.line_user_id,
        direction: m.direction,
        messageType: m.message_type,
        content: m.content,
        relatedOrderId: m.related_order_id,
        createdAt: m.created_at,
      })),
      total: messages.length,
    });
  } catch (error) {
    console.error('[LINE Messages] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;

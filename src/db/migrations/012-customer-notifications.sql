-- ============================================
-- 012: 客人反向通知（LINE / SMS）— PR1 基礎建設
-- 僅新增欄位與資料表，不改變任何現有流程
-- 接入流程於 PR2 完成（CustomerNotificationService）
-- ============================================

-- === orders 表新增通知追蹤欄位（冪等） ===

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'notification_channel') THEN
    ALTER TABLE orders ADD COLUMN notification_channel VARCHAR(20);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'line_notification_sent_at') THEN
    ALTER TABLE orders ADD COLUMN line_notification_sent_at TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'sms_sent_at') THEN
    ALTER TABLE orders ADD COLUMN sms_sent_at TIMESTAMP;
  END IF;
END $$;

-- === 新建 customer_notifications 表 ===
-- 記錄每一次對外通知（LINE push / SMS send），用於 admin 後台查詢、去重、成本統計

CREATE TABLE IF NOT EXISTS customer_notifications (
  id BIGSERIAL PRIMARY KEY,
  order_id VARCHAR(50) NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,

  -- 通知管道
  channel VARCHAR(20) NOT NULL
    CHECK (channel IN ('LINE', 'SMS')),

  -- 通知事件類型
  event VARCHAR(40) NOT NULL
    CHECK (event IN ('DRIVER_ACCEPTED', 'DRIVER_ARRIVED', 'DISPATCH_FAILED')),

  -- 實際發送內容（debug / 客訴查證）
  message TEXT NOT NULL,

  -- 發送目標（LINE userId 或手機號），debug 用
  target VARCHAR(128),

  -- 發送結果
  status VARCHAR(20) NOT NULL
    CHECK (status IN ('SENT', 'FAILED')),

  -- 失敗時的錯誤資訊（遵守「錯誤完整顯示」原則）
  error_code VARCHAR(40),
  error_message TEXT,

  -- 第三方回傳的識別碼（三竹 msgid / LINE request id）
  provider_message_id VARCHAR(128),

  -- 時間戳
  sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- customer_notifications 索引
-- 1. 查某訂單所有通知（Admin 後台）
CREATE INDEX IF NOT EXISTS idx_cn_order_id ON customer_notifications(order_id);
-- 2. 監控儀表板「最近失敗」
CREATE INDEX IF NOT EXISTS idx_cn_status_event ON customer_notifications(status, event);
-- 3. 時間序查詢（成本統計 / 日報）
CREATE INDEX IF NOT EXISTS idx_cn_sent_at ON customer_notifications(sent_at DESC);

-- 4. 去重查詢：同訂單 × 同事件 × 成功 最多一筆
--    （SENT 狀態限制：不建 partial unique 是因為歷史失敗記錄要保留供 debug）
CREATE INDEX IF NOT EXISTS idx_cn_dedupe ON customer_notifications(order_id, event, status);

-- === orders 通知渠道索引（monitor 用） ===

CREATE INDEX IF NOT EXISTS idx_orders_notification_channel ON orders(notification_channel);

-- 完成
SELECT 'Migration 012-customer-notifications completed successfully' AS result;

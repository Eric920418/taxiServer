-- ============================================
-- 006: LINE 叫車系統 - 資料表與欄位擴展
-- 新增 line_users 表、line_messages 表、orders 預約欄位
-- ============================================

-- === line_users 表：LINE 使用者與乘客映射 + 對話狀態機 ===

CREATE TABLE IF NOT EXISTS line_users (
  line_user_id VARCHAR(50) PRIMARY KEY,
  passenger_id VARCHAR(50) REFERENCES passengers(passenger_id),
  display_name VARCHAR(100),
  picture_url TEXT,

  -- 對話狀態機
  conversation_state VARCHAR(30) DEFAULT 'IDLE'
    CHECK (conversation_state IN (
      'IDLE',
      'AWAITING_PICKUP',
      'AWAITING_DESTINATION',
      'AWAITING_CONFIRM',
      'AWAITING_SCHEDULE_TIME',
      'AWAITING_SCHEDULE_CONFIRM',
      'AWAITING_CANCEL_CONFIRM'
    )),

  -- 暫存對話資料（JSON，存放進行中的叫車資訊）
  conversation_data JSONB DEFAULT '{}',

  -- 統計
  total_orders INTEGER DEFAULT 0,
  last_interaction_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_line_users_passenger ON line_users(passenger_id);
CREATE INDEX IF NOT EXISTS idx_line_users_state ON line_users(conversation_state);

-- === orders 表新增預約欄位 ===

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'scheduled_at') THEN
    ALTER TABLE orders ADD COLUMN scheduled_at TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'line_user_id') THEN
    ALTER TABLE orders ADD COLUMN line_user_id VARCHAR(50);
  END IF;
END $$;

-- 預約訂單索引
CREATE INDEX IF NOT EXISTS idx_orders_scheduled ON orders(scheduled_at)
  WHERE scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_line_user ON orders(line_user_id)
  WHERE line_user_id IS NOT NULL;

-- === line_messages 表：LINE 訊息記錄（除錯用）===

CREATE TABLE IF NOT EXISTS line_messages (
  id SERIAL PRIMARY KEY,
  message_id VARCHAR(50),
  line_user_id VARCHAR(50) REFERENCES line_users(line_user_id),
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('IN', 'OUT')),
  message_type VARCHAR(20),
  content TEXT,
  related_order_id VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_line_messages_user ON line_messages(line_user_id, created_at DESC);

-- 完成
SELECT 'Migration 006-line-integration completed successfully' AS result;

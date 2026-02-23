-- ============================================
-- 004: 電話叫車系統 - 資料表擴展
-- 新增 orders 欄位、phone_calls 表、drivers 能力欄位
-- ============================================

-- === orders 表新增欄位（冪等） ===

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'source') THEN
    ALTER TABLE orders ADD COLUMN source VARCHAR(20) DEFAULT 'APP';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'subsidy_type') THEN
    ALTER TABLE orders ADD COLUMN subsidy_type VARCHAR(30) DEFAULT 'NONE';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'pet_present') THEN
    ALTER TABLE orders ADD COLUMN pet_present VARCHAR(20) DEFAULT 'UNKNOWN';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'pet_carrier') THEN
    ALTER TABLE orders ADD COLUMN pet_carrier VARCHAR(20) DEFAULT 'UNKNOWN';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'pet_note') THEN
    ALTER TABLE orders ADD COLUMN pet_note TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'dropoff_original') THEN
    ALTER TABLE orders ADD COLUMN dropoff_original TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'dropoff_final') THEN
    ALTER TABLE orders ADD COLUMN dropoff_final TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'destination_confirmed') THEN
    ALTER TABLE orders ADD COLUMN destination_confirmed BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'call_id') THEN
    ALTER TABLE orders ADD COLUMN call_id VARCHAR(100);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'audio_url') THEN
    ALTER TABLE orders ADD COLUMN audio_url TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'transcript') THEN
    ALTER TABLE orders ADD COLUMN transcript TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'customer_phone') THEN
    ALTER TABLE orders ADD COLUMN customer_phone VARCHAR(20);
  END IF;
END $$;

-- === 新建 phone_calls 表 ===

CREATE TABLE IF NOT EXISTS phone_calls (
  call_id VARCHAR(100) PRIMARY KEY,
  caller_number VARCHAR(20),
  duration_seconds INTEGER,
  recording_url TEXT,

  -- 處理狀態
  processing_status VARCHAR(30) DEFAULT 'RECEIVED'
    CHECK (processing_status IN (
      'RECEIVED', 'DOWNLOADING', 'TRANSCRIBING', 'PARSING',
      'PARSED', 'DISPATCHING', 'COMPLETED', 'FAILED', 'FOLLOW_UP'
    )),

  -- STT 結果
  transcript TEXT,

  -- GPT 解析結果
  parsed_fields JSONB,

  -- 關聯訂單
  order_id VARCHAR(50) REFERENCES orders(order_id) ON DELETE SET NULL,

  -- 事件類型
  event_type VARCHAR(20) DEFAULT 'NEW_ORDER'
    CHECK (event_type IN ('NEW_ORDER', 'URGE', 'CANCEL', 'CHANGE')),

  -- 跟進電話關聯
  related_call_id VARCHAR(100),

  -- 錯誤追蹤
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,

  -- 時間戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- phone_calls 索引
CREATE INDEX IF NOT EXISTS idx_phone_calls_caller ON phone_calls(caller_number);
CREATE INDEX IF NOT EXISTS idx_phone_calls_status ON phone_calls(processing_status);
CREATE INDEX IF NOT EXISTS idx_phone_calls_order ON phone_calls(order_id);
CREATE INDEX IF NOT EXISTS idx_phone_calls_created ON phone_calls(created_at);

-- orders 來源索引
CREATE INDEX IF NOT EXISTS idx_orders_source ON orders(source);
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);

-- === drivers 表新增能力欄位 ===

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'drivers' AND column_name = 'can_senior_card') THEN
    ALTER TABLE drivers ADD COLUMN can_senior_card BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'drivers' AND column_name = 'can_love_card') THEN
    ALTER TABLE drivers ADD COLUMN can_love_card BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'drivers' AND column_name = 'can_pet') THEN
    ALTER TABLE drivers ADD COLUMN can_pet BOOLEAN DEFAULT TRUE;
  END IF;
END $$;

-- 完成
SELECT 'Migration 004-phone-order-tables completed successfully' AS result;

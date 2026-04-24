-- ============================================
-- 013: no-show 擴充 + 客人備註欄位
-- 新增 orders.penalty_fare, orders.notes,
--     passengers.no_show_count, passengers.last_no_show_at
-- ============================================

-- orders 表：no-show 罰金 + 客人備註
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'penalty_fare') THEN
    ALTER TABLE orders ADD COLUMN penalty_fare INTEGER DEFAULT 0;
    COMMENT ON COLUMN orders.penalty_fare IS 'no-show 罰金（元），客人未到時收取';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'notes') THEN
    ALTER TABLE orders ADD COLUMN notes TEXT;
    COMMENT ON COLUMN orders.notes IS '客人備註（LIFF 叫車時填寫，例如「老人家腳不便」）';
  END IF;
END $$;

-- passengers 表：no-show 累積統計（快取欄位，避免每次從 orders 掃）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'passengers' AND column_name = 'no_show_count') THEN
    ALTER TABLE passengers ADD COLUMN no_show_count INTEGER DEFAULT 0;
    COMMENT ON COLUMN passengers.no_show_count IS '累積 no-show 次數';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'passengers' AND column_name = 'last_no_show_at') THEN
    ALTER TABLE passengers ADD COLUMN last_no_show_at TIMESTAMP;
    COMMENT ON COLUMN passengers.last_no_show_at IS '最後一次 no-show 發生時間';
  END IF;
END $$;

-- no-show 訂單查詢索引（Admin Panel 用）
CREATE INDEX IF NOT EXISTS idx_orders_no_show
  ON orders(cancelled_at DESC)
  WHERE cancel_reason LIKE '客人未到%';

-- passenger no-show 次數索引（未來派單降權用）
CREATE INDEX IF NOT EXISTS idx_passengers_no_show_count
  ON passengers(no_show_count DESC)
  WHERE no_show_count > 0;

SELECT 'Migration 013-no-show-extensions completed' AS result;

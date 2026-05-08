-- ============================================
-- 018: orders 加 1+1 疊單欄位
--
-- 用途：司機 ON_TRIP 且距離目的地 < 5 分鐘時可被列為下一單候選。
--      接單後寫 queued_after_order_id（指向當前訂單），前單完成時自動晉升。
--
-- 欄位：
--   - queued_after_order_id：若設，表示此訂單疊在指定訂單之後
--   - assignment_mode：SINGLE（一般）/ STACKED_1P1（1+1 疊單）
--
-- 設計：
--   - 跟 Android Order.kt 既有的 queuedAfterOrderId / assignmentMode 對齊
--   - 部分索引只索引 queued 訂單（量極少）
-- ============================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'queued_after_order_id') THEN
    ALTER TABLE orders ADD COLUMN queued_after_order_id VARCHAR(50);
    COMMENT ON COLUMN orders.queued_after_order_id IS '若設，表示此訂單疊在指定訂單之後執行（1+1 疊單）';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'assignment_mode') THEN
    ALTER TABLE orders ADD COLUMN assignment_mode VARCHAR(20) DEFAULT 'SINGLE';
    COMMENT ON COLUMN orders.assignment_mode IS '指派模式：SINGLE（一般）/ STACKED_1P1（1+1 疊單）';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_queued_after
  ON orders(queued_after_order_id) WHERE queued_after_order_id IS NOT NULL;

SELECT 'Migration 018-stacked-orders completed' AS result;

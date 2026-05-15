-- ============================================
-- 020: Commission 預設機制
--
-- 1. partners.default_order_commission_pct
--    讓 admin 可在 partner 級別設預設 commission %（大豐 5%、外盟 8% 等）
--    順序：訂單建立 → 系統 default → 接單時用司機 partner default 覆蓋
--
-- 2. 改 orders.commission_pct 預設值 0 → 5
--    ALTER TABLE orders ALTER COLUMN ... SET DEFAULT 5
--    歷史訂單不影響（DEFAULT 只影響未來 INSERT）
-- ============================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'partners' AND column_name = 'default_order_commission_pct') THEN
    ALTER TABLE partners ADD COLUMN default_order_commission_pct INT DEFAULT 5;
    COMMENT ON COLUMN partners.default_order_commission_pct IS '此 partner 旗下司機接到的訂單 commission_pct 預設值（0-100）';
  END IF;
END $$;

-- 改 orders.commission_pct 預設 0 → 5（未來新訂單用）
ALTER TABLE orders ALTER COLUMN commission_pct SET DEFAULT 5;

SELECT 'Migration 020-commission-defaults completed' AS result;

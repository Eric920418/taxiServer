-- ============================================
-- 020: 訂單 commission 預設機制
-- 1. partners 加 default_order_commission_pct（每 partner 預設訂單抽成 %）
-- 2. orders.commission_pct DEFAULT 從 0 → 5（系統級預設）
-- ============================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'partners' AND column_name = 'default_order_commission_pct') THEN
    ALTER TABLE partners ADD COLUMN default_order_commission_pct INT DEFAULT 5;
    COMMENT ON COLUMN partners.default_order_commission_pct IS '此 partner 司機接單時，新訂單預設抽成 %（接單時覆蓋 orders.commission_pct）';
  END IF;
END $$;

ALTER TABLE orders ALTER COLUMN commission_pct SET DEFAULT 5;

UPDATE partners SET default_order_commission_pct = 5
  WHERE default_order_commission_pct IS NULL;

SELECT 'Migration 020-commission-defaults completed' AS result;

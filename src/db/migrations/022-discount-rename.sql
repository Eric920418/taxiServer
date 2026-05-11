-- ============================================
-- 022: commission_pct (%) → discount_amount (NT$) 全域翻轉
-- 語意完全反轉：
--   舊：commission_pct = 司機被平台抽走 %（負向）
--   新：discount_amount = 司機願意對客人讓利 NT$ 元（正向）
-- 匹配方向也翻轉：
--   舊：driver.max_acceptable_commission_pct >= order.commission_pct (低門檻)
--   新：driver.max_acceptable_discount_amount >= order.discount_amount (高彈性)
-- 4 段制：0/10/20/30/40 元
-- ============================================

BEGIN;

-- orders
ALTER TABLE orders RENAME COLUMN commission_pct TO discount_amount;
ALTER TABLE orders ALTER COLUMN discount_amount SET DEFAULT 0;
UPDATE orders SET discount_amount = 0 WHERE discount_amount = 5;
COMMENT ON COLUMN orders.discount_amount IS '客人答應給的折扣 NT$ 元，5 段制 0/10/20/30/40';

-- orders: 加 preferred_fleet_partner_id (LINE 官方 / 電話 來源綁特定車隊)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'preferred_fleet_partner_id') THEN
    ALTER TABLE orders ADD COLUMN preferred_fleet_partner_id VARCHAR(50);
    -- 注意：partners.partner_id FK 不強制（避免 partners 還沒建好的訂單 reject）
    COMMENT ON COLUMN orders.preferred_fleet_partner_id IS '優先派此 fleet 的司機（LINE 官方/電話 來源），30 秒 timeout 後客人可選擇解除';
  END IF;
END $$;

-- orders: 加 fallback_prompted_at（OrderFallbackService 用，避免重複推送）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'fallback_prompted_at') THEN
    ALTER TABLE orders ADD COLUMN fallback_prompted_at TIMESTAMP;
    COMMENT ON COLUMN orders.fallback_prompted_at IS '已推送 fallback prompt 給客人的時間（避免重複推）';
  END IF;
END $$;

-- drivers
ALTER TABLE drivers RENAME COLUMN max_acceptable_commission_pct TO max_acceptable_discount_amount;
ALTER TABLE drivers ALTER COLUMN max_acceptable_discount_amount SET DEFAULT 0;
UPDATE drivers SET max_acceptable_discount_amount = 0 WHERE max_acceptable_discount_amount = 100;
COMMENT ON COLUMN drivers.max_acceptable_discount_amount IS '司機願意對客人讓利最高 NT$ 元（0=全價單也接，數字越大越積極）';

-- partners
ALTER TABLE partners RENAME COLUMN default_order_commission_pct TO default_order_discount_amount;
ALTER TABLE partners ALTER COLUMN default_order_discount_amount SET DEFAULT 0;
UPDATE partners SET default_order_discount_amount = 30 WHERE default_order_discount_amount = 5;
COMMENT ON COLUMN partners.default_order_discount_amount IS '此 partner 帶來的訂單預設折扣金額（NT$ 元）';

-- partners: 確保 notes 欄位存在
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'partners' AND column_name = 'notes') THEN
    ALTER TABLE partners ADD COLUMN notes TEXT;
  END IF;
END $$;

-- queue_entries
ALTER TABLE queue_entries RENAME COLUMN max_acceptable_commission_pct TO max_acceptable_discount_amount;
ALTER TABLE queue_entries ALTER COLUMN max_acceptable_discount_amount SET DEFAULT 0;
COMMENT ON COLUMN queue_entries.max_acceptable_discount_amount IS '排班司機願意接受最高折扣 NT$ 元';

-- billing_snapshots
ALTER TABLE billing_snapshots RENAME COLUMN commission_pct TO discount_amount;
ALTER TABLE billing_snapshots RENAME COLUMN total_commission_amount TO total_discount_amount;
COMMENT ON COLUMN billing_snapshots.discount_amount IS '此訂單客人實付折扣 NT$ 元';
COMMENT ON COLUMN billing_snapshots.total_discount_amount IS '= discount_amount（單位元）';

COMMIT;

SELECT 'Migration 022-discount-rename completed' AS result;

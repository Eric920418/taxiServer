-- 008: 愛心卡補貼欄位
-- 新增 subsidy_amount（實際補貼金額）和 subsidy_confirmed（司機是否已確認卡片）

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'subsidy_amount') THEN
    ALTER TABLE orders ADD COLUMN subsidy_amount INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'subsidy_confirmed') THEN
    ALTER TABLE orders ADD COLUMN subsidy_confirmed BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

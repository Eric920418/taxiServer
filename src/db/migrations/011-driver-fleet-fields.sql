-- =====================================================
-- 011-driver-fleet-fields.sql
-- 新增 teams 表 + drivers 擴充欄位
-- 對應：Admin Panel「新增司機」表單大改造
-- 可重複執行（IF NOT EXISTS / ON CONFLICT DO NOTHING）
-- =====================================================

-- 1) 車隊表（MVP 簡單型，未來需要再擴）
CREATE TABLE IF NOT EXISTS teams (
  team_id    SERIAL PRIMARY KEY,
  name       VARCHAR(100) UNIQUE NOT NULL,
  note       TEXT,
  is_active  BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2) 預設車隊 seed（讓新增司機時 Select 立刻可用）
INSERT INTO teams (name) VALUES
  ('花蓮計程車公會'),
  ('太魯閣車行'),
  ('獨立車行')
ON CONFLICT (name) DO NOTHING;

-- 3) drivers 擴充欄位
-- 注意：driver_type 本來以為 001-smart-dispatch-tables.sql 有加過，實際沒有，本次補齊
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(team_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS car_model VARCHAR(50),
  ADD COLUMN IF NOT EXISTS car_color VARCHAR(20),
  ADD COLUMN IF NOT EXISTS license_number VARCHAR(30),
  ADD COLUMN IF NOT EXISTS note TEXT,
  ADD COLUMN IF NOT EXISTS driver_type VARCHAR(30) DEFAULT 'HIGH_VOLUME',
  ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS accepted_order_types TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS accepted_rebate_levels INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- 4) CHECK constraint（分開下避免 ALTER 時因既有 NULL 值失敗）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'drivers_account_status_check'
  ) THEN
    ALTER TABLE drivers
      ADD CONSTRAINT drivers_account_status_check
      CHECK (account_status IN ('ACTIVE','SUSPENDED','PENDING','ARCHIVED'));
  END IF;
END $$;

-- 5) 索引（派單效能）
CREATE INDEX IF NOT EXISTS idx_drivers_team_id ON drivers(team_id);
CREATE INDEX IF NOT EXISTS idx_drivers_account_status ON drivers(account_status);
CREATE INDEX IF NOT EXISTS idx_drivers_driver_type ON drivers(driver_type);
CREATE INDEX IF NOT EXISTS idx_drivers_accepted_order_types ON drivers USING GIN (accepted_order_types);
CREATE INDEX IF NOT EXISTS idx_drivers_accepted_rebate_levels ON drivers USING GIN (accepted_rebate_levels);

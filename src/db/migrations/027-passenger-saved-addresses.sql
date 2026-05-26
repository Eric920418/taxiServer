-- ============================================
-- 027: 長輩 LINE 一鍵叫車 — passenger 常用地點
-- 模組 1 of「長輩 LINE 叫車 roadmap」
-- ============================================
--
-- 一鍵叫車邏輯（後端 /one-click-suggest）：
--   1. GPS 上車點傳進來
--   2. 比對每個常用地點，找最近的（≤200m）= pickup 智慧帶入
--   3. 從剩下的常用地點選 use_count 最高的 = 建議目的地
--   4. is_home=TRUE 一定唯一（per passenger），給「在家附近 → 跳表單」邏輯用

CREATE TABLE IF NOT EXISTS passenger_saved_addresses (
  id SERIAL PRIMARY KEY,
  passenger_id VARCHAR(50) NOT NULL REFERENCES passengers(passenger_id) ON DELETE CASCADE,

  -- 'HOME' | 'HOSPITAL' | 'MARKET' | 'WORK' | 'CUSTOM'（給前端 icon 用）
  label VARCHAR(50) NOT NULL,

  -- 長輩看的中文名：「我家」/「忠孝醫院」/「黃昏市場」
  display_name VARCHAR(100) NOT NULL,

  -- 完整地址 + 座標（傳給 create-order）
  address VARCHAR(500) NOT NULL,
  lat NUMERIC(10, 6) NOT NULL,
  lng NUMERIC(10, 6) NOT NULL,

  -- 用過幾次當目的地，排序用「最常去」
  use_count INTEGER DEFAULT 0,

  -- 標記「家」(UNIQUE INDEX 強制 per passenger 只能一個)
  is_home BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pas_passenger ON passenger_saved_addresses(passenger_id);

-- 每位長輩只能有一個 is_home=TRUE 的地點（partial unique index）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pas_home
  ON passenger_saved_addresses(passenger_id) WHERE is_home = TRUE;

-- updated_at 自動更新
CREATE OR REPLACE FUNCTION update_pas_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_pas_updated_at') THEN
    CREATE TRIGGER tr_pas_updated_at
      BEFORE UPDATE ON passenger_saved_addresses
      FOR EACH ROW EXECUTE FUNCTION update_pas_timestamp();
  END IF;
END $$;

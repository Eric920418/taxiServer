-- ============================================
-- 031: 司機補行程資料（目的地/中途停靠/備註）+ 修改稽核
-- ============================================
-- 電話 AI 單可只有上車點先建單；司機載到客人後補目的地/加停靠/備註。
-- 全部加表/加欄位，不刪不覆蓋既有資料（禁 accept-data-loss）。冪等（IF NOT EXISTS）。
-- 註：dropoff_original(AI 原值) / dropoff_final(司機確認值) / destination_confirmed 已在 004 建好，沿用。

-- 中途停靠點（司機後補；可影響導航多點路線）
CREATE TABLE IF NOT EXISTS order_waypoints (
  waypoint_id SERIAL PRIMARY KEY,
  order_id VARCHAR(50) NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  sequence INT NOT NULL DEFAULT 0,        -- 0,1,2... 停靠順序
  address TEXT,
  lat DECIMAL(10, 8),
  lng DECIMAL(11, 8),
  note TEXT,
  added_by VARCHAR(50),                   -- 'driver:<id>' / 'admin:<id>'
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_waypoints_order ON order_waypoints(order_id, sequence);

-- 訂單修改稽核（append-only：誰、何時、把什麼改成什麼）— 後台比對 AI 原值 vs 司機補值
CREATE TABLE IF NOT EXISTS order_edits (
  edit_id SERIAL PRIMARY KEY,
  order_id VARCHAR(50) NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  edited_by VARCHAR(50),                  -- 'driver:<id>' / 'admin:<id>'
  edit_type VARCHAR(20) NOT NULL CHECK (edit_type IN ('DESTINATION', 'NOTES', 'WAYPOINT')),
  original_value JSONB,                   -- 改前
  new_value JSONB,                        -- 改後
  reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_edits_order ON order_edits(order_id, created_at DESC);

-- orders：目的地被誰 / 何時改（給後台與排序用）
ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_modified_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_modified_by VARCHAR(50);

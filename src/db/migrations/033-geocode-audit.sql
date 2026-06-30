-- ============================================================
-- Migration 033: geocode 回饋迴路（揪出 AI 配錯的上車點）
--
-- 目的：用司機「開始行程(ON_TRIP)」當下的實際位置 = 真正上車點，
--      和 AI 定位的 pickup 比距離，超過門檻＝配錯 → 進「待補齊地標」待辦、
--      ops 一鍵以正確座標轉地標。全 additive、不碰既有資料/約束。
-- ============================================================

-- 司機真正載到客人的位置（ON_TRIP 當下 GPS），用來和 pickup_lat/lng(AI 定位) 比對
ALTER TABLE orders ADD COLUMN IF NOT EXISTS actual_pickup_lat DECIMAL(10, 8);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS actual_pickup_lng DECIMAL(11, 8);

-- 待辦表標記：此筆來自「ground-truth 配錯」而非「本地庫沒收錄」；附樣本訂單供追查
ALTER TABLE address_lookup_failures ADD COLUMN IF NOT EXISTS geocode_mismatch BOOLEAN DEFAULT FALSE;
ALTER TABLE address_lookup_failures ADD COLUMN IF NOT EXISTS sample_order_id TEXT;

SELECT 'Migration 033 geocode-audit 完成' AS message;

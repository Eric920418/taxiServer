-- ============================================
-- 032: 司機「完成訂單後自動排班」開關
-- ============================================
-- 司機自控開關：開啟時，每趟訂單完成後依司機當下 GPS 自動排入所在排班區；
-- 關閉時維持自由狀態、不自動排班。預設關（opt-in）。
-- 純加欄位、DEFAULT false、metadata-only，不刪不覆蓋既有資料（禁 accept-data-loss）。冪等。

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS auto_queue_after_trip BOOLEAN NOT NULL DEFAULT false;

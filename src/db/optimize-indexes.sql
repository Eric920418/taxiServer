-- 效能優化索引
-- 執行此腳本以建立優化索引

-- ============================================
-- 司機相關索引
-- ============================================

-- 司機位置查詢索引（用於查找可用司機）
CREATE INDEX IF NOT EXISTS idx_drivers_location
ON drivers(current_lat, current_lng)
WHERE availability = 'AVAILABLE';

-- 司機狀態索引
CREATE INDEX IF NOT EXISTS idx_drivers_availability
ON drivers(availability, last_heartbeat DESC);

-- 司機手機查詢索引
CREATE INDEX IF NOT EXISTS idx_drivers_phone
ON drivers(phone);

-- 司機 Firebase UID 索引
CREATE INDEX IF NOT EXISTS idx_drivers_firebase_uid
ON drivers(firebase_uid)
WHERE firebase_uid IS NOT NULL;

-- ============================================
-- 訂單相關索引
-- ============================================

-- 訂單狀態與時間複合索引
CREATE INDEX IF NOT EXISTS idx_orders_status_created
ON orders(status, created_at DESC);

-- 司機訂單查詢索引
CREATE INDEX IF NOT EXISTS idx_orders_driver_status
ON orders(driver_id, status)
WHERE driver_id IS NOT NULL;

-- 乘客訂單查詢索引
CREATE INDEX IF NOT EXISTS idx_orders_passenger_status
ON orders(passenger_id, status);

-- 訂單完成時間索引（用於統計）
CREATE INDEX IF NOT EXISTS idx_orders_completed_at
ON orders(completed_at DESC)
WHERE status = 'COMPLETED';

-- 訂單位置索引（用於熱區分析）
CREATE INDEX IF NOT EXISTS idx_orders_pickup_location
ON orders(pickup_lat, pickup_lng)
WHERE status IN ('COMPLETED', 'IN_PROGRESS');

-- 訂單時段索引（用於派單分析）
CREATE INDEX IF NOT EXISTS idx_orders_hour_day
ON orders(hour_of_day, day_of_week)
WHERE status = 'COMPLETED';

-- ============================================
-- 乘客相關索引
-- ============================================

-- 乘客手機查詢索引
CREATE INDEX IF NOT EXISTS idx_passengers_phone
ON passengers(phone);

-- 乘客 Firebase UID 索引
CREATE INDEX IF NOT EXISTS idx_passengers_firebase_uid
ON passengers(firebase_uid)
WHERE firebase_uid IS NOT NULL;

-- ============================================
-- 派單記錄索引
-- ============================================

-- 派單記錄查詢索引
CREATE INDEX IF NOT EXISTS idx_dispatch_logs_order
ON dispatch_logs(order_id, created_at DESC);

-- 司機派單記錄索引
CREATE INDEX IF NOT EXISTS idx_dispatch_logs_driver
ON dispatch_logs(dispatched_to, created_at DESC);

-- ============================================
-- 管理員相關索引
-- ============================================

-- 管理員用戶名索引
CREATE INDEX IF NOT EXISTS idx_admins_username
ON admins(username)
WHERE is_active = true;

-- 管理員郵箱索引
CREATE INDEX IF NOT EXISTS idx_admins_email
ON admins(email)
WHERE is_active = true;

-- ============================================
-- 分析現有索引使用情況
-- ============================================

-- 檢視索引大小和使用情況
SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    idx_scan as index_scans_count
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC;

-- 檢視未使用的索引
SELECT
    schemaname,
    tablename,
    indexname
FROM pg_stat_user_indexes
WHERE idx_scan = 0
    AND indexname NOT LIKE 'pg_%'
ORDER BY schemaname, tablename;

-- 檢視表格統計
SELECT
    schemaname,
    tablename,
    n_tup_ins AS inserts,
    n_tup_upd AS updates,
    n_tup_del AS deletes,
    n_live_tup AS live_tuples,
    n_dead_tup AS dead_tuples,
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;

-- ============================================
-- 更新統計資訊
-- ============================================
ANALYZE drivers;
ANALYZE orders;
ANALYZE passengers;
ANALYZE dispatch_logs;
ANALYZE admins;

-- 顯示執行計畫範例（可用於驗證索引效果）
-- EXPLAIN ANALYZE SELECT * FROM drivers WHERE availability = 'AVAILABLE' AND current_lat BETWEEN 23.9 AND 24.1 AND current_lng BETWEEN 121.5 AND 121.7;
-- Migration 002: AI 自動接單功能資料表
-- 日期: 2025-12-31
-- 功能: 司機自動接單設定 + 日誌追蹤

-- ============================================
-- 1. 司機自動接單設定表
-- ============================================
CREATE TABLE IF NOT EXISTS driver_auto_accept_settings (
    setting_id SERIAL PRIMARY KEY,
    driver_id VARCHAR(50) NOT NULL UNIQUE REFERENCES drivers(driver_id) ON DELETE CASCADE,

    -- 開關
    enabled BOOLEAN DEFAULT FALSE,

    -- 篩選條件
    max_pickup_distance_km DECIMAL(5,2) DEFAULT 5.0,      -- 最大接單距離 (km)
    min_fare_amount INTEGER DEFAULT 100,                   -- 最低接受車資 (元)
    min_trip_distance_km DECIMAL(5,2) DEFAULT 1.0,         -- 最短行程距離 (km)

    -- 時段設定 (JSON 陣列，如 [7,8,9,17,18,19])
    active_hours JSONB DEFAULT '[]'::jsonb,

    -- 區域黑名單 (地點名稱陣列，如 ["太魯閣國家公園"])
    blacklisted_zones JSONB DEFAULT '[]'::jsonb,

    -- 智能模式
    smart_mode_enabled BOOLEAN DEFAULT TRUE,               -- 是否使用 ML 推薦
    auto_accept_threshold DECIMAL(5,2) DEFAULT 70.0,       -- 自動接單分數門檻 (0-100)

    -- 風控設定
    daily_auto_accept_limit INTEGER DEFAULT 30,            -- 每日自動接單上限
    cooldown_minutes INTEGER DEFAULT 2,                    -- 連續自動接單冷卻時間 (分鐘)
    consecutive_limit INTEGER DEFAULT 5,                   -- 連續自動接單後強制手動

    -- 時間戳
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 2. 自動接單日誌表
-- ============================================
CREATE TABLE IF NOT EXISTS auto_accept_logs (
    log_id SERIAL PRIMARY KEY,
    driver_id VARCHAR(50) NOT NULL REFERENCES drivers(driver_id) ON DELETE CASCADE,
    order_id VARCHAR(50) NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,

    -- 決策資訊
    auto_accept_score DECIMAL(5,2),                        -- ML 計算的自動接單分數
    threshold_used DECIMAL(5,2),                           -- 當時使用的門檻值
    decision VARCHAR(20) NOT NULL CHECK (decision IN ('AUTO_ACCEPT', 'MANUAL', 'BLOCKED')),
    block_reason VARCHAR(100),                             -- 如果被阻擋，原因

    -- 訂單特徵快照
    pickup_distance_km DECIMAL(5,2),
    estimated_fare INTEGER,
    trip_distance_km DECIMAL(5,2),
    hour_of_day INTEGER,
    zone_name VARCHAR(100),

    -- 時間戳
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 3. 每日自動接單統計表 (用於風控)
-- ============================================
CREATE TABLE IF NOT EXISTS daily_auto_accept_stats (
    stat_id SERIAL PRIMARY KEY,
    driver_id VARCHAR(50) NOT NULL REFERENCES drivers(driver_id) ON DELETE CASCADE,
    stat_date DATE NOT NULL,

    -- 統計數據
    auto_accept_count INTEGER DEFAULT 0,
    manual_accept_count INTEGER DEFAULT 0,
    blocked_count INTEGER DEFAULT 0,

    -- 連續自動接單追蹤
    consecutive_auto_accepts INTEGER DEFAULT 0,
    last_auto_accept_at TIMESTAMP,

    -- 完成率追蹤
    auto_accept_completed INTEGER DEFAULT 0,
    auto_accept_cancelled INTEGER DEFAULT 0,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(driver_id, stat_date)
);

-- ============================================
-- 4. 索引
-- ============================================
CREATE INDEX IF NOT EXISTS idx_auto_accept_settings_driver
    ON driver_auto_accept_settings(driver_id);

CREATE INDEX IF NOT EXISTS idx_auto_accept_settings_enabled
    ON driver_auto_accept_settings(enabled) WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_auto_accept_logs_driver
    ON auto_accept_logs(driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auto_accept_logs_order
    ON auto_accept_logs(order_id);

CREATE INDEX IF NOT EXISTS idx_auto_accept_logs_decision
    ON auto_accept_logs(decision, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_daily_auto_accept_stats_lookup
    ON daily_auto_accept_stats(driver_id, stat_date);

-- ============================================
-- 5. 更新時間戳觸發器
-- ============================================
CREATE OR REPLACE FUNCTION update_auto_accept_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_accept_settings_updated ON driver_auto_accept_settings;
CREATE TRIGGER trg_auto_accept_settings_updated
    BEFORE UPDATE ON driver_auto_accept_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_auto_accept_timestamp();

DROP TRIGGER IF EXISTS trg_daily_auto_accept_stats_updated ON daily_auto_accept_stats;
CREATE TRIGGER trg_daily_auto_accept_stats_updated
    BEFORE UPDATE ON daily_auto_accept_stats
    FOR EACH ROW
    EXECUTE FUNCTION update_auto_accept_timestamp();

-- ============================================
-- 6. 註解
-- ============================================
COMMENT ON TABLE driver_auto_accept_settings IS '司機自動接單設定';
COMMENT ON TABLE auto_accept_logs IS '自動接單決策日誌';
COMMENT ON TABLE daily_auto_accept_stats IS '每日自動接單統計 (風控用)';

COMMENT ON COLUMN driver_auto_accept_settings.auto_accept_threshold IS '自動接單分數門檻，0-100，預設70';
COMMENT ON COLUMN driver_auto_accept_settings.active_hours IS 'JSON陣列，僅在這些小時啟用自動接單，如[7,8,9,17,18,19]';
COMMENT ON COLUMN driver_auto_accept_settings.blacklisted_zones IS 'JSON陣列，不自動接受這些區域的訂單';
COMMENT ON COLUMN auto_accept_logs.decision IS 'AUTO_ACCEPT=自動接單, MANUAL=手動接單, BLOCKED=被風控阻擋';

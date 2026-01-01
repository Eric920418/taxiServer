-- Migration 003: 熱區配額管理功能資料表
-- 日期: 2025-12-31
-- 功能: 熱區定義 + 配額管理 + 排隊機制

-- ============================================
-- 1. 熱區設定表
-- ============================================
CREATE TABLE IF NOT EXISTS hot_zone_configs (
    zone_id SERIAL PRIMARY KEY,
    zone_name VARCHAR(100) NOT NULL UNIQUE,

    -- 位置設定
    center_lat DECIMAL(10,8) NOT NULL,
    center_lng DECIMAL(11,8) NOT NULL,
    radius_km DECIMAL(5,2) DEFAULT 1.0,

    -- 尖峰時段 (JSON 陣列，如 [18,19,20,21,22])
    peak_hours JSONB DEFAULT '[18,19,20,21,22]'::jsonb,

    -- 配額設定
    hourly_quota_normal INTEGER DEFAULT 20,     -- 一般時段每小時配額
    hourly_quota_peak INTEGER DEFAULT 30,       -- 尖峰時段每小時配額

    -- 漲價設定 (混合模式)
    surge_threshold DECIMAL(3,2) DEFAULT 0.80,  -- 80% 使用率開始漲價
    surge_multiplier_max DECIMAL(3,2) DEFAULT 1.50, -- 最高漲價 1.5 倍
    surge_step DECIMAL(3,2) DEFAULT 0.10,       -- 每超過 10% 漲價一檔

    -- 排隊設定
    queue_enabled BOOLEAN DEFAULT TRUE,         -- 超額時是否啟用排隊
    max_queue_size INTEGER DEFAULT 20,          -- 最大排隊數
    queue_timeout_minutes INTEGER DEFAULT 15,   -- 排隊超時時間

    -- 狀態
    is_active BOOLEAN DEFAULT TRUE,
    priority INTEGER DEFAULT 0,                 -- 優先級 (重疊區域時)

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 2. 預設熱區資料 (花蓮)
-- ============================================
INSERT INTO hot_zone_configs (zone_name, center_lat, center_lng, radius_km, peak_hours, hourly_quota_normal, hourly_quota_peak, priority) VALUES
('東大門夜市', 23.9986, 121.6083, 1.0, '[18,19,20,21,22]', 25, 40, 10),
('花蓮火車站', 23.9933, 121.6011, 0.8, '[6,7,8,9,17,18]', 30, 50, 20),
('遠百花蓮店', 23.9878, 121.6061, 0.5, '[15,16,17,18,19,20]', 15, 25, 5),
('太魯閣國家公園', 24.1555, 121.6207, 2.0, '[8,9,10,15,16]', 10, 20, 15)
ON CONFLICT (zone_name) DO NOTHING;

-- ============================================
-- 3. 配額狀態表 (每小時一筆記錄)
-- ============================================
CREATE TABLE IF NOT EXISTS hot_zone_quotas (
    quota_id SERIAL PRIMARY KEY,
    zone_id INTEGER NOT NULL REFERENCES hot_zone_configs(zone_id) ON DELETE CASCADE,

    -- 時間粒度
    quota_date DATE NOT NULL,
    quota_hour INTEGER NOT NULL CHECK (quota_hour >= 0 AND quota_hour <= 23),

    -- 配額狀態
    quota_limit INTEGER NOT NULL,
    quota_used INTEGER DEFAULT 0,

    -- 當前漲價倍率 (動態計算後存儲)
    current_surge DECIMAL(3,2) DEFAULT 1.00,

    -- 統計
    orders_completed INTEGER DEFAULT 0,
    orders_cancelled INTEGER DEFAULT 0,
    total_fare_collected INTEGER DEFAULT 0,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(zone_id, quota_date, quota_hour)
);

-- ============================================
-- 4. 排隊訂單表
-- ============================================
CREATE TABLE IF NOT EXISTS hot_zone_queue (
    queue_id SERIAL PRIMARY KEY,
    zone_id INTEGER NOT NULL REFERENCES hot_zone_configs(zone_id) ON DELETE CASCADE,
    order_id VARCHAR(50) NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    passenger_id VARCHAR(50) NOT NULL REFERENCES passengers(passenger_id) ON DELETE CASCADE,

    -- 排隊資訊
    queue_position INTEGER NOT NULL,
    queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    estimated_wait_minutes INTEGER,

    -- 漲價資訊 (排隊時的漲價倍率)
    surge_multiplier DECIMAL(3,2) DEFAULT 1.00,
    original_fare INTEGER,
    surged_fare INTEGER,

    -- 狀態
    status VARCHAR(20) DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'RELEASED', 'CANCELLED', 'EXPIRED')),
    released_at TIMESTAMP,
    release_reason VARCHAR(100),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 5. 熱區訂單追蹤表 (用於統計和配額釋放)
-- ============================================
CREATE TABLE IF NOT EXISTS hot_zone_orders (
    tracking_id SERIAL PRIMARY KEY,
    zone_id INTEGER NOT NULL REFERENCES hot_zone_configs(zone_id) ON DELETE CASCADE,
    order_id VARCHAR(50) NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE CASCADE,

    -- 配額資訊
    quota_date DATE NOT NULL,
    quota_hour INTEGER NOT NULL,

    -- 漲價資訊
    surge_multiplier DECIMAL(3,2) DEFAULT 1.00,
    original_fare INTEGER,
    final_fare INTEGER,

    -- 狀態
    quota_consumed BOOLEAN DEFAULT TRUE,
    quota_released BOOLEAN DEFAULT FALSE,
    released_at TIMESTAMP,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 6. 索引
-- ============================================
CREATE INDEX IF NOT EXISTS idx_hot_zone_configs_active
    ON hot_zone_configs(is_active) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_hot_zone_configs_location
    ON hot_zone_configs(center_lat, center_lng);

CREATE INDEX IF NOT EXISTS idx_hot_zone_quotas_lookup
    ON hot_zone_quotas(zone_id, quota_date, quota_hour);

CREATE INDEX IF NOT EXISTS idx_hot_zone_quotas_date
    ON hot_zone_quotas(quota_date);

CREATE INDEX IF NOT EXISTS idx_hot_zone_queue_status
    ON hot_zone_queue(zone_id, status);

CREATE INDEX IF NOT EXISTS idx_hot_zone_queue_order
    ON hot_zone_queue(order_id);

CREATE INDEX IF NOT EXISTS idx_hot_zone_queue_passenger
    ON hot_zone_queue(passenger_id, status);

CREATE INDEX IF NOT EXISTS idx_hot_zone_orders_zone_date
    ON hot_zone_orders(zone_id, quota_date, quota_hour);

CREATE INDEX IF NOT EXISTS idx_hot_zone_orders_order
    ON hot_zone_orders(order_id);

-- ============================================
-- 7. 更新時間戳觸發器
-- ============================================
CREATE OR REPLACE FUNCTION update_hot_zone_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hot_zone_configs_updated ON hot_zone_configs;
CREATE TRIGGER trg_hot_zone_configs_updated
    BEFORE UPDATE ON hot_zone_configs
    FOR EACH ROW
    EXECUTE FUNCTION update_hot_zone_timestamp();

DROP TRIGGER IF EXISTS trg_hot_zone_quotas_updated ON hot_zone_quotas;
CREATE TRIGGER trg_hot_zone_quotas_updated
    BEFORE UPDATE ON hot_zone_quotas
    FOR EACH ROW
    EXECUTE FUNCTION update_hot_zone_timestamp();

-- ============================================
-- 8. 漲價倍率計算函數
-- ============================================
CREATE OR REPLACE FUNCTION calculate_surge_multiplier(
    p_usage_percentage DECIMAL(5,2),
    p_surge_threshold DECIMAL(3,2),
    p_surge_max DECIMAL(3,2),
    p_surge_step DECIMAL(3,2)
)
RETURNS DECIMAL(3,2) AS $$
DECLARE
    v_surge DECIMAL(3,2);
    v_over_threshold DECIMAL(5,2);
    v_steps INTEGER;
BEGIN
    -- 未達門檻，不漲價
    IF p_usage_percentage < p_surge_threshold THEN
        RETURN 1.00;
    END IF;

    -- 計算超過門檻的比例
    v_over_threshold := p_usage_percentage - p_surge_threshold;

    -- 計算漲價檔數 (每超過 surge_step 漲一檔)
    v_steps := CEIL(v_over_threshold / p_surge_step);

    -- 計算漲價倍率 (每檔漲 10%)
    v_surge := 1.00 + (v_steps * 0.10);

    -- 不超過最大值
    IF v_surge > p_surge_max THEN
        v_surge := p_surge_max;
    END IF;

    RETURN v_surge;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 9. 獲取或創建當前小時配額函數
-- ============================================
CREATE OR REPLACE FUNCTION get_or_create_hourly_quota(
    p_zone_id INTEGER,
    p_date DATE,
    p_hour INTEGER
)
RETURNS TABLE(
    quota_id INTEGER,
    quota_limit INTEGER,
    quota_used INTEGER,
    current_surge DECIMAL(3,2)
) AS $$
DECLARE
    v_zone RECORD;
    v_is_peak BOOLEAN;
    v_quota_limit INTEGER;
BEGIN
    -- 獲取熱區設定
    SELECT * INTO v_zone FROM hot_zone_configs WHERE hot_zone_configs.zone_id = p_zone_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Zone not found: %', p_zone_id;
    END IF;

    -- 判斷是否尖峰時段
    v_is_peak := v_zone.peak_hours ? p_hour::text;

    -- 決定配額
    IF v_is_peak THEN
        v_quota_limit := v_zone.hourly_quota_peak;
    ELSE
        v_quota_limit := v_zone.hourly_quota_normal;
    END IF;

    -- 嘗試插入或獲取
    INSERT INTO hot_zone_quotas (zone_id, quota_date, quota_hour, quota_limit)
    VALUES (p_zone_id, p_date, p_hour, v_quota_limit)
    ON CONFLICT (zone_id, quota_date, quota_hour) DO NOTHING;

    -- 返回結果
    RETURN QUERY
    SELECT
        hzq.quota_id::INTEGER,
        hzq.quota_limit,
        hzq.quota_used,
        hzq.current_surge
    FROM hot_zone_quotas hzq
    WHERE hzq.zone_id = p_zone_id
      AND hzq.quota_date = p_date
      AND hzq.quota_hour = p_hour;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 10. 註解
-- ============================================
COMMENT ON TABLE hot_zone_configs IS '熱區設定，定義熱門區域的座標和配額規則';
COMMENT ON TABLE hot_zone_quotas IS '每小時配額狀態，追蹤使用量和漲價';
COMMENT ON TABLE hot_zone_queue IS '排隊訂單，配額耗盡時乘客排隊等待';
COMMENT ON TABLE hot_zone_orders IS '熱區訂單追蹤，用於配額消耗和釋放';

COMMENT ON COLUMN hot_zone_configs.surge_threshold IS '開始漲價的使用率門檻，預設0.80 (80%)';
COMMENT ON COLUMN hot_zone_configs.surge_multiplier_max IS '最高漲價倍率，預設1.50 (1.5倍)';
COMMENT ON COLUMN hot_zone_configs.surge_step IS '每超過多少比例漲一檔，預設0.10 (10%)';
COMMENT ON COLUMN hot_zone_queue.status IS 'WAITING=等待中, RELEASED=已釋放派單, CANCELLED=已取消, EXPIRED=已超時';

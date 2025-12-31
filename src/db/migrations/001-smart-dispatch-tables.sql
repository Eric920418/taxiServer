-- ============================================================
-- 智能派單系統 V2 - 資料庫 Migration
-- 日期: 2025-12-12
-- 版本: 2.0.0
-- ============================================================

-- ============================================================
-- 1. 派單決策日誌表 (dispatch_logs)
-- 記錄每次派單決策的詳細資訊，用於分析和優化
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatch_logs (
  log_id SERIAL PRIMARY KEY,
  order_id VARCHAR(50) NOT NULL REFERENCES orders(order_id),

  -- 派單批次資訊
  batch_number INTEGER DEFAULT 1,
  dispatched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- 推薦的司機列表（JSON 陣列）
  -- 格式: [{driverId, score, etaSeconds, reason, rejectionProbability}]
  recommended_drivers JSONB NOT NULL,

  -- 派單決策因子權重（當時的動態權重）
  -- 格式: {distance: 0.20, eta: 0.20, earnings_balance: 0.20, ...}
  weight_config JSONB,

  -- 情境資訊（用於 ML 訓練）
  hour_of_day INTEGER,
  day_of_week INTEGER,
  weather VARCHAR(20),
  demand_level VARCHAR(20) CHECK (demand_level IN ('LOW', 'MEDIUM', 'HIGH', 'SURGE')),

  -- 結果追蹤
  accepted_by VARCHAR(50) REFERENCES drivers(driver_id),
  accepted_at TIMESTAMP,
  response_time_ms INTEGER,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_dispatch_logs_order_id ON dispatch_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_logs_dispatched_at ON dispatch_logs(dispatched_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_logs_hour ON dispatch_logs(hour_of_day, day_of_week);
CREATE INDEX IF NOT EXISTS idx_dispatch_logs_accepted_by ON dispatch_logs(accepted_by);

-- ============================================================
-- 2. 詳細拒單記錄表 (order_rejections)
-- 記錄每次拒單的詳細情境，用於 ML 模型訓練
-- ============================================================
CREATE TABLE IF NOT EXISTS order_rejections (
  rejection_id SERIAL PRIMARY KEY,
  order_id VARCHAR(50) NOT NULL REFERENCES orders(order_id),
  driver_id VARCHAR(50) NOT NULL REFERENCES drivers(driver_id),

  -- 拒單原因（必填，用於訓練）
  rejection_reason VARCHAR(50) NOT NULL CHECK (rejection_reason IN (
    'TOO_FAR',           -- 距離太遠
    'LOW_FARE',          -- 車資太低
    'UNWANTED_AREA',     -- 不想去該區域
    'OFF_DUTY',          -- 準備下班
    'BUSY',              -- 忙碌中
    'TIMEOUT',           -- 系統超時
    'OTHER'              -- 其他
  )),

  -- 訂單特徵（拒單時的情境 - ML 特徵）
  distance_to_pickup DECIMAL(8, 2),
  trip_distance DECIMAL(8, 2),
  estimated_fare INTEGER,
  hour_of_day INTEGER,
  day_of_week INTEGER,

  -- 司機當時狀態（ML 特徵）
  driver_today_earnings INTEGER,
  driver_today_trips INTEGER,
  driver_online_hours DECIMAL(5, 2),

  -- 回應時間
  offered_at TIMESTAMP,
  rejected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  response_time_ms INTEGER,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引（用於 ML 訓練查詢）
CREATE INDEX IF NOT EXISTS idx_rejections_driver_id ON order_rejections(driver_id);
CREATE INDEX IF NOT EXISTS idx_rejections_order_id ON order_rejections(order_id);
CREATE INDEX IF NOT EXISTS idx_rejections_hour ON order_rejections(hour_of_day, day_of_week);
CREATE INDEX IF NOT EXISTS idx_rejections_created ON order_rejections(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rejections_reason ON order_rejections(rejection_reason);

-- ============================================================
-- 3. 司機行為模式表 (driver_patterns)
-- 儲存計算好的司機行為特徵，用於即時預測
-- ============================================================
CREATE TABLE IF NOT EXISTS driver_patterns (
  pattern_id SERIAL PRIMARY KEY,
  driver_id VARCHAR(50) NOT NULL UNIQUE REFERENCES drivers(driver_id),

  -- 時段偏好（每個時段的接單率）
  -- 格式: {"0": 0.8, "1": 0.7, ..., "23": 0.9}
  hourly_acceptance JSONB DEFAULT '{}',

  -- 區域偏好（熱區接單率）
  -- 格式: {"東大門夜市": 0.95, "太魯閣": 0.6, "OTHER": 0.75}
  zone_acceptance JSONB DEFAULT '{}',

  -- 距離偏好
  avg_accepted_distance DECIMAL(8, 2) DEFAULT 3.0,
  max_accepted_distance DECIMAL(8, 2) DEFAULT 10.0,

  -- 訂單類型偏好
  short_trip_rate DECIMAL(5, 2) DEFAULT 80.00,   -- 短程訂單接受率 (<3km)
  medium_trip_rate DECIMAL(5, 2) DEFAULT 85.00,  -- 中程訂單接受率 (3-10km)
  long_trip_rate DECIMAL(5, 2) DEFAULT 70.00,    -- 長程訂單接受率 (>10km)

  -- 收入門檻（超過此收入後拒單率上升）
  earnings_threshold INTEGER DEFAULT 8500,

  -- 效率類型
  driver_type VARCHAR(30) DEFAULT 'HIGH_VOLUME' CHECK (driver_type IN (
    'FAST_TURNOVER',    -- 快速週轉型（適合短程）
    'LONG_DISTANCE',    -- 長距離專家型
    'HIGH_VOLUME'       -- 訂單量大型
  )),

  -- 統計資訊
  last_calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  data_points INTEGER DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_patterns_driver_id ON driver_patterns(driver_id);
CREATE INDEX IF NOT EXISTS idx_patterns_driver_type ON driver_patterns(driver_type);
CREATE INDEX IF NOT EXISTS idx_patterns_updated ON driver_patterns(last_calculated_at DESC);

-- 觸發器
CREATE TRIGGER update_driver_patterns_updated_at BEFORE UPDATE ON driver_patterns
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 4. ETA 快取表 (eta_cache)
-- 儲存 Google Distance Matrix API 結果，減少 API 調用
-- ============================================================
CREATE TABLE IF NOT EXISTS eta_cache (
  cache_id SERIAL PRIMARY KEY,

  -- 起點座標（四捨五入到小數點後 4 位，約 10 公尺精度）
  origin_lat DECIMAL(10, 4) NOT NULL,
  origin_lng DECIMAL(11, 4) NOT NULL,

  -- 終點座標
  dest_lat DECIMAL(10, 4) NOT NULL,
  dest_lng DECIMAL(11, 4) NOT NULL,

  -- 距離和時間
  distance_meters INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  duration_in_traffic_seconds INTEGER,

  -- 時段（同一條路線不同時段可能不同）
  hour_of_day INTEGER NOT NULL,

  -- 快取元資料
  cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '1 hour'),
  hit_count INTEGER DEFAULT 0,

  -- 複合唯一約束（起終點 + 時段）
  UNIQUE(origin_lat, origin_lng, dest_lat, dest_lng, hour_of_day)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_eta_cache_coords ON eta_cache(origin_lat, origin_lng, dest_lat, dest_lng);
CREATE INDEX IF NOT EXISTS idx_eta_cache_hour ON eta_cache(hour_of_day);
CREATE INDEX IF NOT EXISTS idx_eta_cache_expires ON eta_cache(expires_at);

-- ============================================================
-- 5. 修改現有表 - orders 新增欄位
-- ============================================================
DO $$
BEGIN
  -- 派單批次
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'dispatch_batch'
  ) THEN
    ALTER TABLE orders ADD COLUMN dispatch_batch INTEGER DEFAULT 1;
    RAISE NOTICE 'Added column: orders.dispatch_batch';
  END IF;

  -- 派單方式
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'dispatch_method'
  ) THEN
    ALTER TABLE orders ADD COLUMN dispatch_method VARCHAR(30) DEFAULT 'LAYERED';
    RAISE NOTICE 'Added column: orders.dispatch_method';
  END IF;

  -- 預估車資
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'estimated_fare'
  ) THEN
    ALTER TABLE orders ADD COLUMN estimated_fare INTEGER;
    RAISE NOTICE 'Added column: orders.estimated_fare';
  END IF;

  -- Google ETA
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'google_eta_seconds'
  ) THEN
    ALTER TABLE orders ADD COLUMN google_eta_seconds INTEGER;
    RAISE NOTICE 'Added column: orders.google_eta_seconds';
  END IF;

  -- 詳細取消原因
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'cancel_reason'
  ) THEN
    ALTER TABLE orders ADD COLUMN cancel_reason VARCHAR(255);
    RAISE NOTICE 'Added column: orders.cancel_reason';
  END IF;
END $$;

-- ============================================================
-- 6. 修改現有表 - drivers 新增欄位
-- ============================================================
DO $$
BEGIN
  -- 司機類型
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'driver_type'
  ) THEN
    ALTER TABLE drivers ADD COLUMN driver_type VARCHAR(30) DEFAULT 'HIGH_VOLUME';
    RAISE NOTICE 'Added column: drivers.driver_type';
  END IF;

  -- 偏好區域
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'preferred_zones'
  ) THEN
    ALTER TABLE drivers ADD COLUMN preferred_zones JSONB;
    RAISE NOTICE 'Added column: drivers.preferred_zones';
  END IF;

  -- 總拒單次數
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'total_rejections'
  ) THEN
    ALTER TABLE drivers ADD COLUMN total_rejections INTEGER DEFAULT 0;
    RAISE NOTICE 'Added column: drivers.total_rejections';
  END IF;
END $$;

-- ============================================================
-- 7. 清理過期 ETA 快取的函數
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_expired_eta_cache()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM eta_cache WHERE expires_at < CURRENT_TIMESTAMP;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 完成
-- ============================================================

-- ============================================================
-- 修復派單系統缺失表與欄位
-- 日期: 2026-03-09
-- 根因: driver_patterns 表與 dispatch_logs 部分欄位未建立
--       導致 SmartDispatcherV2 派單流程 crash → 訂單全部 CANCELLED
-- ============================================================

-- ============================================================
-- 1. 建立 driver_patterns 表（若不存在）
--    注意：必須使用完整 schema，與 RejectionPredictor.ts 查詢欄位對應
-- ============================================================
CREATE TABLE IF NOT EXISTS driver_patterns (
  pattern_id SERIAL PRIMARY KEY,
  driver_id VARCHAR(50) NOT NULL UNIQUE REFERENCES drivers(driver_id),

  -- 時段偏好（每個時段的接單率）
  -- 格式: {"0": 0.8, "1": 0.7, ..., "23": 0.9}
  hourly_acceptance JSONB DEFAULT '{}',

  -- 區域偏好
  zone_acceptance JSONB DEFAULT '{}',

  -- 距離偏好
  avg_accepted_distance DECIMAL(8, 2) DEFAULT 3.0,
  max_accepted_distance DECIMAL(8, 2) DEFAULT 10.0,

  -- 訂單類型偏好
  short_trip_rate DECIMAL(5, 2) DEFAULT 80.00,
  medium_trip_rate DECIMAL(5, 2) DEFAULT 85.00,
  long_trip_rate DECIMAL(5, 2) DEFAULT 70.00,

  -- 收入門檻（超過此收入後拒單率上升）
  earnings_threshold INTEGER DEFAULT 8500,

  -- 效率類型
  driver_type VARCHAR(30) DEFAULT 'HIGH_VOLUME' CHECK (driver_type IN (
    'FAST_TURNOVER',
    'LONG_DISTANCE',
    'HIGH_VOLUME'
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

-- 為現有司機插入預設資料（才能通過 UNIQUE REFERENCES 約束）
INSERT INTO driver_patterns (driver_id)
SELECT driver_id FROM drivers
ON CONFLICT (driver_id) DO NOTHING;

-- ============================================================
-- 2. 補 dispatch_logs 缺失欄位（若表已存在但欄位不完整）
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dispatch_logs' AND column_name = 'batch_number'
  ) THEN
    ALTER TABLE dispatch_logs ADD COLUMN batch_number INTEGER DEFAULT 1;
    RAISE NOTICE 'Added column: dispatch_logs.batch_number';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dispatch_logs' AND column_name = 'recommended_drivers'
  ) THEN
    ALTER TABLE dispatch_logs ADD COLUMN recommended_drivers JSONB;
    RAISE NOTICE 'Added column: dispatch_logs.recommended_drivers';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dispatch_logs' AND column_name = 'weight_config'
  ) THEN
    ALTER TABLE dispatch_logs ADD COLUMN weight_config JSONB;
    RAISE NOTICE 'Added column: dispatch_logs.weight_config';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dispatch_logs' AND column_name = 'hour_of_day'
  ) THEN
    ALTER TABLE dispatch_logs ADD COLUMN hour_of_day INTEGER;
    RAISE NOTICE 'Added column: dispatch_logs.hour_of_day';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dispatch_logs' AND column_name = 'day_of_week'
  ) THEN
    ALTER TABLE dispatch_logs ADD COLUMN day_of_week INTEGER;
    RAISE NOTICE 'Added column: dispatch_logs.day_of_week';
  END IF;
END $$;

-- ============================================================
-- 完成
-- ============================================================

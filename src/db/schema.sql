-- 花蓮計程車系統 - PostgreSQL Schema
-- 版本: 1.0.0
-- 日期: 2025-10-25

-- ============================================================
-- 1. 司機表 (drivers)
-- ============================================================
CREATE TABLE IF NOT EXISTS drivers (
  driver_id VARCHAR(50) PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  firebase_uid VARCHAR(255) UNIQUE,  -- Firebase Authentication UID
  name VARCHAR(100) NOT NULL,
  plate VARCHAR(20) NOT NULL,

  -- 司機狀態
  availability VARCHAR(20) DEFAULT 'OFFLINE' CHECK (availability IN ('OFFLINE', 'REST', 'AVAILABLE', 'ON_TRIP')),

  -- 當前位置（最後回報）
  current_lat DECIMAL(10, 8),
  current_lng DECIMAL(11, 8),
  last_heartbeat TIMESTAMP,

  -- 統計數據
  total_trips INTEGER DEFAULT 0,
  total_earnings INTEGER DEFAULT 0,
  rating DECIMAL(3, 2) DEFAULT 5.00,
  acceptance_rate DECIMAL(5, 2) DEFAULT 100.00,
  cancel_rate DECIMAL(5, 2) DEFAULT 0.00,

  -- 時間戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 2. 乘客表 (passengers)
-- ============================================================
CREATE TABLE IF NOT EXISTS passengers (
  passenger_id VARCHAR(50) PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  firebase_uid VARCHAR(255) UNIQUE,  -- Firebase Authentication UID
  name VARCHAR(100) NOT NULL,

  -- 統計數據
  total_rides INTEGER DEFAULT 0,
  total_spent INTEGER DEFAULT 0,
  rating DECIMAL(3, 2) DEFAULT 5.00,

  -- 時間戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 3. 訂單表 (orders) - AI 訓練的核心數據
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  order_id VARCHAR(50) PRIMARY KEY,
  passenger_id VARCHAR(50) REFERENCES passengers(passenger_id),
  driver_id VARCHAR(50) REFERENCES drivers(driver_id),

  -- 訂單狀態
  status VARCHAR(20) NOT NULL CHECK (status IN ('WAITING', 'OFFERED', 'ACCEPTED', 'ARRIVED', 'ON_TRIP', 'SETTLING', 'DONE', 'CANCELLED')),

  -- 上車點
  pickup_lat DECIMAL(10, 8) NOT NULL,
  pickup_lng DECIMAL(11, 8) NOT NULL,
  pickup_address TEXT NOT NULL,

  -- 目的地（可選）
  dest_lat DECIMAL(10, 8),
  dest_lng DECIMAL(11, 8),
  dest_address TEXT,

  -- 付款方式
  payment_type VARCHAR(30) DEFAULT 'CASH' CHECK (payment_type IN ('CASH', 'LOVE_CARD_PHYSICAL', 'OTHER')),

  -- 車資資訊
  meter_amount INTEGER,           -- 跳表金額（最權威）
  actual_distance_km DECIMAL(6, 2),
  actual_duration_min INTEGER,
  photo_url TEXT,                 -- 跳表照片 URL

  -- 時間追蹤（AI 關鍵特徵）
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,        -- 乘客叫車時間
  offered_at TIMESTAMP,                                   -- 推送給司機時間
  accepted_at TIMESTAMP,                                  -- 司機接單時間
  arrived_at TIMESTAMP,                                   -- 到達上車點時間
  started_at TIMESTAMP,                                   -- 開始行程時間
  completed_at TIMESTAMP,                                 -- 完成時間
  cancelled_at TIMESTAMP,                                 -- 取消時間

  -- AI 特徵（Phase 2）
  hour_of_day INTEGER,            -- 時段 (0-23)
  day_of_week INTEGER,            -- 星期 (0-6)
  is_holiday BOOLEAN DEFAULT FALSE,
  weather VARCHAR(20),            -- 天氣狀況

  -- 派單相關
  offered_to_count INTEGER DEFAULT 0,  -- 推送給多少位司機
  reject_count INTEGER DEFAULT 0,      -- 被拒絕次數

  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 4. 司機位置歷史表 (driver_locations) - 用於熱區分析
-- ============================================================
CREATE TABLE IF NOT EXISTS driver_locations (
  location_id SERIAL PRIMARY KEY,
  driver_id VARCHAR(50) REFERENCES drivers(driver_id),

  lat DECIMAL(10, 8) NOT NULL,
  lng DECIMAL(11, 8) NOT NULL,
  speed DECIMAL(5, 2) DEFAULT 0,     -- 速度 (km/h)
  bearing DECIMAL(5, 2),             -- 方向 (0-360度)

  -- 是否在執行訂單
  on_trip BOOLEAN DEFAULT FALSE,
  order_id VARCHAR(50) REFERENCES orders(order_id),

  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 5. 每日收入表 (daily_earnings)
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_earnings (
  earning_id SERIAL PRIMARY KEY,
  driver_id VARCHAR(50) REFERENCES drivers(driver_id),

  date DATE NOT NULL,

  total_trips INTEGER DEFAULT 0,
  total_earnings INTEGER DEFAULT 0,
  total_distance_km DECIMAL(8, 2) DEFAULT 0,
  total_duration_min INTEGER DEFAULT 0,

  online_hours DECIMAL(5, 2) DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(driver_id, date)
);

-- ============================================================
-- 索引優化
-- ============================================================

-- 訂單查詢優化
CREATE INDEX IF NOT EXISTS idx_orders_passenger_id ON orders(passenger_id);
CREATE INDEX IF NOT EXISTS idx_orders_driver_id ON orders(driver_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

-- 位置查詢優化
CREATE INDEX IF NOT EXISTS idx_driver_locations_driver_id ON driver_locations(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_locations_recorded_at ON driver_locations(recorded_at DESC);

-- 收入查詢優化
CREATE INDEX IF NOT EXISTS idx_daily_earnings_driver_date ON daily_earnings(driver_id, date DESC);

-- 乘客查詢優化
CREATE INDEX IF NOT EXISTS idx_passengers_phone ON passengers(phone);

-- 司機查詢優化
CREATE INDEX IF NOT EXISTS idx_drivers_phone ON drivers(phone);
CREATE INDEX IF NOT EXISTS idx_drivers_firebase_uid ON drivers(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_drivers_availability ON drivers(availability);

-- 乘客 Firebase UID 查詢優化
CREATE INDEX IF NOT EXISTS idx_passengers_firebase_uid ON passengers(firebase_uid);

-- ============================================================
-- 觸發器：自動更新 updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = CURRENT_TIMESTAMP;
   RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_drivers_updated_at BEFORE UPDATE ON drivers
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_passengers_updated_at BEFORE UPDATE ON passengers
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 完成
-- ============================================================

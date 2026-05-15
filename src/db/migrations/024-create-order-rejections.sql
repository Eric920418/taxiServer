-- ============================================
-- 024: 補建 order_rejections 表
--   migration 001 雖然有定義，但 prod schema 缺，
--   導致 SmartDispatcherV2:1527 拒單 INSERT 一直 throw + RejectionPredictor 訓練失敗
-- ============================================

CREATE TABLE IF NOT EXISTS order_rejections (
  rejection_id SERIAL PRIMARY KEY,
  order_id VARCHAR(50) NOT NULL REFERENCES orders(order_id),
  driver_id VARCHAR(50) NOT NULL REFERENCES drivers(driver_id),

  rejection_reason VARCHAR(50) NOT NULL CHECK (rejection_reason IN (
    'TOO_FAR', 'LOW_FARE', 'UNWANTED_AREA', 'OFF_DUTY', 'BUSY', 'TIMEOUT', 'OTHER'
  )),

  distance_to_pickup DECIMAL(8, 2),
  trip_distance DECIMAL(8, 2),
  estimated_fare INTEGER,
  hour_of_day INTEGER,
  day_of_week INTEGER,

  driver_today_earnings INTEGER,
  driver_today_trips INTEGER,
  driver_online_hours DECIMAL(5, 2),

  offered_at TIMESTAMP,
  rejected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  response_time_ms INTEGER,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rejections_driver_id ON order_rejections(driver_id);
CREATE INDEX IF NOT EXISTS idx_rejections_order_id ON order_rejections(order_id);
CREATE INDEX IF NOT EXISTS idx_rejections_hour ON order_rejections(hour_of_day, day_of_week);
CREATE INDEX IF NOT EXISTS idx_rejections_created ON order_rejections(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rejections_reason ON order_rejections(rejection_reason);

SELECT 'Migration 024-create-order-rejections completed' AS result;

-- 新增通知表 (notifications)
-- 日期: 2025-01-30

-- ============================================================
-- 通知表 (notifications) - 管理後台通知
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  notification_id SERIAL PRIMARY KEY,

  -- 通知類型
  type VARCHAR(20) NOT NULL CHECK (type IN ('info', 'warning', 'error', 'success')),
  category VARCHAR(20) NOT NULL CHECK (category IN ('order', 'driver', 'passenger', 'system')),

  -- 通知內容
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,

  -- 關聯資料（可選）
  related_id VARCHAR(50),  -- 可能是 order_id, driver_id, passenger_id 等
  link VARCHAR(255),       -- 跳轉連結

  -- 狀態
  is_read BOOLEAN DEFAULT FALSE,

  -- 時間戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引優化
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_category ON notifications(category);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);

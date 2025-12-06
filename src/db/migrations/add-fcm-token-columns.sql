-- 添加 FCM Token 相關欄位到 drivers 表
-- 執行時間: 2024-XX-XX

-- 添加 FCM Token 欄位
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS fcm_token TEXT;

-- 添加設備資訊欄位（JSON 格式）
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS device_info TEXT;

-- 添加 FCM Token 更新時間
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS fcm_updated_at TIMESTAMP;

-- 為乘客表也添加 FCM Token 支持
ALTER TABLE passengers ADD COLUMN IF NOT EXISTS fcm_token TEXT;
ALTER TABLE passengers ADD COLUMN IF NOT EXISTS device_info TEXT;
ALTER TABLE passengers ADD COLUMN IF NOT EXISTS fcm_updated_at TIMESTAMP;

-- 創建索引以便快速查詢有效 Token
CREATE INDEX IF NOT EXISTS idx_drivers_fcm_token ON drivers(fcm_token) WHERE fcm_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_passengers_fcm_token ON passengers(fcm_token) WHERE fcm_token IS NOT NULL;

-- 添加註解
COMMENT ON COLUMN drivers.fcm_token IS 'Firebase Cloud Messaging Token';
COMMENT ON COLUMN drivers.device_info IS '設備資訊 (JSON 格式: {model, os, version})';
COMMENT ON COLUMN drivers.fcm_updated_at IS 'FCM Token 最後更新時間';

COMMENT ON COLUMN passengers.fcm_token IS 'Firebase Cloud Messaging Token';
COMMENT ON COLUMN passengers.device_info IS '設備資訊 (JSON 格式)';
COMMENT ON COLUMN passengers.fcm_updated_at IS 'FCM Token 最後更新時間';

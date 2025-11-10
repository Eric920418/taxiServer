-- Migration: 改用 Firebase Phone Authentication
-- 日期: 2025-11-10
-- 用途: 移除密碼登入，改用 Firebase Phone Authentication

-- 1. 在 drivers 表中新增 firebase_uid 欄位
ALTER TABLE drivers
ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(255) UNIQUE;

-- 2. 在 passengers 表中新增 firebase_uid 欄位
ALTER TABLE passengers
ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(255) UNIQUE;

-- 3. 移除 drivers 表中的 password 欄位（不再需要密碼登入）
ALTER TABLE drivers
DROP COLUMN IF EXISTS password;

-- 4. 建立索引以加速查詢
CREATE INDEX IF NOT EXISTS idx_drivers_firebase_uid ON drivers(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_passengers_firebase_uid ON passengers(firebase_uid);

-- 完成
SELECT 'Migration completed: Password removed, Firebase UID added' AS status;

-- ============================================
-- 021: 修補既有 bug — code 引用但 DB 沒建的欄位
-- 1. drivers.fcm_token / device_info / fcm_updated_at（FCM 推播用）
-- 2. customer_notifications.phone_or_line_id（推播紀錄寫不進去 bug）
-- ============================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'fcm_token') THEN
    ALTER TABLE drivers ADD COLUMN fcm_token TEXT;
    COMMENT ON COLUMN drivers.fcm_token IS 'Firebase FCM token，給推播用';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'device_info') THEN
    ALTER TABLE drivers ADD COLUMN device_info TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'fcm_updated_at') THEN
    ALTER TABLE drivers ADD COLUMN fcm_updated_at TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_notifications')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_name = 'customer_notifications' AND column_name = 'phone_or_line_id') THEN
    ALTER TABLE customer_notifications ADD COLUMN phone_or_line_id VARCHAR(100);
  END IF;
END $$;

SELECT 'Migration 021-fix-missing-columns completed' AS result;

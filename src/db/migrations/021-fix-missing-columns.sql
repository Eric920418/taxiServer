-- ============================================
-- 021: 修補既有 bug — 補 code 引用但 DB 沒建的欄位
--
-- 1. drivers 表加 FCM 相關欄位（drivers.ts 引用但無 migration）
--    - fcm_token, device_info, fcm_updated_at
-- 2. customer_notifications 表加 phone_or_line_id
--    （CustomerNotificationService 寫入但無此欄位 → 推播紀錄一直寫不進去）
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
    COMMENT ON COLUMN drivers.device_info IS '司機裝置資訊（model/OS）';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'fcm_updated_at') THEN
    ALTER TABLE drivers ADD COLUMN fcm_updated_at TIMESTAMP;
  END IF;
END $$;

-- customer_notifications 加 phone_or_line_id（若該 table 存在）
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_notifications')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_name = 'customer_notifications' AND column_name = 'phone_or_line_id') THEN
    ALTER TABLE customer_notifications ADD COLUMN phone_or_line_id VARCHAR(100);
    COMMENT ON COLUMN customer_notifications.phone_or_line_id IS '通知接收方的電話或 LINE userId';
  END IF;
END $$;

SELECT 'Migration 021-fix-missing-columns completed' AS result;

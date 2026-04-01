-- ============================================
-- 007: 電話叫車人工審核機制 (NEEDS_REVIEW)
-- 擴展 phone_calls 狀態 + 新增審核欄位
-- ============================================

-- === 擴展 phone_calls.processing_status CHECK constraint ===
-- 新增: NEEDS_REVIEW, APPROVED, REJECTED

DO $$ BEGIN
  ALTER TABLE phone_calls DROP CONSTRAINT IF EXISTS phone_calls_processing_status_check;
  ALTER TABLE phone_calls ADD CONSTRAINT phone_calls_processing_status_check
    CHECK (processing_status IN (
      'RECEIVED', 'DOWNLOADING', 'TRANSCRIBING', 'PARSING',
      'PARSED', 'DISPATCHING', 'COMPLETED', 'FAILED', 'FOLLOW_UP',
      'NEEDS_REVIEW', 'APPROVED', 'REJECTED'
    ));
END $$;

-- === phone_calls 新增審核相關欄位（冪等）===

-- 審核者 admin ID
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'phone_calls' AND column_name = 'reviewed_by') THEN
    ALTER TABLE phone_calls ADD COLUMN reviewed_by VARCHAR(50);
  END IF;
END $$;

-- 審核時間
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'phone_calls' AND column_name = 'reviewed_at') THEN
    ALTER TABLE phone_calls ADD COLUMN reviewed_at TIMESTAMP;
  END IF;
END $$;

-- 審核動作: APPROVED / REJECTED
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'phone_calls' AND column_name = 'review_action') THEN
    ALTER TABLE phone_calls ADD COLUMN review_action VARCHAR(20);
  END IF;
END $$;

-- 審核備註
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'phone_calls' AND column_name = 'review_note') THEN
    ALTER TABLE phone_calls ADD COLUMN review_note TEXT;
  END IF;
END $$;

-- Operator 修改後的欄位
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'phone_calls' AND column_name = 'edited_fields') THEN
    ALTER TABLE phone_calls ADD COLUMN edited_fields JSONB;
  END IF;
END $$;

-- 事件分類信心度
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'phone_calls' AND column_name = 'event_confidence') THEN
    ALTER TABLE phone_calls ADD COLUMN event_confidence NUMERIC(3,2);
  END IF;
END $$;

-- 欄位提取信心度
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'phone_calls' AND column_name = 'field_confidence') THEN
    ALTER TABLE phone_calls ADD COLUMN field_confidence NUMERIC(3,2);
  END IF;
END $$;

-- === 擴展 notifications.category CHECK constraint ===
-- 新增: phone_call

DO $$ BEGIN
  ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
  ALTER TABLE notifications ADD CONSTRAINT notifications_category_check
    CHECK (category IN ('order', 'driver', 'passenger', 'system', 'phone_call'));
END $$;

-- 完成
SELECT 'Migration 007-needs-review completed successfully' AS result;

-- ============================================
-- 016: landmarks 加上車提示備註欄位（給客人看）
--
-- 用途：admin 為某些地點加註「請站在輪椅出入口等」「在 X 大門口」這類
--      具體上車位置指示。客人在 LINE 確認叫車前會看到提示並按一次「我知道了」
--      確保有讀過，才能進入下一步原本的 orderConfirmCard。
--
-- 設計原則：跟 address (派車用)、aliases (lookup 用) 完全獨立的欄位，
--      避免重蹈覆轍 — 之前 admin 把備註塞進 address 造成客人看到亂七八糟內容。
-- ============================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'landmarks' AND column_name = 'pickup_note') THEN
    ALTER TABLE landmarks ADD COLUMN pickup_note TEXT;
    COMMENT ON COLUMN landmarks.pickup_note IS '上車提示（給 LINE 客人看），例如「請至輪椅出入口等候」。NULL 表示無提示。';
  END IF;
END $$;

SELECT 'Migration 016-landmark-pickup-note completed' AS result;

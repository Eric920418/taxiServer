-- ============================================================
-- Migration 026: queue_zones 加 dispatch_mode 欄位
-- ============================================================
-- 動機：原本 queue zone 內的訂單會「批次推給所有 queue 司機，先按先贏」，
--      造成 #1 位司機反應慢就被 #2 搶走，違反公平排班精神。
--
-- SERIAL：嚴格排班順位 — 一次只推給隊伍最前面的司機，等 15 秒
--         沒接 / 拒絕 / 離線 / 載客中 → 自動跳下一位
-- PARALLEL：原本行為 — 批次推給多人，先按先贏
--
-- 預設 PARALLEL（向下相容，現有 zone 行為不變；admin 自行 per-zone 切到 SERIAL）
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'queue_zones' AND column_name = 'dispatch_mode'
  ) THEN
    ALTER TABLE queue_zones
      ADD COLUMN dispatch_mode VARCHAR(16) NOT NULL DEFAULT 'PARALLEL';

    ALTER TABLE queue_zones
      ADD CONSTRAINT queue_zones_dispatch_mode_check
      CHECK (dispatch_mode IN ('SERIAL', 'PARALLEL'));

    COMMENT ON COLUMN queue_zones.dispatch_mode IS
      'SERIAL: 嚴格排班順位（一次一人 15s）; PARALLEL: 批次推播（誰快誰拿）';

    RAISE NOTICE '✅ queue_zones.dispatch_mode 欄位已新增（預設 PARALLEL）';
  ELSE
    RAISE NOTICE 'queue_zones.dispatch_mode 已存在，跳過';
  END IF;
END $$;

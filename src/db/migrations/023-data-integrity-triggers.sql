-- ============================================
-- 023: 資料完整性 schema-level 強制
--   Layer 1 of「100% 防呆」三層策略
--
-- 解決 5/16 之前累積的結構性 bug：
--   1. 軟刪 landmark 後 aliases 殘留（占用 (alias, alias_type) unique key）
--      → 害 user 後續無法把同 alias 加到別的 landmark（silent fail）
--   2. 軟刪 partner 後 driver_partners 仍 active
--   3. 同名 landmark / partner 重複建立
-- ============================================

BEGIN;

-- ============================================
-- Phase 0: 先清理現有違規資料（不清的話加 unique constraint 會炸）
-- ============================================

-- 清孤兒 aliases（軟刪 landmark 的 aliases）
WITH cleared AS (
  DELETE FROM landmark_aliases
  WHERE landmark_id IN (SELECT id FROM landmarks WHERE deleted_at IS NOT NULL)
  RETURNING landmark_id
)
SELECT 'Cleaned orphan aliases: ' || count(*) AS result FROM cleared;

-- 清「停用 partner 但仍 active 的 driver_partners」
WITH fixed AS (
  UPDATE driver_partners SET is_active = false
  WHERE partner_id IN (SELECT partner_id FROM partners WHERE is_active = false)
    AND is_active = true
  RETURNING driver_id
)
SELECT 'Fixed inactive_partner_active_bindings: ' || count(*) AS result FROM fixed;

-- ============================================
-- Phase 1: Trigger — 軟刪 landmark 自動清 aliases
-- ============================================

CREATE OR REPLACE FUNCTION cascade_clear_landmark_aliases_on_soft_delete()
RETURNS TRIGGER AS $$
DECLARE
  cleared_count INT;
BEGIN
  -- 只在 deleted_at 從 NULL 變非 NULL 時觸發（避免普通 UPDATE 也跑）
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    DELETE FROM landmark_aliases WHERE landmark_id = NEW.id;
    GET DIAGNOSTICS cleared_count = ROW_COUNT;
    IF cleared_count > 0 THEN
      RAISE NOTICE '[Trigger] 軟刪 landmark id=% (name=%) → 清 % 個 aliases', NEW.id, NEW.name, cleared_count;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cascade_clear_landmark_aliases ON landmarks;
CREATE TRIGGER trg_cascade_clear_landmark_aliases
  AFTER UPDATE ON landmarks FOR EACH ROW
  EXECUTE FUNCTION cascade_clear_landmark_aliases_on_soft_delete();

-- ============================================
-- Phase 2: Trigger — partner 停用時 cascade deactivate driver_partners
-- ============================================

CREATE OR REPLACE FUNCTION cascade_deactivate_driver_partners_on_partner_inactive()
RETURNS TRIGGER AS $$
DECLARE
  fixed_count INT;
BEGIN
  IF OLD.is_active = true AND NEW.is_active = false THEN
    UPDATE driver_partners SET is_active = false
    WHERE partner_id = NEW.partner_id AND is_active = true;
    GET DIAGNOSTICS fixed_count = ROW_COUNT;
    IF fixed_count > 0 THEN
      RAISE NOTICE '[Trigger] 停用 partner % (name=%) → 解除 % 個 driver bindings', NEW.partner_id, NEW.name, fixed_count;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cascade_partner_inactive ON partners;
CREATE TRIGGER trg_cascade_partner_inactive
  AFTER UPDATE ON partners FOR EACH ROW
  EXECUTE FUNCTION cascade_deactivate_driver_partners_on_partner_inactive();

-- ============================================
-- Phase 3: Partial unique — 同名 landmark 只能一個 active
--   (deleted_at IS NULL 才檢查；軟刪的可重用名)
-- ============================================

-- 既有 landmarks_name_key 是 UNIQUE 全表，跟 partial 衝突。改成 partial：
ALTER TABLE landmarks DROP CONSTRAINT IF EXISTS landmarks_name_key;
DROP INDEX IF EXISTS idx_landmarks_name_unique_active;
CREATE UNIQUE INDEX idx_landmarks_name_unique_active
  ON landmarks (name) WHERE deleted_at IS NULL;

COMMENT ON INDEX idx_landmarks_name_unique_active IS
  '同名 landmark 只能一個 active（deleted_at IS NULL），軟刪的可重用同名';

-- ============================================
-- Phase 4: Partial unique — 同名 partner 只能一個 active
-- ============================================

DROP INDEX IF EXISTS idx_partners_name_unique_active;
CREATE UNIQUE INDEX idx_partners_name_unique_active
  ON partners (name) WHERE is_active = true;

COMMENT ON INDEX idx_partners_name_unique_active IS
  '同名 partner 只能一個 active；停用的可重用同名';

COMMIT;

SELECT 'Migration 023-data-integrity-triggers completed' AS result;

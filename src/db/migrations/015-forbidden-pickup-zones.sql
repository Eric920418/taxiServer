-- ============================================
-- 015: 禁止上車區（landmarks 擴充）
--
-- 用途：花蓮火車站等地點實際上禁止計程車載客，但客人會自然叫車到那邊。
--      系統需偵測並引導客人改選附近合法上車點。
--
-- schema 改動：
--   - landmarks.is_forbidden_pickup BOOLEAN — 是否禁止上車
--   - landmarks.alternative_pickup_landmark_ids INTEGER[] — 替代上車點 ID 陣列
--
-- 實際 seed 由 scripts/seed-forbidden-pickup-zones.ts 跑（依賴 Google API key）
-- ============================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'landmarks' AND column_name = 'is_forbidden_pickup') THEN
    ALTER TABLE landmarks ADD COLUMN is_forbidden_pickup BOOLEAN DEFAULT false;
    COMMENT ON COLUMN landmarks.is_forbidden_pickup IS '是否禁止計程車於此地點載客（例花蓮火車站）';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'landmarks' AND column_name = 'alternative_pickup_landmark_ids') THEN
    ALTER TABLE landmarks ADD COLUMN alternative_pickup_landmark_ids INTEGER[] DEFAULT '{}'::int[];
    COMMENT ON COLUMN landmarks.alternative_pickup_landmark_ids IS '禁止上車地點的替代上車點 landmark.id 陣列';
  END IF;
END $$;

-- 部分索引：只索引被禁止的地點（量極少，O(1) 查詢）
CREATE INDEX IF NOT EXISTS idx_landmarks_forbidden_pickup
  ON landmarks(is_forbidden_pickup) WHERE is_forbidden_pickup = true;

SELECT 'Migration 015-forbidden-pickup-zones completed' AS result;

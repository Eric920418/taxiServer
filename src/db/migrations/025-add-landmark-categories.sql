-- ============================================
-- 025: landmarks.category 加 NIGHTLIFE / FOOD 兩個新類別
--   PostgreSQL CHECK constraint 不能直接 ADD VALUE，要 DROP + RE-ADD
-- ============================================

BEGIN;

ALTER TABLE landmarks DROP CONSTRAINT IF EXISTS landmarks_category_check;

ALTER TABLE landmarks ADD CONSTRAINT landmarks_category_check
  CHECK (category IN (
    'TRANSPORT',
    'MEDICAL',
    'SCHOOL',
    'COMMERCIAL',
    'GOVERNMENT',
    'ATTRACTION',
    'HOTEL',
    'TOWNSHIP',
    'NIGHTLIFE',
    'FOOD'
  ));

COMMIT;

SELECT 'Migration 025-add-landmark-categories completed' AS result;

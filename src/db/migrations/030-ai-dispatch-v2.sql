-- ============================================
-- 030: 電話叫車 v2 — AI 對話強化 + 預約派車 + 號碼遮蔽
-- ============================================
-- 全部為「加欄位 / 放寬約束」，不刪不覆蓋既有資料（禁 accept-data-loss）。
-- 冪等：可重複執行（IF NOT EXISTS / DROP CONSTRAINT IF EXISTS 後再 ADD）。
--
-- 線上實況（2026-06-24 查證）：
--   orders_status_check  = WAITING,PENDING,OFFERED,ACCEPTED,ARRIVED,ON_TRIP,SETTLING,DONE,CANCELLED（無 SCHEDULED）
--   orders_payment_type_check = CASH,LOVE_CARD_PHYSICAL,OTHER（無 CREDIT_CARD）
--   現有資料 status∈{CANCELLED,DONE,SETTLING,WAITING}、payment∈{CASH,LOVE_CARD_PHYSICAL} → 加值為超集，現有列不違反。

-- 1) 司機能力欄位：刷卡 / 無障礙 ----------------------------------
--    刷卡預設 TRUE（多數車可刷；ops 再把純收現的車設 FALSE，避免上線首日刷卡單全派不到車）
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS can_credit_card BOOLEAN DEFAULT TRUE;
--    無障礙/輪椅車稀少，預設 FALSE，由 ops 標出少數幾台
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS can_wheelchair BOOLEAN DEFAULT FALSE;

-- 2) 訂單特殊需求欄位 --------------------------------------------
--    統一的特殊需求備註（給司機看；取代散落的 transcript/pet_note）
ALTER TABLE orders ADD COLUMN IF NOT EXISTS special_notes TEXT;
--    本單是否需要無障礙車（派車時篩 drivers.can_wheelchair）
ALTER TABLE orders ADD COLUMN IF NOT EXISTS needs_wheelchair BOOLEAN DEFAULT FALSE;

-- 3) payment_type 放寬：加 CREDIT_CARD（刷卡）---------------------
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_type_check
  CHECK (payment_type IN ('CASH', 'CREDIT_CARD', 'LOVE_CARD_PHYSICAL', 'OTHER'));

-- 4) status 放寬：加 SCHEDULED（未到時間的預約單）----------------
--    含既有全部值（含線上已有的 PENDING）+ 新增 SCHEDULED。
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'WAITING', 'PENDING', 'OFFERED', 'ACCEPTED', 'ARRIVED',
    'ON_TRIP', 'SETTLING', 'DONE', 'CANCELLED', 'SCHEDULED'
  ));

-- 預約單掃描用的索引：006 已建 idx_orders_scheduled(scheduled_at) WHERE scheduled_at IS NOT NULL，沿用即可。

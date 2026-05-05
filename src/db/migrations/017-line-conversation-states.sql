-- ============================================
-- 017: line_users.conversation_state CHECK 加新 states
--
-- 起因：2026-05-05 新增「pickup 提示確認」+「付款方式選擇」兩段對話流程，
--      新 state AWAITING_PICKUP_NOTE_ACK / AWAITING_PAYMENT 不在 006 的
--      CHECK 白名單 → DB reject → silent fail（LINE 客人沒收到任何回應）。
--
-- 修法：DROP 舊 constraint，ADD 含新 states 的新 constraint。冪等寫法
--      （DROP IF EXISTS）讓重跑不炸。
-- ============================================

ALTER TABLE line_users DROP CONSTRAINT IF EXISTS line_users_conversation_state_check;

ALTER TABLE line_users ADD CONSTRAINT line_users_conversation_state_check
  CHECK (conversation_state IN (
    'IDLE',
    'AWAITING_PICKUP',
    'AWAITING_DESTINATION',
    'AWAITING_CONFIRM',
    'AWAITING_SCHEDULE_TIME',
    'AWAITING_SCHEDULE_CONFIRM',
    'AWAITING_CANCEL_CONFIRM',
    'AWAITING_PICKUP_NOTE_ACK',  -- 2026-05-05 新增：pickup 提示強制確認
    'AWAITING_PAYMENT'            -- 2026-05-05 新增：付款方式選擇
  ));

SELECT 'Migration 017-line-conversation-states completed' AS result;

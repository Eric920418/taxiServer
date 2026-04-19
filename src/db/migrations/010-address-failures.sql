-- ============================================================
-- Migration 010: 地址匹配失敗佇列
--
-- 目的：當 HualienAddressDB.lookup() 回 null 或 confidence < 0.7 時記錄，
--      讓 Admin 在「待補齊地標」頁面看到需要補的項目。
-- ============================================================

CREATE TABLE IF NOT EXISTS address_lookup_failures (
  id SERIAL PRIMARY KEY,
  query TEXT NOT NULL,                              -- 原始輸入文字
  normalized TEXT NOT NULL,                         -- 正規化後（用於去重）
  source VARCHAR(10) NOT NULL,                      -- LINE / PHONE / APP_VOICE
  best_match JSONB,                                 -- lookup() 的最佳結果（可能 confidence 低）
  google_result JSONB,                              -- Google Geocoding/Places 補救結果
  final_coords JSONB,                               -- 乘客/司機最終確認的座標
  hit_count INTEGER DEFAULT 1,
  first_seen_at TIMESTAMP DEFAULT NOW(),
  last_seen_at TIMESTAMP DEFAULT NOW(),
  resolved_landmark_id INTEGER REFERENCES landmarks(id) ON DELETE SET NULL,
  resolved_at TIMESTAMP,
  resolved_by VARCHAR(50) REFERENCES admins(admin_id),
  dismissed_at TIMESTAMP,                            -- Admin 手動忽略（非地標，例如垃圾輸入）

  CONSTRAINT address_failures_source_check CHECK (source IN ('LINE','PHONE','APP_VOICE')),
  CONSTRAINT address_failures_unique UNIQUE (normalized, source)
);

CREATE INDEX IF NOT EXISTS idx_address_failures_hit_count ON address_lookup_failures(hit_count DESC);
CREATE INDEX IF NOT EXISTS idx_address_failures_last_seen ON address_lookup_failures(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_address_failures_unresolved
  ON address_lookup_failures(resolved_landmark_id, dismissed_at)
  WHERE resolved_landmark_id IS NULL AND dismissed_at IS NULL;

SELECT 'Migration 010 address_lookup_failures 建立完成' AS message;

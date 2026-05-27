-- ============================================
-- 029: 家屬聯防 — 模組 5 of「長輩 LINE 叫車 roadmap」
-- ============================================
--
-- 決策 (2026-05-26)：
--   - 綁定方式：長輩產 QR code，家屬掃碼確認綁定
--   - SOS 觸發：兩種 cancel (司機立即取消 + 5min 自動取消) 都推
--   - Rate limit：同長輩 24h 最多推 1 次 SOS（避免家屬被轟）
--   - 不鎖定下次叫車（避免獨居老人急診情境的 safety risk）

-- 家屬聯絡人
CREATE TABLE IF NOT EXISTS passenger_family_contacts (
  id SERIAL PRIMARY KEY,
  passenger_id VARCHAR(50) NOT NULL REFERENCES passengers(passenger_id) ON DELETE CASCADE,

  -- 家屬的 LINE userId（不一定在 line_users 表中、所以不設 FK）
  line_user_id VARCHAR(50) NOT NULL,
  display_name VARCHAR(100),

  -- 兒子 / 女兒 / 配偶 / 朋友 / 其他
  relation VARCHAR(30) NOT NULL,

  -- 主要聯絡人（給 SOS Push 用，未來可推給多個）
  is_primary BOOLEAN DEFAULT FALSE,

  -- 上次推 SOS 給此家屬的時間（rate limit 用，24h 最多 1 次）
  last_sos_sent_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- 同一家屬不能被同一長輩綁兩次
  UNIQUE(passenger_id, line_user_id)
);

CREATE INDEX IF NOT EXISTS idx_pfc_passenger ON passenger_family_contacts(passenger_id);
CREATE INDEX IF NOT EXISTS idx_pfc_line_user ON passenger_family_contacts(line_user_id);
CREATE INDEX IF NOT EXISTS idx_pfc_primary ON passenger_family_contacts(passenger_id) WHERE is_primary = TRUE;

-- 綁定 token（QR 一次性、短暫有效期）
CREATE TABLE IF NOT EXISTS passenger_family_bind_tokens (
  token VARCHAR(40) PRIMARY KEY,
  passenger_id VARCHAR(50) NOT NULL REFERENCES passengers(passenger_id) ON DELETE CASCADE,

  -- token 預設 5 分鐘失效（client 端決定）
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  used_by_line_user_id VARCHAR(50),  -- 哪位家屬綁的

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pfbt_passenger ON passenger_family_bind_tokens(passenger_id);
CREATE INDEX IF NOT EXISTS idx_pfbt_expires ON passenger_family_bind_tokens(expires_at);

-- 加 PIPA 同意時戳到 passengers（長輩在 LIFF 首次新增家屬時 timestamp）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'passengers' AND column_name = 'pipa_family_consent_at') THEN
    ALTER TABLE passengers ADD COLUMN pipa_family_consent_at TIMESTAMP;
  END IF;
END $$;

-- updated_at 自動更新
CREATE OR REPLACE FUNCTION update_pfc_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_pfc_updated_at') THEN
    CREATE TRIGGER tr_pfc_updated_at
      BEFORE UPDATE ON passenger_family_contacts
      FOR EACH ROW EXECUTE FUNCTION update_pfc_timestamp();
  END IF;
END $$;

-- ============================================================
-- Migration 009: 地標管理系統
--
-- 目的：把原本 hardcoded 在 HualienAddressDB.ts 的 98 筆地標搬到 DB，
--      讓 Admin Panel 可動態新增/編輯，Server 與 App 皆從 DB 同步。
--
-- 相關：README.md「地標管理」章節、src/services/HualienAddressDB.ts
-- ============================================================

-- ------------------------------------------------------------
-- 1. 地標主表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS landmarks (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,                   -- 正式全名
  lat DECIMAL(10, 8) NOT NULL,
  lng DECIMAL(11, 8) NOT NULL,
  address TEXT NOT NULL,
  category VARCHAR(20) NOT NULL,
  district VARCHAR(50) NOT NULL,
  priority SMALLINT NOT NULL DEFAULT 5,

  -- App 端獨有：司機停靠點（車站/醫院才會有）
  dropoff_lat DECIMAL(10, 8),
  dropoff_lng DECIMAL(11, 8),
  dropoff_address TEXT,

  -- 審計
  created_by VARCHAR(50) REFERENCES admins(admin_id),
  updated_by VARCHAR(50) REFERENCES admins(admin_id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,                                -- NULL = 啟用；非 NULL = 軟刪除

  CONSTRAINT landmarks_category_check CHECK (category IN
    ('TRANSPORT','MEDICAL','SCHOOL','COMMERCIAL',
     'GOVERNMENT','ATTRACTION','HOTEL','TOWNSHIP')),
  CONSTRAINT landmarks_priority_check CHECK (priority BETWEEN 0 AND 10),
  -- 花蓮縣地理圍籬：23.0980°N-24.5°N, 121.0°E-121.9°E（寬容邊界）
  CONSTRAINT landmarks_lat_bounds CHECK (lat BETWEEN 23.0 AND 24.6),
  CONSTRAINT landmarks_lng_bounds CHECK (lng BETWEEN 121.0 AND 122.0)
);

CREATE INDEX IF NOT EXISTS idx_landmarks_active ON landmarks(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_landmarks_district ON landmarks(district);
CREATE INDEX IF NOT EXISTS idx_landmarks_category ON landmarks(category);
CREATE INDEX IF NOT EXISTS idx_landmarks_updated_at ON landmarks(updated_at DESC);

-- ------------------------------------------------------------
-- 2. 地標別名表（拆出方便 Admin 單別名 CRUD 與唯一性防重）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS landmark_aliases (
  id SERIAL PRIMARY KEY,
  landmark_id INTEGER NOT NULL REFERENCES landmarks(id) ON DELETE CASCADE,
  alias VARCHAR(100) NOT NULL,
  alias_type VARCHAR(10) NOT NULL,   -- ALIAS（一般俗稱）/ TAIGI（台語 Whisper 容錯）
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT landmark_aliases_type_check CHECK (alias_type IN ('ALIAS','TAIGI')),
  CONSTRAINT landmark_aliases_unique UNIQUE (alias, alias_type)
);

CREATE INDEX IF NOT EXISTS idx_landmark_aliases_landmark_id ON landmark_aliases(landmark_id);
CREATE INDEX IF NOT EXISTS idx_landmark_aliases_alias ON landmark_aliases(alias);

-- ------------------------------------------------------------
-- 3. 地標審計表（誰何時改了什麼，含 before/after JSON diff）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS landmark_audit (
  id SERIAL PRIMARY KEY,
  landmark_id INTEGER,                               -- 刪除後仍保留 id 記錄
  admin_id VARCHAR(50) REFERENCES admins(admin_id),
  action VARCHAR(20) NOT NULL,                       -- CREATE / UPDATE / DELETE / RESTORE
  before_data JSONB,                                 -- 改之前（CREATE 為 NULL）
  after_data JSONB,                                  -- 改之後（DELETE 為 NULL）
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT landmark_audit_action_check CHECK (action IN ('CREATE','UPDATE','DELETE','RESTORE'))
);

CREATE INDEX IF NOT EXISTS idx_landmark_audit_landmark_id ON landmark_audit(landmark_id);
CREATE INDEX IF NOT EXISTS idx_landmark_audit_created_at ON landmark_audit(created_at DESC);

-- ------------------------------------------------------------
-- 4. 自動更新 updated_at
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_landmarks_updated_at') THEN
    CREATE TRIGGER update_landmarks_updated_at BEFORE UPDATE ON landmarks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END$$;

-- ------------------------------------------------------------
-- 完成
-- ------------------------------------------------------------
SELECT 'Migration 009 landmarks 建立完成' AS message;

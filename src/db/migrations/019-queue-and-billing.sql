-- ============================================
-- 019: 跨車隊媒合平台基礎建設
--
-- 7 張新表：
--   1. partners                  合作對象（車隊/品牌/招募人，3 種類型同一抽象）
--   2. driver_partners           司機 ↔ partner N:N 關係（每角色 PRIMARY_FLEET/BRAND/RECRUITED_BY 各 1 筆）
--   3. commission_rules          彈性分潤規則（每 partner 可獨立設）
--   4. queue_zones               排班區（圓形：center + radius）
--   5. queue_entries             司機加入排班的紀錄
--   6. billing_snapshots         每訂單完成寫一筆（永久保留對帳基礎）
--   7. billing_distributions     一張單的 commission 拆給多 partner
--
-- drivers / orders 加欄位：
--   - drivers.max_acceptable_commission_pct  司機願意被抽 %（Queue 媒合條件）
--   - orders.commission_pct                  訂單實際抽成 %（決定派單範圍）
--   - orders.dispatch_type                   QUEUE / REGULAR
--   - orders.dispatched_from_zone            若 QUEUE，記哪個 zone
--
-- 設計原則：
--   - 派單完全不看 partner（跨車隊媒合）
--   - Partner 只在結算時用
--   - billing_snapshot ↔ distribution 1:N，永遠保留拆分歷史
-- ============================================

-- ============================================
-- 1. partners (合作對象)
-- ============================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'partners') THEN
    CREATE TABLE partners (
      partner_id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      type VARCHAR(20) NOT NULL CHECK (type IN ('FLEET', 'BRAND', 'RECRUITER')),
      parent_partner_id VARCHAR(50) REFERENCES partners(partner_id),
      contact_phone VARCHAR(20),
      contact_name VARCHAR(50),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_partners_type ON partners(type) WHERE is_active = true;
    COMMENT ON TABLE partners IS '合作對象：車隊（FLEET）/ 品牌（BRAND）/ 招募人（RECRUITER）';
    COMMENT ON COLUMN partners.parent_partner_id IS '若是子合作對象（招募人下成立車隊）的上層引用';
  END IF;
END $$;

-- ============================================
-- 2. driver_partners (司機 ↔ partner N:N)
-- ============================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'driver_partners') THEN
    CREATE TABLE driver_partners (
      driver_id VARCHAR(50) NOT NULL REFERENCES drivers(driver_id),
      partner_id VARCHAR(50) NOT NULL REFERENCES partners(partner_id),
      relationship_type VARCHAR(20) NOT NULL
        CHECK (relationship_type IN ('PRIMARY_FLEET', 'BRAND', 'RECRUITED_BY')),
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN DEFAULT true,
      PRIMARY KEY (driver_id, relationship_type)
    );
    CREATE INDEX idx_driver_partners_partner ON driver_partners(partner_id) WHERE is_active = true;
    COMMENT ON TABLE driver_partners IS '司機與合作對象的關係。每個 relationship_type 每司機僅一筆（PRIMARY_FLEET/BRAND/RECRUITED_BY 各最多 1 個 partner）';
  END IF;
END $$;

-- ============================================
-- 3. commission_rules (分潤規則)
-- ============================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'commission_rules') THEN
    CREATE TABLE commission_rules (
      rule_id BIGSERIAL PRIMARY KEY,
      partner_id VARCHAR(50) NOT NULL REFERENCES partners(partner_id),
      rule_type VARCHAR(20) NOT NULL CHECK (rule_type IN ('FIXED_PER_ORDER', 'PERCENTAGE')),
      amount NUMERIC(10,2) NOT NULL,
      effective_from TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      effective_to TIMESTAMP,
      is_active BOOLEAN DEFAULT true,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_commission_partner_active ON commission_rules(partner_id, effective_from)
      WHERE is_active = true;
    COMMENT ON TABLE commission_rules IS '分潤規則：每 partner 可獨立設 FIXED_PER_ORDER 或 PERCENTAGE';
  END IF;
END $$;

-- ============================================
-- 4. queue_zones (排班區)
-- ============================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'queue_zones') THEN
    CREATE TABLE queue_zones (
      zone_id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      center_lat DECIMAL(10,7) NOT NULL,
      center_lng DECIMAL(10,7) NOT NULL,
      radius_meters INT NOT NULL DEFAULT 300,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_queue_zones_active ON queue_zones(is_active) WHERE is_active = true;
    COMMENT ON TABLE queue_zones IS '排班區：圓形範圍（中心 + 半徑公尺）';
  END IF;
END $$;

-- ============================================
-- 5. queue_entries (排班記錄)
-- ============================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'queue_entries') THEN
    CREATE TABLE queue_entries (
      entry_id BIGSERIAL PRIMARY KEY,
      driver_id VARCHAR(50) NOT NULL REFERENCES drivers(driver_id),
      zone_id VARCHAR(50) NOT NULL REFERENCES queue_zones(zone_id),
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      max_acceptable_commission_pct INT DEFAULT 100,
      status VARCHAR(20) DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'LEFT', 'DISPATCHED', 'EXPIRED')),
      left_at TIMESTAMP,
      left_reason VARCHAR(50)
    );
    CREATE UNIQUE INDEX idx_queue_one_active_per_driver ON queue_entries(driver_id)
      WHERE status = 'ACTIVE';
    CREATE INDEX idx_queue_zone_active ON queue_entries(zone_id, joined_at)
      WHERE status = 'ACTIVE';
    COMMENT ON TABLE queue_entries IS '排班 entries。一司機同時只能在一個 ACTIVE 排班';
  END IF;
END $$;

-- ============================================
-- 6. billing_snapshots (帳務快照)
-- ============================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'billing_snapshots') THEN
    CREATE TABLE billing_snapshots (
      snapshot_id BIGSERIAL PRIMARY KEY,
      order_id VARCHAR(50) UNIQUE NOT NULL,
      driver_id VARCHAR(50) NOT NULL,
      source VARCHAR(20) NOT NULL,
      fare INT NOT NULL,
      commission_pct INT DEFAULT 0,
      total_commission_amount NUMERIC(10,2) DEFAULT 0,
      driver_net NUMERIC(10,2) NOT NULL,
      dispatch_type VARCHAR(20) NOT NULL CHECK (dispatch_type IN ('QUEUE', 'REGULAR')),
      zone_id VARCHAR(50) REFERENCES queue_zones(zone_id),
      completed_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_billing_driver_month ON billing_snapshots(driver_id, completed_at DESC);
    COMMENT ON TABLE billing_snapshots IS '每訂單完成寫一筆，永久保留對帳基礎';
  END IF;
END $$;

-- ============================================
-- 7. billing_distributions (帳務拆分)
-- ============================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'billing_distributions') THEN
    CREATE TABLE billing_distributions (
      distribution_id BIGSERIAL PRIMARY KEY,
      snapshot_id BIGINT NOT NULL REFERENCES billing_snapshots(snapshot_id) ON DELETE CASCADE,
      partner_id VARCHAR(50) REFERENCES partners(partner_id),
      partner_role VARCHAR(20) NOT NULL CHECK (partner_role IN ('PLATFORM', 'FLEET', 'BRAND', 'RECRUITER')),
      amount NUMERIC(10,2) NOT NULL,
      rule_id_used BIGINT REFERENCES commission_rules(rule_id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_distrib_snapshot ON billing_distributions(snapshot_id);
    CREATE INDEX idx_distrib_partner_month ON billing_distributions(partner_id, created_at DESC);
    COMMENT ON TABLE billing_distributions IS '一張單的 commission 拆給多方。partner_id NULL = PLATFORM';
  END IF;
END $$;

-- ============================================
-- drivers + orders 加欄位
-- ============================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'max_acceptable_commission_pct') THEN
    ALTER TABLE drivers ADD COLUMN max_acceptable_commission_pct INT DEFAULT 100;
    COMMENT ON COLUMN drivers.max_acceptable_commission_pct IS '司機願意被抽最高 %，影響 Queue 媒合資格與排序';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'commission_pct') THEN
    ALTER TABLE orders ADD COLUMN commission_pct INT DEFAULT 0;
    COMMENT ON COLUMN orders.commission_pct IS '本訂單平台抽成百分比（決定可派給哪些司機）';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'dispatch_type') THEN
    ALTER TABLE orders ADD COLUMN dispatch_type VARCHAR(20) DEFAULT 'REGULAR';
    COMMENT ON COLUMN orders.dispatch_type IS 'QUEUE = 從排班隊派出 / REGULAR = 一般評分派遣';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'dispatched_from_zone') THEN
    ALTER TABLE orders ADD COLUMN dispatched_from_zone VARCHAR(50);
    COMMENT ON COLUMN orders.dispatched_from_zone IS '若 dispatch_type=QUEUE，記從哪個 zone 派出';
  END IF;
END $$;

SELECT 'Migration 019-queue-and-billing completed' AS result;

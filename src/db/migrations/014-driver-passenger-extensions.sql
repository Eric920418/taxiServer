-- ============================================
-- 014: 司機/乘客資料擴充 — Phase 1（資料模型基礎）
--
-- 改動摘要：
-- - drivers 加 證件日期 4 欄、證件照片 3 欄、班次 JSONB、車型容量
-- - passengers 加 黑名單 4 欄
-- - orders 加 乘客車型偏好
-- - 資料遷移：accepted_rebate_levels 5→10/15→20、driver_type HIGH_VOLUME→FULL_TIME/CONTRACT→COOPERATIVE
-- ============================================

-- ===== drivers 擴充 =====

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'registration_review_date') THEN
    ALTER TABLE drivers ADD COLUMN registration_review_date DATE;
    COMMENT ON COLUMN drivers.registration_review_date IS '計程車登記證審驗日';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'license_review_date') THEN
    ALTER TABLE drivers ADD COLUMN license_review_date DATE;
    COMMENT ON COLUMN drivers.license_review_date IS '駕照檢驗日';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'compulsory_insurance_expiry') THEN
    ALTER TABLE drivers ADD COLUMN compulsory_insurance_expiry DATE;
    COMMENT ON COLUMN drivers.compulsory_insurance_expiry IS '強制險到期日';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'voluntary_insurance_expiry') THEN
    ALTER TABLE drivers ADD COLUMN voluntary_insurance_expiry DATE;
    COMMENT ON COLUMN drivers.voluntary_insurance_expiry IS '任意險到期日';
  END IF;
END $$;

-- 證件照片 (base64 TEXT，先用此方案；未來 migrate to S3 再說)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'license_photo') THEN
    ALTER TABLE drivers ADD COLUMN license_photo TEXT;
    COMMENT ON COLUMN drivers.license_photo IS '駕照照片 base64 (data URI)';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'vehicle_registration_photo') THEN
    ALTER TABLE drivers ADD COLUMN vehicle_registration_photo TEXT;
    COMMENT ON COLUMN drivers.vehicle_registration_photo IS '行照照片 base64';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'contract_photo') THEN
    ALTER TABLE drivers ADD COLUMN contract_photo TEXT;
    COMMENT ON COLUMN drivers.contract_photo IS '合約書照片 base64';
  END IF;
END $$;

-- 班次 JSONB
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'shifts') THEN
    ALTER TABLE drivers ADD COLUMN shifts JSONB DEFAULT '[]'::jsonb;
    COMMENT ON COLUMN drivers.shifts IS '班次設定 [{shift_type,start,end,is_active}]';
  END IF;
END $$;

-- 車型容量
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'vehicle_capacity') THEN
    ALTER TABLE drivers ADD COLUMN vehicle_capacity VARCHAR(30);
    COMMENT ON COLUMN drivers.vehicle_capacity IS '車型容量 CAPACITY_4/5/6/8/WHEELCHAIR_VEHICLE';
  END IF;
END $$;

-- ===== passengers 黑名單 =====

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'passengers' AND column_name = 'is_blacklisted') THEN
    ALTER TABLE passengers ADD COLUMN is_blacklisted BOOLEAN DEFAULT false;
    COMMENT ON COLUMN passengers.is_blacklisted IS '是否為黑名單客戶（被禁止下單）';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'passengers' AND column_name = 'blacklist_reason') THEN
    ALTER TABLE passengers ADD COLUMN blacklist_reason TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'passengers' AND column_name = 'blacklisted_at') THEN
    ALTER TABLE passengers ADD COLUMN blacklisted_at TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'passengers' AND column_name = 'blacklisted_by') THEN
    ALTER TABLE passengers ADD COLUMN blacklisted_by VARCHAR(100);
    COMMENT ON COLUMN passengers.blacklisted_by IS '加入黑名單的管理員 username';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_passengers_blacklisted
  ON passengers(is_blacklisted) WHERE is_blacklisted = true;

-- ===== orders 乘客車型偏好 =====

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'preferred_vehicle_capacity') THEN
    ALTER TABLE orders ADD COLUMN preferred_vehicle_capacity VARCHAR(30);
    COMMENT ON COLUMN orders.preferred_vehicle_capacity IS '乘客指定車型 CAPACITY_4/5/6/8/WHEELCHAIR_VEHICLE';
  END IF;
END $$;

-- ===== 資料遷移 =====

-- accepted_rebate_levels: 5 → 10、15 → 20（向上四捨五入）
-- 用 unnest + DISTINCT 避免去重後仍重複
UPDATE drivers
SET accepted_rebate_levels = (
  SELECT ARRAY(
    SELECT DISTINCT
      CASE
        WHEN x = 5 THEN 10
        WHEN x = 15 THEN 20
        ELSE x
      END
    FROM unnest(accepted_rebate_levels) AS x
    ORDER BY 1
  )
)
WHERE accepted_rebate_levels && ARRAY[5, 15]::INTEGER[];

-- driver_type 重新命名
UPDATE drivers SET driver_type = 'FULL_TIME' WHERE driver_type = 'HIGH_VOLUME';
UPDATE drivers SET driver_type = 'COOPERATIVE' WHERE driver_type = 'CONTRACT';

-- ===== 完成 =====
SELECT 'Migration 014-driver-passenger-extensions completed' AS result;

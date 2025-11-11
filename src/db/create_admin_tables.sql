-- 建立管理員資料表
CREATE TABLE IF NOT EXISTS admins (
    admin_id VARCHAR(50) PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    role VARCHAR(20) NOT NULL DEFAULT 'operator',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,

    -- 角色限制
    CONSTRAINT valid_role CHECK (role IN ('super_admin', 'admin', 'operator'))
);

-- 建立索引
CREATE INDEX idx_admins_username ON admins(username);
CREATE INDEX idx_admins_email ON admins(email);
CREATE INDEX idx_admins_is_active ON admins(is_active);

-- 新增司機表格欄位（如果不存在）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'drivers' AND column_name = 'is_blocked') THEN
        ALTER TABLE drivers ADD COLUMN is_blocked BOOLEAN DEFAULT FALSE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'drivers' AND column_name = 'block_reason') THEN
        ALTER TABLE drivers ADD COLUMN block_reason TEXT;
    END IF;
END$$;

-- 新增乘客表格欄位（如果不存在）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'passengers' AND column_name = 'is_blocked') THEN
        ALTER TABLE passengers ADD COLUMN is_blocked BOOLEAN DEFAULT FALSE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'passengers' AND column_name = 'block_reason') THEN
        ALTER TABLE passengers ADD COLUMN block_reason TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'passengers' AND column_name = 'email') THEN
        ALTER TABLE passengers ADD COLUMN email VARCHAR(255);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'passengers' AND column_name = 'total_spent') THEN
        ALTER TABLE passengers ADD COLUMN total_spent DECIMAL(10,2) DEFAULT 0;
    END IF;
END$$;

-- 建立管理員操作記錄表（用於審計）
CREATE TABLE IF NOT EXISTS admin_logs (
    log_id SERIAL PRIMARY KEY,
    admin_id VARCHAR(50) NOT NULL,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50), -- 'driver', 'passenger', 'order', etc.
    target_id VARCHAR(50),
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (admin_id) REFERENCES admins(admin_id)
);

-- 建立索引
CREATE INDEX idx_admin_logs_admin_id ON admin_logs(admin_id);
CREATE INDEX idx_admin_logs_action ON admin_logs(action);
CREATE INDEX idx_admin_logs_created_at ON admin_logs(created_at);

-- 插入預設超級管理員（密碼：admin123）
-- 注意：這個密碼 hash 是使用 bcrypt 產生的
INSERT INTO admins (admin_id, username, password_hash, email, role, is_active)
VALUES (
    'ADMIN001',
    'admin',
    '$2b$10$JT/B12Oo0BJO..zrg6C5YutFWbw3zG1A3Izy1iRirFrGgdpwk4QEi', -- 密碼: admin123
    'admin@hualientaxi.com',
    'super_admin',
    TRUE
) ON CONFLICT (username) DO NOTHING;

-- 顯示建立結果
SELECT 'Admin tables created successfully' AS message;
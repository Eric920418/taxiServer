-- 新增評分表 (ratings)
-- 日期: 2025-11-25

-- ============================================================
-- 評分表 (ratings) - 司機/乘客互評
-- ============================================================
CREATE TABLE IF NOT EXISTS ratings (
  rating_id VARCHAR(50) PRIMARY KEY,
  order_id VARCHAR(50) REFERENCES orders(order_id),

  -- 評分來源
  from_type VARCHAR(20) NOT NULL CHECK (from_type IN ('driver', 'passenger')),
  from_id VARCHAR(50) NOT NULL,

  -- 評分對象
  to_type VARCHAR(20) NOT NULL CHECK (to_type IN ('driver', 'passenger')),
  to_id VARCHAR(50) NOT NULL,

  -- 評分內容
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,

  -- 時間戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引優化
CREATE INDEX IF NOT EXISTS idx_ratings_order_id ON ratings(order_id);
CREATE INDEX IF NOT EXISTS idx_ratings_from ON ratings(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_ratings_to ON ratings(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_ratings_created_at ON ratings(created_at DESC);

-- 唯一約束：同一個人對同一訂單只能評一次
CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_unique ON ratings(order_id, from_type, from_id);

-- 添加 email 欄位到 passengers 表（如果不存在）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'passengers' AND column_name = 'email'
  ) THEN
    ALTER TABLE passengers ADD COLUMN email VARCHAR(255);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'passengers' AND column_name = 'total_trips'
  ) THEN
    ALTER TABLE passengers ADD COLUMN total_trips INTEGER DEFAULT 0;
  END IF;
END $$;

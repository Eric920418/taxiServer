-- ============================================
-- 028: 司機「找不到客人」拍照存證 — 模組 4 of「長輩 LINE 叫車 roadmap」
-- ============================================
--
-- 流程：
--   1. 司機按「客人未到」→ v1.5.1 5 min 倒數
--   2. 倒數結束或司機立即取消 → Android client 跳 CameraCapture
--   3. 拍照（家門口 / 醫院門牌）→ 上傳 POST /api/orders/:id/no-show-evidence
--   4. Upload 成功後才執行 cancelNoShow API（client 強制順序）
--
-- 不做 wallet/補償費（決策 2026-05-26）— 純存證、給未來客訴 / 家屬 SOS 用

CREATE TABLE IF NOT EXISTS no_show_evidence (
  id SERIAL PRIMARY KEY,
  order_id VARCHAR(50) NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  driver_id VARCHAR(50) NOT NULL REFERENCES drivers(driver_id),

  -- HTTPS URL，例：https://api.hualientaxi.taxi/uploads/no_show/ORD1730000-1717834567.jpg
  photo_url TEXT NOT NULL,

  -- 拍照當下的司機 GPS（佐證真的在上車點等候）
  gps_lat NUMERIC(10, 6),
  gps_lng NUMERIC(10, 6),

  -- 司機等了多久才放棄（分鐘）
  waited_minutes INTEGER,

  -- 司機自填備註（選填，例「沒人應門」/「電話打不通」）
  notes VARCHAR(200),

  captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nse_order ON no_show_evidence(order_id);
CREATE INDEX IF NOT EXISTS idx_nse_driver ON no_show_evidence(driver_id);
CREATE INDEX IF NOT EXISTS idx_nse_captured ON no_show_evidence(captured_at DESC);

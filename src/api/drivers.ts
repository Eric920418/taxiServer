import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/connection';

const router = Router();

/**
 * 【已棄用】舊的帳號密碼登入 API
 * 請改用 POST /api/auth/phone-verify-driver
 */
router.post('/login', async (req: Request, res: Response) => {
  return res.status(410).json({
    error: 'DEPRECATED',
    message: '此 API 已停用，請改用 Firebase Phone Authentication',
    migrateTo: '/api/auth/phone-verify-driver'
  });
});

/**
 * 更新司機狀態
 * PATCH /api/drivers/:driverId/status
 */
router.patch('/:driverId/status', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const { availability } = req.body;

  console.log('[Status] 更新狀態:', { driverId, availability });

  try {
    // 驗證狀態值
    const validStatuses = ['OFFLINE', 'REST', 'AVAILABLE', 'ON_TRIP'];
    if (!validStatuses.includes(availability)) {
      return res.status(400).json({ error: '無效的狀態值' });
    }

    // 更新資料庫
    const result = await query(
      'UPDATE drivers SET availability = $1, last_heartbeat = CURRENT_TIMESTAMP WHERE driver_id = $2 RETURNING *',
      [availability, driverId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'DRIVER_NOT_FOUND' });
    }

    const driver = result.rows[0];

    res.json({
      driverId: driver.driver_id,
      name: driver.name,
      availability: driver.availability
    });
  } catch (error) {
    console.error('[Status] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 取得司機資訊
 * GET /api/drivers/:driverId
 */
router.get('/:driverId', async (req: Request, res: Response) => {
  const { driverId } = req.params;

  try {
    const driver = await queryOne(
      'SELECT * FROM drivers WHERE driver_id = $1',
      [driverId]
    );

    if (!driver) {
      return res.status(404).json({ error: 'DRIVER_NOT_FOUND' });
    }

    res.json({
      driverId: driver.driver_id,
      name: driver.name,
      phone: driver.phone,
      plate: driver.plate,
      availability: driver.availability,
      currentLocation: driver.current_lat && driver.current_lng ? {
        lat: parseFloat(driver.current_lat),
        lng: parseFloat(driver.current_lng)
      } : null,
      rating: parseFloat(driver.rating),
      totalTrips: driver.total_trips,
      totalEarnings: driver.total_earnings,
      acceptanceRate: parseFloat(driver.acceptance_rate)
    });
  } catch (error) {
    console.error('[Get Driver] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 更新司機位置
 * PATCH /api/drivers/:driverId/location
 */
router.patch('/:driverId/location', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const { lat, lng, speed, bearing } = req.body;

  try {
    // 更新司機當前位置
    await query(
      'UPDATE drivers SET current_lat = $1, current_lng = $2, last_heartbeat = CURRENT_TIMESTAMP WHERE driver_id = $3',
      [lat, lng, driverId]
    );

    // 記錄位置歷史（用於熱區分析）
    await query(
      'INSERT INTO driver_locations (driver_id, lat, lng, speed, bearing) VALUES ($1, $2, $3, $4, $5)',
      [driverId, lat, lng, speed || 0, bearing || 0]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('[Update Location] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;

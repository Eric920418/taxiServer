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

/**
 * 更新司機 FCM Token
 * PUT /api/drivers/:driverId/fcm-token
 */
router.put('/:driverId/fcm-token', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const { fcmToken, deviceInfo } = req.body;

  console.log('[FCM Token] 更新:', { driverId, tokenLength: fcmToken?.length });

  if (!fcmToken) {
    return res.status(400).json({
      success: false,
      error: 'FCM_TOKEN_REQUIRED',
      message: 'FCM Token 是必需的'
    });
  }

  try {
    // 更新司機的 FCM Token
    const result = await query(
      `UPDATE drivers
       SET fcm_token = $1,
           device_info = $2,
           fcm_updated_at = CURRENT_TIMESTAMP,
           last_heartbeat = CURRENT_TIMESTAMP
       WHERE driver_id = $3
       RETURNING driver_id, name, fcm_updated_at`,
      [fcmToken, deviceInfo || null, driverId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'DRIVER_NOT_FOUND',
        message: '找不到此司機'
      });
    }

    const driver = result.rows[0];

    console.log('[FCM Token] ✅ 更新成功:', driver.driver_id);

    res.json({
      success: true,
      message: 'FCM Token 更新成功',
      driverId: driver.driver_id,
      updatedAt: driver.fcm_updated_at
    });
  } catch (error) {
    console.error('[FCM Token] 錯誤:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: '伺服器錯誤'
    });
  }
});

/**
 * 刪除司機 FCM Token（登出時使用）
 * DELETE /api/drivers/:driverId/fcm-token
 */
router.delete('/:driverId/fcm-token', async (req: Request, res: Response) => {
  const { driverId } = req.params;

  console.log('[FCM Token] 刪除:', { driverId });

  try {
    const result = await query(
      `UPDATE drivers
       SET fcm_token = NULL,
           device_info = NULL,
           fcm_updated_at = NULL
       WHERE driver_id = $1
       RETURNING driver_id`,
      [driverId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'DRIVER_NOT_FOUND'
      });
    }

    console.log('[FCM Token] ✅ 刪除成功:', driverId);

    res.json({
      success: true,
      message: 'FCM Token 已刪除'
    });
  } catch (error) {
    console.error('[FCM Token] 刪除錯誤:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR'
    });
  }
});

export default router;

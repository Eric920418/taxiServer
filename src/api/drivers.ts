import { Router, Request, Response } from 'express';
import { query, queryOne, getPool } from '../db/connection';
import { getAutoAcceptService, AutoAcceptSettings } from '../services/AutoAcceptService';
import { RejectionPredictor } from '../services/RejectionPredictor';

const router = Router();

// 延遲初始化 AutoAcceptService（等待資料庫連接）
let autoAcceptService: ReturnType<typeof getAutoAcceptService> | null = null;
let rejectionPredictor: RejectionPredictor | null = null;

const getServiceInstance = () => {
  if (!autoAcceptService) {
    const pool = getPool();
    rejectionPredictor = new RejectionPredictor(pool);
    autoAcceptService = getAutoAcceptService(pool, rejectionPredictor);
  }
  return autoAcceptService;
};

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

// ============================================
// 自動接單設定 API
// ============================================

/**
 * 獲取司機自動接單設定
 * GET /api/drivers/:driverId/auto-accept-settings
 */
router.get('/:driverId/auto-accept-settings', async (req: Request, res: Response) => {
  const { driverId } = req.params;

  console.log('[AutoAccept] 獲取設定:', driverId);

  try {
    const service = getServiceInstance();
    const settings = await service.getSettings(driverId);

    res.json({
      success: true,
      settings: {
        enabled: settings.enabled,
        maxPickupDistanceKm: settings.maxPickupDistanceKm,
        minFareAmount: settings.minFareAmount,
        minTripDistanceKm: settings.minTripDistanceKm,
        activeHours: settings.activeHours,
        blacklistedZones: settings.blacklistedZones,
        smartModeEnabled: settings.smartModeEnabled,
        autoAcceptThreshold: settings.autoAcceptThreshold,
        dailyAutoAcceptLimit: settings.dailyAutoAcceptLimit,
        cooldownMinutes: settings.cooldownMinutes,
        consecutiveLimit: settings.consecutiveLimit,
      }
    });
  } catch (error) {
    console.error('[AutoAccept] 獲取設定錯誤:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: '獲取自動接單設定失敗'
    });
  }
});

/**
 * 更新司機自動接單設定
 * PUT /api/drivers/:driverId/auto-accept-settings
 */
router.put('/:driverId/auto-accept-settings', async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const updates = req.body;

  console.log('[AutoAccept] 更新設定:', { driverId, updates });

  try {
    // 驗證輸入
    const validUpdates: Partial<AutoAcceptSettings> = {};

    if (typeof updates.enabled === 'boolean') {
      validUpdates.enabled = updates.enabled;
    }
    if (typeof updates.maxPickupDistanceKm === 'number' && updates.maxPickupDistanceKm > 0) {
      validUpdates.maxPickupDistanceKm = Math.min(updates.maxPickupDistanceKm, 20);
    }
    if (typeof updates.minFareAmount === 'number' && updates.minFareAmount >= 0) {
      validUpdates.minFareAmount = updates.minFareAmount;
    }
    if (typeof updates.minTripDistanceKm === 'number' && updates.minTripDistanceKm >= 0) {
      validUpdates.minTripDistanceKm = updates.minTripDistanceKm;
    }
    if (Array.isArray(updates.activeHours)) {
      validUpdates.activeHours = updates.activeHours.filter(
        (h: any) => typeof h === 'number' && h >= 0 && h <= 23
      );
    }
    if (Array.isArray(updates.blacklistedZones)) {
      validUpdates.blacklistedZones = updates.blacklistedZones.filter(
        (z: any) => typeof z === 'string'
      );
    }
    if (typeof updates.smartModeEnabled === 'boolean') {
      validUpdates.smartModeEnabled = updates.smartModeEnabled;
    }
    if (typeof updates.autoAcceptThreshold === 'number') {
      validUpdates.autoAcceptThreshold = Math.max(0, Math.min(100, updates.autoAcceptThreshold));
    }
    if (typeof updates.dailyAutoAcceptLimit === 'number' && updates.dailyAutoAcceptLimit > 0) {
      validUpdates.dailyAutoAcceptLimit = Math.min(updates.dailyAutoAcceptLimit, 100);
    }
    if (typeof updates.cooldownMinutes === 'number' && updates.cooldownMinutes >= 0) {
      validUpdates.cooldownMinutes = Math.min(updates.cooldownMinutes, 30);
    }
    if (typeof updates.consecutiveLimit === 'number' && updates.consecutiveLimit > 0) {
      validUpdates.consecutiveLimit = Math.min(updates.consecutiveLimit, 20);
    }

    const service = getServiceInstance();
    const newSettings = await service.updateSettings(driverId, validUpdates);

    res.json({
      success: true,
      message: '自動接單設定已更新',
      settings: {
        enabled: newSettings.enabled,
        maxPickupDistanceKm: newSettings.maxPickupDistanceKm,
        minFareAmount: newSettings.minFareAmount,
        minTripDistanceKm: newSettings.minTripDistanceKm,
        activeHours: newSettings.activeHours,
        blacklistedZones: newSettings.blacklistedZones,
        smartModeEnabled: newSettings.smartModeEnabled,
        autoAcceptThreshold: newSettings.autoAcceptThreshold,
        dailyAutoAcceptLimit: newSettings.dailyAutoAcceptLimit,
        cooldownMinutes: newSettings.cooldownMinutes,
        consecutiveLimit: newSettings.consecutiveLimit,
      }
    });
  } catch (error) {
    console.error('[AutoAccept] 更新設定錯誤:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: '更新自動接單設定失敗'
    });
  }
});

/**
 * 獲取司機自動接單統計
 * GET /api/drivers/:driverId/auto-accept-stats
 */
router.get('/:driverId/auto-accept-stats', async (req: Request, res: Response) => {
  const { driverId } = req.params;

  console.log('[AutoAccept] 獲取統計:', driverId);

  try {
    const service = getServiceInstance();
    const stats = await service.getAutoAcceptStats(driverId);

    res.json({
      success: true,
      stats: {
        today: {
          autoAcceptCount: stats.today.autoAcceptCount,
          manualAcceptCount: stats.today.manualAcceptCount,
          blockedCount: stats.today.blockedCount,
          consecutiveAutoAccepts: stats.today.consecutiveAutoAccepts,
          lastAutoAcceptAt: stats.today.lastAutoAcceptAt?.toISOString() || null,
        },
        last7Days: {
          totalAutoAccepts: stats.last7Days.totalAutoAccepts,
          totalManual: stats.last7Days.totalManual,
          totalBlocked: stats.last7Days.totalBlocked,
          avgScore: Math.round(stats.last7Days.avgScore * 10) / 10,
          completionRate: Math.round(stats.last7Days.completionRate * 100),
        }
      }
    });
  } catch (error) {
    console.error('[AutoAccept] 獲取統計錯誤:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: '獲取自動接單統計失敗'
    });
  }
});

export default router;

/**
 * 配置 API
 * 提供動態配置的端點（Android 和 Admin 共用）
 */

import express from 'express';
import { fareConfigService, FareConfig } from '../services/FareConfigService';

const router = express.Router();

/**
 * GET /api/config/fare
 * 取得車資費率配置（巢狀結構：day / night / springFestival / loveCardSubsidyAmount）
 */
router.get('/fare', (req, res) => {
  try {
    const config = fareConfigService.getConfig();
    res.json({
      success: true,
      data: config,
    });
  } catch (error) {
    console.error('[Config] 取得費率配置失敗:', error);
    res.status(500).json({
      success: false,
      error: '取得費率配置失敗',
    });
  }
});

/**
 * PUT /api/config/fare
 * 更新車資費率配置（Admin 後台使用）
 * Body 為 Partial<FareConfig> — 巢狀結構，可只送要改的子組
 * 詳細驗證委派 FareConfigService.updateConfig()
 */
router.put('/fare', async (req, res) => {
  try {
    const updates: Partial<FareConfig> = {};
    if (req.body.day !== undefined) updates.day = req.body.day;
    if (req.body.night !== undefined) updates.night = req.body.night;
    if (req.body.springFestival !== undefined) updates.springFestival = req.body.springFestival;
    if (req.body.loveCardSubsidyAmount !== undefined) updates.loveCardSubsidyAmount = req.body.loveCardSubsidyAmount;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: '沒有提供要更新的欄位' });
    }

    const newConfig = await fareConfigService.updateConfig(updates);
    res.json({
      success: true,
      message: '費率配置已更新',
      data: newConfig,
    });
  } catch (error: any) {
    console.error('[Config] 更新費率配置失敗:', error);
    res.status(400).json({
      success: false,
      error: error?.message || '更新費率配置失敗',
    });
  }
});

/**
 * POST /api/config/fare/calculate
 * 計算車資（供測試用）
 *
 * Body:
 *   - distanceMeters: number (必填)
 *   - at?: ISO datetime string，例如 "2026-04-22T23:00:00+08:00"
 *          指定計算當下時間（用於驗證夜間 / 春節），未指定則用 server now
 *   - slowTrafficSeconds?: number 低速累積秒數，預設 0
 */
router.post('/fare/calculate', (req, res) => {
  try {
    const { distanceMeters, at, slowTrafficSeconds } = req.body;

    if (typeof distanceMeters !== 'number' || distanceMeters < 0) {
      return res.status(400).json({
        success: false,
        error: 'distanceMeters 必須是非負數字',
      });
    }

    let atDate: Date = new Date();
    if (at !== undefined) {
      const parsed = new Date(at);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'at 必須是合法的 ISO datetime 字串',
        });
      }
      atDate = parsed;
    }

    const slowSec = typeof slowTrafficSeconds === 'number' && slowTrafficSeconds >= 0
      ? slowTrafficSeconds
      : 0;

    const result = fareConfigService.calculateFare(distanceMeters, atDate, slowSec);
    res.json({
      success: true,
      data: {
        ...result,
        distanceKm: distanceMeters / 1000,
        at: atDate.toISOString(),
        slowTrafficSeconds: slowSec,
      },
    });
  } catch (error: any) {
    console.error('[Config] 計算車資失敗:', error);
    res.status(500).json({
      success: false,
      error: error?.message || '計算車資失敗',
    });
  }
});

export default router;

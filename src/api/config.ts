/**
 * 配置 API
 * 提供動態配置的端點（Android 和 Admin 共用）
 */

import express from 'express';
import { fareConfigService, FareConfig } from '../services/FareConfigService';

const router = express.Router();

/**
 * GET /api/config/fare
 * 取得車資費率配置
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
 */
router.put('/fare', async (req, res) => {
  try {
    const updates: Partial<FareConfig> = {};
    
    // 驗證並提取更新的欄位
    if (req.body.basePrice !== undefined) {
      const val = parseInt(req.body.basePrice);
      if (isNaN(val) || val < 0) {
        return res.status(400).json({ success: false, error: 'basePrice 必須是正整數' });
      }
      updates.basePrice = val;
    }
    
    if (req.body.baseDistanceMeters !== undefined) {
      const val = parseInt(req.body.baseDistanceMeters);
      if (isNaN(val) || val < 0) {
        return res.status(400).json({ success: false, error: 'baseDistanceMeters 必須是正整數' });
      }
      updates.baseDistanceMeters = val;
    }
    
    if (req.body.jumpDistanceMeters !== undefined) {
      const val = parseInt(req.body.jumpDistanceMeters);
      if (isNaN(val) || val <= 0) {
        return res.status(400).json({ success: false, error: 'jumpDistanceMeters 必須是正整數' });
      }
      updates.jumpDistanceMeters = val;
    }
    
    if (req.body.jumpPrice !== undefined) {
      const val = parseInt(req.body.jumpPrice);
      if (isNaN(val) || val < 0) {
        return res.status(400).json({ success: false, error: 'jumpPrice 必須是正整數' });
      }
      updates.jumpPrice = val;
    }
    
    if (req.body.nightSurchargeRate !== undefined) {
      const val = parseFloat(req.body.nightSurchargeRate);
      if (isNaN(val) || val < 0 || val > 1) {
        return res.status(400).json({ success: false, error: 'nightSurchargeRate 必須介於 0-1' });
      }
      updates.nightSurchargeRate = val;
    }
    
    if (req.body.nightStartHour !== undefined) {
      const val = parseInt(req.body.nightStartHour);
      if (isNaN(val) || val < 0 || val > 23) {
        return res.status(400).json({ success: false, error: 'nightStartHour 必須介於 0-23' });
      }
      updates.nightStartHour = val;
    }
    
    if (req.body.nightEndHour !== undefined) {
      const val = parseInt(req.body.nightEndHour);
      if (isNaN(val) || val < 0 || val > 23) {
        return res.status(400).json({ success: false, error: 'nightEndHour 必須介於 0-23' });
      }
      updates.nightEndHour = val;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: '沒有提供要更新的欄位' });
    }

    const newConfig = await fareConfigService.updateConfig(updates);
    
    res.json({
      success: true,
      message: '費率配置已更新',
      data: newConfig,
    });
  } catch (error) {
    console.error('[Config] 更新費率配置失敗:', error);
    res.status(500).json({
      success: false,
      error: '更新費率配置失敗',
    });
  }
});

/**
 * POST /api/config/fare/calculate
 * 計算車資（供測試用）
 */
router.post('/fare/calculate', (req, res) => {
  try {
    const { distanceMeters, isNightTime } = req.body;
    
    if (!distanceMeters || typeof distanceMeters !== 'number') {
      return res.status(400).json({
        success: false,
        error: 'distanceMeters 必須是數字',
      });
    }

    const result = fareConfigService.calculateFare(distanceMeters, isNightTime);
    res.json({
      success: true,
      data: {
        ...result,
        distanceKm: distanceMeters / 1000,
        isNightTime: isNightTime ?? false,
      },
    });
  } catch (error) {
    console.error('[Config] 計算車資失敗:', error);
    res.status(500).json({
      success: false,
      error: '計算車資失敗',
    });
  }
});

export default router;

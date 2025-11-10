import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/connection';

const router = Router();

/**
 * 手機號碼簡訊驗證登入（司機端）
 * POST /api/auth/phone-verify-driver
 *
 * 流程：
 * 1. 前端使用 Firebase Phone Auth 驗證手機號碼
 * 2. 驗證成功後，前端將 phone 與 firebaseUid 發送到此 API
 * 3. 後端檢查手機號碼是否已註冊為司機
 * 4. 返回司機完整資料
 */
router.post('/phone-verify-driver', async (req: Request, res: Response) => {
  const { phone, firebaseUid } = req.body;

  console.log('[Phone Auth] 司機端簡訊驗證登入:', { phone, firebaseUid });

  try {
    // 驗證輸入
    if (!phone || !firebaseUid) {
      return res.status(400).json({
        error: 'MISSING_FIELDS',
        message: '缺少手機號碼或 Firebase UID'
      });
    }

    // 從資料庫查找司機
    const driver = await queryOne(
      'SELECT * FROM drivers WHERE phone = $1',
      [phone]
    );

    if (!driver) {
      return res.status(404).json({
        error: 'DRIVER_NOT_FOUND',
        message: '此手機號碼尚未註冊為司機，請聯繫管理員'
      });
    }

    // 更新 Firebase UID（如果尚未設定）
    if (!driver.firebase_uid) {
      await query(
        'UPDATE drivers SET firebase_uid = $1 WHERE driver_id = $2',
        [firebaseUid, driver.driver_id]
      );
      console.log(`[Phone Auth] 更新司機 ${driver.driver_id} 的 Firebase UID`);
    }

    // 更新最後心跳時間
    await query(
      'UPDATE drivers SET last_heartbeat = CURRENT_TIMESTAMP WHERE driver_id = $1',
      [driver.driver_id]
    );

    // 登入成功
    console.log('[Phone Auth] 司機登入成功:', driver.name);

    res.json({
      success: true,
      token: `token_${driver.driver_id}_${Date.now()}`, // 簡易 token（實際應用 JWT）
      driverId: driver.driver_id,
      name: driver.name,
      phone: driver.phone,
      plate: driver.plate,
      availability: driver.availability,
      rating: parseFloat(driver.rating),
      totalTrips: driver.total_trips
    });
  } catch (error) {
    console.error('[Phone Auth] 司機端錯誤:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: '伺服器錯誤，請稍後再試'
    });
  }
});

/**
 * 手機號碼簡訊驗證登入（乘客端）
 * POST /api/auth/phone-verify-passenger
 *
 * 流程：
 * 1. 前端使用 Firebase Phone Auth 驗證手機號碼
 * 2. 驗證成功後，前端將 phone 與 firebaseUid 發送到此 API
 * 3. 後端檢查手機號碼是否已存在，如不存在則自動註冊
 * 4. 返回乘客完整資料
 */
router.post('/phone-verify-passenger', async (req: Request, res: Response) => {
  const { phone, firebaseUid, name } = req.body;

  console.log('[Phone Auth] 乘客端簡訊驗證登入:', { phone, firebaseUid });

  try {
    // 驗證輸入
    if (!phone || !firebaseUid) {
      return res.status(400).json({
        error: 'MISSING_FIELDS',
        message: '缺少手機號碼或 Firebase UID'
      });
    }

    // 檢查是否已存在
    let passenger = await queryOne(
      'SELECT * FROM passengers WHERE phone = $1',
      [phone]
    );

    // 如果不存在，自動註冊
    if (!passenger) {
      const passengerId = `PASS${Date.now().toString().slice(-6)}`;
      const defaultName = name || `乘客 ${phone.slice(-4)}`;

      const result = await query(
        'INSERT INTO passengers (passenger_id, phone, name, firebase_uid) VALUES ($1, $2, $3, $4) RETURNING *',
        [passengerId, phone, defaultName, firebaseUid]
      );

      passenger = result.rows[0];
      console.log('[Phone Auth] 自動註冊新乘客:', passenger.passenger_id);
    } else {
      // 更新 Firebase UID（如果尚未設定）
      if (!passenger.firebase_uid) {
        await query(
          'UPDATE passengers SET firebase_uid = $1 WHERE passenger_id = $2',
          [firebaseUid, passenger.passenger_id]
        );
        console.log(`[Phone Auth] 更新乘客 ${passenger.passenger_id} 的 Firebase UID`);
      }
    }

    console.log('[Phone Auth] 乘客登入成功:', passenger.name);

    res.json({
      success: true,
      passengerId: passenger.passenger_id,
      phone: passenger.phone,
      name: passenger.name,
      totalRides: passenger.total_rides || 0,
      rating: parseFloat(passenger.rating) || 5.0
    });
  } catch (error) {
    console.error('[Phone Auth] 乘客端錯誤:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: '伺服器錯誤，請稍後再試'
    });
  }
});

export default router;

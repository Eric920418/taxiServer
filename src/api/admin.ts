import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../db/connection';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const router = Router();

// JWT 密鑰（實際應用中應該從環境變數讀取）
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRY = '24h';

// 管理員角色定義
enum AdminRole {
  SUPER_ADMIN = 'super_admin',
  ADMIN = 'admin',
  OPERATOR = 'operator'
}

// 擴展 Request 介面以包含 admin
interface AuthenticatedRequest extends Request {
  admin?: {
    admin_id: string;
    username: string;
    role: AdminRole;
    email: string;
  };
}

/**
 * 中介軟體：驗證管理員 JWT Token
 */
export const authenticateAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;

    // 從資料庫獲取管理員資訊
    const admin = await queryOne(
      'SELECT admin_id, username, email, role FROM admins WHERE admin_id = $1 AND is_active = true',
      [decoded.adminId]
    );

    if (!admin) {
      return res.status(401).json({
        success: false,
        error: 'Admin not found or inactive'
      });
    }

    req.admin = {
      admin_id: admin.admin_id,
      username: admin.username,
      role: admin.role,
      email: admin.email
    };

    next();
  } catch (error) {
    console.error('[Admin Auth] Token verification failed:', error);
    res.status(401).json({
      success: false,
      error: 'Invalid or expired token'
    });
  }
};

/**
 * 中介軟體：檢查管理員權限
 */
export const requireRole = (roles: AdminRole[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.admin || !roles.includes(req.admin.role as AdminRole)) {
      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions'
      });
    }
    next();
  };
};

/**
 * 管理員登入
 * POST /api/admin/auth/login
 */
router.post('/auth/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;

  try {
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username and password are required'
      });
    }

    // 查找管理員
    const admin = await queryOne(
      'SELECT * FROM admins WHERE username = $1 AND is_active = true',
      [username]
    );

    if (!admin) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // 驗證密碼
    const isValidPassword = await bcrypt.compare(password, admin.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // 生成 JWT Token
    const token = jwt.sign(
      {
        adminId: admin.admin_id,
        username: admin.username,
        role: admin.role
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    // 更新最後登入時間
    await query(
      'UPDATE admins SET last_login = CURRENT_TIMESTAMP WHERE admin_id = $1',
      [admin.admin_id]
    );

    console.log(`[Admin Auth] Admin ${admin.username} logged in successfully`);

    res.json({
      success: true,
      data: {
        token,
        admin: {
          id: admin.admin_id,
          username: admin.username,
          email: admin.email,
          role: admin.role,
          createdAt: admin.created_at,
          lastLogin: admin.last_login
        }
      }
    });
  } catch (error) {
    console.error('[Admin Auth] Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得管理員個人資料
 * GET /api/admin/auth/profile
 */
router.get('/auth/profile', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const admin = await queryOne(
      'SELECT admin_id, username, email, role, created_at, last_login FROM admins WHERE admin_id = $1',
      [req.admin!.admin_id]
    );

    res.json({
      success: true,
      data: {
        id: admin.admin_id,
        username: admin.username,
        email: admin.email,
        role: admin.role,
        createdAt: admin.created_at,
        lastLogin: admin.last_login
      }
    });
  } catch (error) {
    console.error('[Admin Auth] Get profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 管理員登出
 * POST /api/admin/auth/logout
 */
router.post('/auth/logout', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  // 在實際應用中，這裡可能需要將 token 加入黑名單
  console.log(`[Admin Auth] Admin ${req.admin!.username} logged out`);
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

/**
 * 變更密碼
 * POST /api/admin/auth/change-password
 */
router.post('/auth/change-password', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { oldPassword, newPassword } = req.body;

  try {
    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Both old and new passwords are required'
      });
    }

    // 獲取當前密碼
    const admin = await queryOne(
      'SELECT password_hash FROM admins WHERE admin_id = $1',
      [req.admin!.admin_id]
    );

    // 驗證舊密碼
    const isValidPassword = await bcrypt.compare(oldPassword, admin.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: 'Current password is incorrect'
      });
    }

    // 加密新密碼
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // 更新密碼
    await query(
      'UPDATE admins SET password_hash = $1 WHERE admin_id = $2',
      [newPasswordHash, req.admin!.admin_id]
    );

    console.log(`[Admin Auth] Password changed for admin ${req.admin!.username}`);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('[Admin Auth] Change password error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得司機列表（管理員功能）
 * GET /api/admin/drivers
 */
router.get('/drivers', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { search, status, page = 1, pageSize = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(pageSize);

  try {
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    // 搜尋條件
    if (search) {
      whereClause += ` AND (name ILIKE $${paramIndex} OR phone ILIKE $${paramIndex} OR plate ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // 狀態篩選
    if (status && status !== 'all') {
      if (status === 'blocked') {
        whereClause += ` AND is_blocked = true`;
      } else {
        whereClause += ` AND availability = $${paramIndex} AND is_blocked = false`;
        params.push(status);
        paramIndex++;
      }
    }

    // 取得總數
    const countResult = await queryOne(
      `SELECT COUNT(*) as total FROM drivers ${whereClause}`,
      params
    );

    // 取得司機列表
    params.push(Number(pageSize), offset);
    const drivers = await query(
      `SELECT
        driver_id,
        name,
        phone as "phoneNumber",
        plate as "carPlate",
        car_model as "carModel",
        car_color as "carColor",
        license_number as "licenseNumber",
        availability as status,
        is_blocked as "isBlocked",
        block_reason as "blockReason",
        rating,
        total_trips as "totalTrips",
        total_earnings as "totalEarnings",
        latitude,
        longitude,
        last_location_update as "lastLocationUpdate",
        created_at as "createdAt",
        last_heartbeat as "lastActive"
      FROM drivers
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      params
    );

    // 處理司機資料
    const processedDrivers = drivers.rows.map((driver: any) => ({
      ...driver,
      rating: driver.rating ? parseFloat(driver.rating) : null,
      totalEarnings: driver.totalEarnings ? parseFloat(driver.totalEarnings) : 0,
      location: (driver.latitude && driver.longitude) ? {
        latitude: driver.latitude,
        longitude: driver.longitude,
        lastUpdated: driver.lastLocationUpdate
      } : null
    }));

    res.json({
      success: true,
      data: {
        items: processedDrivers,
        pagination: {
          page: Number(page),
          pageSize: Number(pageSize),
          total: parseInt(countResult.total),
          totalPages: Math.ceil(parseInt(countResult.total) / Number(pageSize))
        }
      }
    });
  } catch (error) {
    console.error('[Admin API] Get drivers error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得單一司機詳情
 * GET /api/admin/drivers/:driverId
 */
router.get('/drivers/:driverId', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { driverId } = req.params;

  try {
    const driver = await queryOne(
      `SELECT
        driver_id,
        name,
        phone as "phoneNumber",
        plate as "carPlate",
        car_model as "carModel",
        car_color as "carColor",
        license_number as "licenseNumber",
        availability as status,
        is_blocked as "isBlocked",
        block_reason as "blockReason",
        rating,
        total_trips as "totalTrips",
        total_earnings as "totalEarnings",
        latitude,
        longitude,
        last_location_update as "lastLocationUpdate",
        created_at as "createdAt",
        last_heartbeat as "lastActive",
        firebase_uid as "firebaseUid"
      FROM drivers WHERE driver_id = $1`,
      [driverId]
    );

    if (!driver) {
      return res.status(404).json({
        success: false,
        error: 'Driver not found'
      });
    }

    // 處理司機資料
    const processedDriver = {
      ...driver,
      rating: driver.rating ? parseFloat(driver.rating) : null,
      totalEarnings: driver.totalEarnings ? parseFloat(driver.totalEarnings) : 0,
      location: (driver.latitude && driver.longitude) ? {
        latitude: driver.latitude,
        longitude: driver.longitude,
        lastUpdated: driver.lastLocationUpdate
      } : null
    };

    res.json({
      success: true,
      data: processedDriver
    });
  } catch (error) {
    console.error('[Admin API] Get driver error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 新增司機
 * POST /api/admin/drivers
 */
router.post('/drivers', authenticateAdmin, requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    const { name, phoneNumber, licenseNumber, carPlate, carModel, carColor } = req.body;

    try {
      // 驗證必要欄位
      if (!name || !phoneNumber || !licenseNumber || !carPlate) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields'
        });
      }

      // 檢查手機號碼是否已存在
      const existingDriver = await queryOne(
        'SELECT driver_id FROM drivers WHERE phone = $1',
        [phoneNumber]
      );

      if (existingDriver) {
        return res.status(409).json({
          success: false,
          error: 'Phone number already registered'
        });
      }

      // 產生司機 ID
      const driverId = `DRV${Date.now().toString().slice(-8)}`;

      // 新增司機
      const result = await query(
        `INSERT INTO drivers (
          driver_id, name, phone, license_number, plate, car_model, car_color, availability
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'offline') RETURNING *`,
        [driverId, name, phoneNumber, licenseNumber, carPlate, carModel || '', carColor || '']
      );

      console.log(`[Admin API] New driver created: ${driverId} by admin ${req.admin!.username}`);

      res.json({
        success: true,
        data: {
          driver_id: result.rows[0].driver_id,
          name: result.rows[0].name,
          phoneNumber: result.rows[0].phone,
          carPlate: result.rows[0].plate,
          carModel: result.rows[0].car_model,
          carColor: result.rows[0].car_color,
          licenseNumber: result.rows[0].license_number,
          status: result.rows[0].availability,
          createdAt: result.rows[0].created_at
        }
      });
    } catch (error) {
      console.error('[Admin API] Create driver error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
});

/**
 * 更新司機資料
 * PUT /api/admin/drivers/:driverId
 */
router.put('/drivers/:driverId', authenticateAdmin, requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    const { driverId } = req.params;
    const updates = req.body;

    try {
      // 檢查司機是否存在
      const driver = await queryOne(
        'SELECT driver_id FROM drivers WHERE driver_id = $1',
        [driverId]
      );

      if (!driver) {
        return res.status(404).json({
          success: false,
          error: 'Driver not found'
        });
      }

      // 建立更新查詢
      const updateFields: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      const allowedFields = ['name', 'phone', 'license_number', 'plate', 'car_model', 'car_color'];

      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          const dbField = field === 'phone' ? 'phone' :
                          field === 'plate' ? 'plate' :
                          field;
          updateFields.push(`${dbField} = $${paramIndex}`);
          values.push(updates[field]);
          paramIndex++;
        }
      }

      if (updateFields.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No valid fields to update'
        });
      }

      values.push(driverId);

      // 執行更新
      await query(
        `UPDATE drivers SET ${updateFields.join(', ')} WHERE driver_id = $${paramIndex}`,
        values
      );

      console.log(`[Admin API] Driver ${driverId} updated by admin ${req.admin!.username}`);

      res.json({
        success: true,
        message: 'Driver updated successfully'
      });
    } catch (error) {
      console.error('[Admin API] Update driver error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
});

/**
 * 封鎖司機
 * POST /api/admin/drivers/:driverId/block
 */
router.post('/drivers/:driverId/block', authenticateAdmin, requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    const { driverId } = req.params;
    const { reason } = req.body;

    try {
      if (!reason) {
        return res.status(400).json({
          success: false,
          error: 'Block reason is required'
        });
      }

      // 檢查司機是否存在
      const driver = await queryOne(
        'SELECT driver_id, is_blocked FROM drivers WHERE driver_id = $1',
        [driverId]
      );

      if (!driver) {
        return res.status(404).json({
          success: false,
          error: 'Driver not found'
        });
      }

      if (driver.is_blocked) {
        return res.status(400).json({
          success: false,
          error: 'Driver is already blocked'
        });
      }

      // 封鎖司機
      await query(
        'UPDATE drivers SET is_blocked = true, block_reason = $1, availability = $2 WHERE driver_id = $3',
        [reason, 'blocked', driverId]
      );

      console.log(`[Admin API] Driver ${driverId} blocked by admin ${req.admin!.username}. Reason: ${reason}`);

      res.json({
        success: true,
        message: 'Driver blocked successfully'
      });
    } catch (error) {
      console.error('[Admin API] Block driver error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
});

/**
 * 解除封鎖司機
 * POST /api/admin/drivers/:driverId/unblock
 */
router.post('/drivers/:driverId/unblock', authenticateAdmin, requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthenticatedRequest, res: Response) => {
    const { driverId } = req.params;

    try {
      // 檢查司機是否存在
      const driver = await queryOne(
        'SELECT driver_id, is_blocked FROM drivers WHERE driver_id = $1',
        [driverId]
      );

      if (!driver) {
        return res.status(404).json({
          success: false,
          error: 'Driver not found'
        });
      }

      if (!driver.is_blocked) {
        return res.status(400).json({
          success: false,
          error: 'Driver is not blocked'
        });
      }

      // 解除封鎖
      await query(
        'UPDATE drivers SET is_blocked = false, block_reason = NULL, availability = $1 WHERE driver_id = $2',
        ['offline', driverId]
      );

      console.log(`[Admin API] Driver ${driverId} unblocked by admin ${req.admin!.username}`);

      res.json({
        success: true,
        message: 'Driver unblocked successfully'
      });
    } catch (error) {
      console.error('[Admin API] Unblock driver error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
});

/**
 * 取得統計資料
 * GET /api/admin/statistics/dashboard
 */
router.get('/statistics/dashboard', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // 取得各項統計數據
    const [totalDrivers, activeDrivers, totalPassengers, totalOrders, todayRevenue] = await Promise.all([
      queryOne('SELECT COUNT(*) as count FROM drivers'),
      queryOne('SELECT COUNT(*) as count FROM drivers WHERE availability = $1', ['available']),
      queryOne('SELECT COUNT(*) as count FROM passengers'),
      queryOne('SELECT COUNT(*) as count FROM orders'),
      queryOne(
        `SELECT COALESCE(SUM(actual_fare), 0) as revenue
         FROM orders
         WHERE DATE(created_at) = CURRENT_DATE AND status = 'completed'`
      )
    ]);

    // 取得總收入
    const totalRevenue = await queryOne(
      `SELECT COALESCE(SUM(actual_fare), 0) as revenue
       FROM orders
       WHERE status = 'completed'`
    );

    // 取得平均評分
    const avgRating = await queryOne(
      'SELECT COALESCE(AVG(rating), 0) as rating FROM drivers WHERE rating IS NOT NULL'
    );

    res.json({
      success: true,
      data: {
        totalDrivers: parseInt(totalDrivers.count),
        activeDrivers: parseInt(activeDrivers.count),
        totalPassengers: parseInt(totalPassengers.count),
        totalOrders: parseInt(totalOrders.count),
        totalRevenue: parseFloat(totalRevenue.revenue),
        todayRevenue: parseFloat(todayRevenue.revenue),
        averageRating: parseFloat(avgRating.rating),
        completedOrders: 0, // TODO: 實作
        peakHours: [] // TODO: 實作
      }
    });
  } catch (error) {
    console.error('[Admin API] Get statistics error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

export default router;
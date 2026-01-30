import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne, getPool } from '../db/connection';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getHotZoneQuotaService, HotZoneConfig } from '../services/HotZoneQuotaService';

const router = Router();

// 延遲初始化 HotZoneQuotaService
let hotZoneService: ReturnType<typeof getHotZoneQuotaService> | null = null;

const getHotZoneServiceInstance = () => {
  if (!hotZoneService) {
    hotZoneService = getHotZoneQuotaService(getPool());
  }
  return hotZoneService;
};

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
 * 取得乘客列表（管理員功能）
 * GET /api/admin/passengers
 */
router.get('/passengers', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { search, page = 1, pageSize = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(pageSize);

  try {
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    // 搜尋條件
    if (search) {
      whereClause += ` AND (name ILIKE $${paramIndex} OR phone ILIKE $${paramIndex} OR passenger_id ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // 取得總數
    const countResult = await queryOne(
      `SELECT COUNT(*) as total FROM passengers ${whereClause}`,
      params
    );

    // 取得乘客列表
    params.push(Number(pageSize), offset);
    const passengers = await query(
      `SELECT
        passenger_id,
        name,
        phone as "phoneNumber",
        email,
        created_at as "createdAt",
        last_login as "lastLogin"
      FROM passengers
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      params
    );

    res.json({
      success: true,
      data: {
        items: passengers.rows,
        pagination: {
          page: Number(page),
          pageSize: Number(pageSize),
          total: parseInt(countResult.total),
          totalPages: Math.ceil(parseInt(countResult.total) / Number(pageSize))
        }
      }
    });
  } catch (error) {
    console.error('[Admin API] Get passengers error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得單一乘客詳情
 * GET /api/admin/passengers/:passengerId
 */
router.get('/passengers/:passengerId', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { passengerId } = req.params;

  try {
    const passenger = await queryOne(
      `SELECT
        passenger_id,
        name,
        phone as "phoneNumber",
        email,
        created_at as "createdAt",
        last_login as "lastLogin"
      FROM passengers WHERE passenger_id = $1`,
      [passengerId]
    );

    if (!passenger) {
      return res.status(404).json({
        success: false,
        error: 'Passenger not found'
      });
    }

    res.json({
      success: true,
      data: passenger
    });
  } catch (error) {
    console.error('[Admin API] Get passenger error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得訂單列表（管理員功能）
 * GET /api/admin/orders
 */
router.get('/orders', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { search, status, startDate, endDate, page = 1, pageSize = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(pageSize);

  try {
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    // 搜尋條件
    if (search) {
      whereClause += ` AND (o.order_id ILIKE $${paramIndex} OR o.passenger_id ILIKE $${paramIndex} OR o.driver_id ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // 狀態篩選
    if (status && status !== 'all') {
      whereClause += ` AND o.status = $${paramIndex}`;
      params.push(status.toString().toUpperCase());
      paramIndex++;
    }

    // 日期範圍篩選
    if (startDate) {
      whereClause += ` AND DATE(o.created_at) >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      whereClause += ` AND DATE(o.created_at) <= $${paramIndex}`;
      params.push(endDate);
      paramIndex++;
    }

    // 取得總數
    const countResult = await queryOne(
      `SELECT COUNT(*) as total FROM orders o ${whereClause}`,
      params
    );

    // 取得訂單列表
    params.push(Number(pageSize), offset);
    const orders = await query(
      `SELECT
        o.order_id,
        o.passenger_id,
        o.driver_id,
        o.status,
        o.pickup_lat,
        o.pickup_lng,
        o.pickup_address,
        o.dest_lat,
        o.dest_lng,
        o.dest_address,
        o.payment_type as "paymentMethod",
        CASE
          WHEN o.status = 'DONE' THEN 'completed'
          WHEN o.status = 'CANCELLED' THEN 'failed'
          ELSE 'pending'
        END as "paymentStatus",
        o.meter_amount as fare,
        o.actual_distance_km as distance,
        o.actual_duration_min as duration,
        o.created_at as "createdAt",
        o.accepted_at as "acceptedAt",
        o.arrived_at as "arrivedAt",
        o.started_at as "startedAt",
        o.completed_at as "completedAt",
        o.cancelled_at as "cancelledAt",
        p.name as passenger_name,
        d.name as driver_name
      FROM orders o
      LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      params
    );

    // 處理訂單資料格式
    const processedOrders = orders.rows.map((order: any) => ({
      order_id: order.order_id,
      passenger_id: order.passenger_id,
      driver_id: order.driver_id,
      status: order.status.toLowerCase(),
      pickupLocation: {
        lat: order.pickup_lat ? parseFloat(order.pickup_lat) : null,
        lng: order.pickup_lng ? parseFloat(order.pickup_lng) : null,
        address: order.pickup_address
      },
      dropoffLocation: order.dest_address ? {
        lat: order.dest_lat ? parseFloat(order.dest_lat) : null,
        lng: order.dest_lng ? parseFloat(order.dest_lng) : null,
        address: order.dest_address
      } : null,
      paymentMethod: order.paymentMethod?.toLowerCase() || 'cash',
      paymentStatus: order.paymentStatus,
      fare: order.fare ? parseFloat(order.fare) : 0,
      distance: order.distance ? parseFloat(order.distance) : null,
      duration: order.duration ? parseInt(order.duration) : null,
      createdAt: order.createdAt,
      acceptedAt: order.acceptedAt,
      arrivedAt: order.arrivedAt,
      startedAt: order.startedAt,
      completedAt: order.completedAt,
      cancelledAt: order.cancelledAt
    }));

    res.json({
      success: true,
      data: {
        items: processedOrders,
        pagination: {
          page: Number(page),
          pageSize: Number(pageSize),
          total: parseInt(countResult.total),
          totalPages: Math.ceil(parseInt(countResult.total) / Number(pageSize))
        }
      }
    });
  } catch (error) {
    console.error('[Admin API] Get orders error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得單一訂單詳情
 * GET /api/admin/orders/:orderId
 */
router.get('/orders/:orderId', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { orderId } = req.params;

  try {
    const order = await queryOne(
      `SELECT
        o.order_id,
        o.passenger_id,
        o.driver_id,
        o.status,
        o.pickup_lat,
        o.pickup_lng,
        o.pickup_address,
        o.dest_lat,
        o.dest_lng,
        o.dest_address,
        o.payment_type as "paymentMethod",
        CASE
          WHEN o.status = 'DONE' THEN 'completed'
          WHEN o.status = 'CANCELLED' THEN 'failed'
          ELSE 'pending'
        END as "paymentStatus",
        o.meter_amount as fare,
        o.actual_distance_km as distance,
        o.actual_duration_min as duration,
        o.created_at as "createdAt",
        o.accepted_at as "acceptedAt",
        o.arrived_at as "arrivedAt",
        o.started_at as "startedAt",
        o.completed_at as "completedAt",
        o.cancelled_at as "cancelledAt",
        p.name as passenger_name,
        d.name as driver_name
      FROM orders o
      LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      WHERE o.order_id = $1`,
      [orderId]
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    // 處理訂單資料格式
    const processedOrder = {
      order_id: order.order_id,
      passenger_id: order.passenger_id,
      driver_id: order.driver_id,
      status: order.status.toLowerCase(),
      pickupLocation: {
        lat: order.pickup_lat ? parseFloat(order.pickup_lat) : null,
        lng: order.pickup_lng ? parseFloat(order.pickup_lng) : null,
        address: order.pickup_address
      },
      dropoffLocation: order.dest_address ? {
        lat: order.dest_lat ? parseFloat(order.dest_lat) : null,
        lng: order.dest_lng ? parseFloat(order.dest_lng) : null,
        address: order.dest_address
      } : null,
      paymentMethod: order.paymentMethod?.toLowerCase() || 'cash',
      paymentStatus: order.paymentStatus,
      fare: order.fare ? parseFloat(order.fare) : 0,
      distance: order.distance ? parseFloat(order.distance) : null,
      duration: order.duration ? parseInt(order.duration) : null,
      createdAt: order.createdAt,
      acceptedAt: order.acceptedAt,
      arrivedAt: order.arrivedAt,
      startedAt: order.startedAt,
      completedAt: order.completedAt,
      cancelledAt: order.cancelledAt
    };

    res.json({
      success: true,
      data: processedOrder
    });
  } catch (error) {
    console.error('[Admin API] Get order error:', error);
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
        `SELECT COALESCE(SUM(meter_amount), 0) as revenue
         FROM orders
         WHERE DATE(created_at) = CURRENT_DATE AND status = 'DONE'`
      )
    ]);

    // 取得總收入
    const totalRevenue = await queryOne(
      `SELECT COALESCE(SUM(meter_amount), 0) as revenue
       FROM orders
       WHERE status = 'DONE'`
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

// ============================================
// 熱區配額管理 API
// ============================================

/**
 * 獲取所有熱區列表
 * GET /api/admin/hot-zones
 */
router.get('/hot-zones', async (req: Request, res: Response) => {
  try {
    const service = getHotZoneServiceInstance();
    const zones = await service.getAllActiveZones();

    res.json({
      success: true,
      zones: zones.map(zone => ({
        zoneId: zone.zoneId,
        zoneName: zone.zoneName,
        centerLat: zone.centerLat,
        centerLng: zone.centerLng,
        radiusKm: zone.radiusKm,
        peakHours: zone.peakHours,
        hourlyQuotaNormal: zone.hourlyQuotaNormal,
        hourlyQuotaPeak: zone.hourlyQuotaPeak,
        surgeThreshold: zone.surgeThreshold,
        surgeMultiplierMax: zone.surgeMultiplierMax,
        queueEnabled: zone.queueEnabled,
        maxQueueSize: zone.maxQueueSize,
        isActive: zone.isActive,
        priority: zone.priority,
      }))
    });
  } catch (error) {
    console.error('[HotZone] 獲取熱區列表錯誤:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: '獲取熱區列表失敗'
    });
  }
});

/**
 * 獲取所有熱區當前配額狀態
 * GET /api/admin/hot-zones/status
 */
router.get('/hot-zones/status', async (req: Request, res: Response) => {
  try {
    const service = getHotZoneServiceInstance();
    const statuses = await service.getAllZoneStatus();

    res.json({
      success: true,
      statuses: statuses.map(status => ({
        zoneId: status.zoneId,
        zoneName: status.zoneName,
        quotaDate: status.quotaDate,
        quotaHour: status.quotaHour,
        quotaLimit: status.quotaLimit,
        quotaUsed: status.quotaUsed,
        availableQuota: status.availableQuota,
        usagePercentage: Math.round(status.usagePercentage * 100),
        currentSurge: status.currentSurge,
        isPeak: status.isPeak,
        queueLength: status.queueLength,
      }))
    });
  } catch (error) {
    console.error('[HotZone] 獲取配額狀態錯誤:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: '獲取配額狀態失敗'
    });
  }
});

/**
 * 獲取單個熱區配額狀態
 * GET /api/admin/hot-zones/:zoneId/quota
 */
router.get('/hot-zones/:zoneId/quota', async (req: Request, res: Response) => {
  const zoneId = parseInt(req.params.zoneId);

  if (isNaN(zoneId)) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_ZONE_ID'
    });
  }

  try {
    const service = getHotZoneServiceInstance();
    const status = await service.checkQuota(zoneId);

    res.json({
      success: true,
      quota: {
        zoneId: status.zoneId,
        zoneName: status.zoneName,
        quotaDate: status.quotaDate,
        quotaHour: status.quotaHour,
        quotaLimit: status.quotaLimit,
        quotaUsed: status.quotaUsed,
        availableQuota: status.availableQuota,
        usagePercentage: Math.round(status.usagePercentage * 100),
        currentSurge: status.currentSurge,
        isPeak: status.isPeak,
        queueLength: status.queueLength,
      }
    });
  } catch (error) {
    console.error('[HotZone] 獲取配額狀態錯誤:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: '獲取配額狀態失敗'
    });
  }
});

/**
 * 獲取熱區統計
 * GET /api/admin/hot-zones/:zoneId/stats
 */
router.get('/hot-zones/:zoneId/stats', async (req: Request, res: Response) => {
  const zoneId = parseInt(req.params.zoneId);
  const days = parseInt(req.query.days as string) || 7;

  if (isNaN(zoneId)) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_ZONE_ID'
    });
  }

  try {
    const service = getHotZoneServiceInstance();
    const stats = await service.getZoneStats(zoneId, days);

    res.json({
      success: true,
      stats: {
        totalOrders: stats.totalOrders,
        totalFare: stats.totalFare,
        avgSurge: Math.round(stats.avgSurge * 100) / 100,
        peakUsage: Math.round(stats.peakUsage * 100),
        cancelRate: Math.round(stats.cancelRate * 100),
        days,
      }
    });
  } catch (error) {
    console.error('[HotZone] 獲取統計錯誤:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: '獲取熱區統計失敗'
    });
  }
});

/**
 * 新增熱區
 * POST /api/admin/hot-zones
 */
router.post('/hot-zones', async (req: Request, res: Response) => {
  const {
    zoneName, centerLat, centerLng, radiusKm,
    peakHours, hourlyQuotaNormal, hourlyQuotaPeak,
    surgeThreshold, surgeMultiplierMax, surgeStep,
    queueEnabled, maxQueueSize, queueTimeoutMinutes,
    priority
  } = req.body;

  // 驗證必填欄位
  if (!zoneName || !centerLat || !centerLng) {
    return res.status(400).json({
      success: false,
      error: 'MISSING_REQUIRED_FIELDS',
      message: '缺少必填欄位：zoneName, centerLat, centerLng'
    });
  }

  try {
    const service = getHotZoneServiceInstance();
    const zone = await service.createZone({
      zoneName,
      centerLat: parseFloat(centerLat),
      centerLng: parseFloat(centerLng),
      radiusKm: parseFloat(radiusKm) || 1.0,
      peakHours: peakHours || [],
      hourlyQuotaNormal: hourlyQuotaNormal || 20,
      hourlyQuotaPeak: hourlyQuotaPeak || 30,
      surgeThreshold: parseFloat(surgeThreshold) || 0.80,
      surgeMultiplierMax: parseFloat(surgeMultiplierMax) || 1.50,
      surgeStep: parseFloat(surgeStep) || 0.10,
      queueEnabled: queueEnabled !== false,
      maxQueueSize: maxQueueSize || 20,
      queueTimeoutMinutes: queueTimeoutMinutes || 15,
      isActive: true,
      priority: priority || 0,
    });

    res.status(201).json({
      success: true,
      message: '熱區已建立',
      zone: {
        zoneId: zone.zoneId,
        zoneName: zone.zoneName,
        centerLat: zone.centerLat,
        centerLng: zone.centerLng,
        radiusKm: zone.radiusKm,
      }
    });
  } catch (error: any) {
    console.error('[HotZone] 新增熱區錯誤:', error);

    if (error.code === '23505') {  // unique_violation
      return res.status(409).json({
        success: false,
        error: 'ZONE_EXISTS',
        message: '熱區名稱已存在'
      });
    }

    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: '新增熱區失敗'
    });
  }
});

/**
 * 更新熱區
 * PUT /api/admin/hot-zones/:zoneId
 */
router.put('/hot-zones/:zoneId', async (req: Request, res: Response) => {
  const zoneId = parseInt(req.params.zoneId);
  const updates = req.body;

  if (isNaN(zoneId)) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_ZONE_ID'
    });
  }

  try {
    const service = getHotZoneServiceInstance();

    // 構建更新物件
    const validUpdates: Partial<HotZoneConfig> = {};

    if (updates.zoneName) validUpdates.zoneName = updates.zoneName;
    if (typeof updates.centerLat === 'number') validUpdates.centerLat = updates.centerLat;
    if (typeof updates.centerLng === 'number') validUpdates.centerLng = updates.centerLng;
    if (typeof updates.radiusKm === 'number') validUpdates.radiusKm = updates.radiusKm;
    if (Array.isArray(updates.peakHours)) validUpdates.peakHours = updates.peakHours;
    if (typeof updates.hourlyQuotaNormal === 'number') validUpdates.hourlyQuotaNormal = updates.hourlyQuotaNormal;
    if (typeof updates.hourlyQuotaPeak === 'number') validUpdates.hourlyQuotaPeak = updates.hourlyQuotaPeak;
    if (typeof updates.surgeThreshold === 'number') validUpdates.surgeThreshold = updates.surgeThreshold;
    if (typeof updates.surgeMultiplierMax === 'number') validUpdates.surgeMultiplierMax = updates.surgeMultiplierMax;
    if (typeof updates.surgeStep === 'number') validUpdates.surgeStep = updates.surgeStep;
    if (typeof updates.queueEnabled === 'boolean') validUpdates.queueEnabled = updates.queueEnabled;
    if (typeof updates.maxQueueSize === 'number') validUpdates.maxQueueSize = updates.maxQueueSize;
    if (typeof updates.queueTimeoutMinutes === 'number') validUpdates.queueTimeoutMinutes = updates.queueTimeoutMinutes;
    if (typeof updates.isActive === 'boolean') validUpdates.isActive = updates.isActive;
    if (typeof updates.priority === 'number') validUpdates.priority = updates.priority;

    const zone = await service.updateZone(zoneId, validUpdates);

    if (!zone) {
      return res.status(404).json({
        success: false,
        error: 'ZONE_NOT_FOUND'
      });
    }

    res.json({
      success: true,
      message: '熱區已更新',
      zone: {
        zoneId: zone.zoneId,
        zoneName: zone.zoneName,
        isActive: zone.isActive,
      }
    });
  } catch (error) {
    console.error('[HotZone] 更新熱區錯誤:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: '更新熱區失敗'
    });
  }
});

/**
 * 取得即時統計資料
 * GET /api/admin/statistics/realtime
 */
router.get('/statistics/realtime', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // 取得目前在線司機數
    const onlineDrivers = await queryOne(
      `SELECT COUNT(*) as count FROM drivers WHERE availability IN ('available', 'AVAILABLE', 'on_trip', 'ON_TRIP')`
    );

    // 取得目前進行中的訂單數
    const activeOrders = await queryOne(
      `SELECT COUNT(*) as count FROM orders WHERE status IN ('WAITING', 'OFFERED', 'ACCEPTED', 'ARRIVED', 'ON_TRIP')`
    );

    // 取得今日完成訂單數
    const todayCompleted = await queryOne(
      `SELECT COUNT(*) as count FROM orders WHERE status = 'DONE' AND DATE(completed_at) = CURRENT_DATE`
    );

    // 取得今日取消訂單數
    const todayCancelled = await queryOne(
      `SELECT COUNT(*) as count FROM orders WHERE status = 'CANCELLED' AND DATE(cancelled_at) = CURRENT_DATE`
    );

    res.json({
      success: true,
      data: {
        onlineDrivers: parseInt(onlineDrivers.count),
        activeOrders: parseInt(activeOrders.count),
        todayCompleted: parseInt(todayCompleted.count),
        todayCancelled: parseInt(todayCancelled.count),
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('[Admin API] Get realtime stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得營收趨勢
 * GET /api/admin/statistics/revenue-trend
 */
router.get('/statistics/revenue-trend', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { days = 7 } = req.query;
  const numDays = Math.min(parseInt(days as string) || 7, 90);

  try {
    const result = await query(
      `SELECT
        DATE(completed_at) as date,
        COALESCE(SUM(meter_amount), 0) as revenue,
        COUNT(*) as orders
      FROM orders
      WHERE status = 'DONE'
        AND completed_at >= CURRENT_DATE - INTERVAL '${numDays} days'
      GROUP BY DATE(completed_at)
      ORDER BY date ASC`
    );

    // 補齊沒有資料的日期
    const data = [];
    const today = new Date();
    for (let i = numDays - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      const found = result.rows.find((r: any) =>
        new Date(r.date).toISOString().split('T')[0] === dateStr
      );

      data.push({
        date: dateStr,
        value: found ? parseFloat(found.revenue) : 0,
        type: '營收'
      });
    }

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('[Admin API] Get revenue trend error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得訂單數量趨勢
 * GET /api/admin/statistics/order-trend
 */
router.get('/statistics/order-trend', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { days = 7 } = req.query;
  const numDays = Math.min(parseInt(days as string) || 7, 90);

  try {
    const result = await query(
      `SELECT
        DATE(created_at) as date,
        COUNT(*) as orders
      FROM orders
      WHERE created_at >= CURRENT_DATE - INTERVAL '${numDays} days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC`
    );

    // 補齊沒有資料的日期
    const data = [];
    const today = new Date();
    for (let i = numDays - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      const found = result.rows.find((r: any) =>
        new Date(r.date).toISOString().split('T')[0] === dateStr
      );

      data.push({
        date: dateStr,
        value: found ? parseInt(found.orders) : 0,
        type: '訂單數'
      });
    }

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('[Admin API] Get order trend error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得訂單狀態分布
 * GET /api/admin/statistics/order-status
 */
router.get('/statistics/order-status', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT
        CASE
          WHEN status = 'DONE' THEN '已完成'
          WHEN status IN ('WAITING', 'OFFERED', 'ACCEPTED', 'ARRIVED', 'ON_TRIP') THEN '進行中'
          WHEN status = 'CANCELLED' THEN '已取消'
          ELSE '其他'
        END as type,
        COUNT(*) as value
      FROM orders
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY
        CASE
          WHEN status = 'DONE' THEN '已完成'
          WHEN status IN ('WAITING', 'OFFERED', 'ACCEPTED', 'ARRIVED', 'ON_TRIP') THEN '進行中'
          WHEN status = 'CANCELLED' THEN '已取消'
          ELSE '其他'
        END`
    );

    res.json({
      success: true,
      data: result.rows.map((r: any) => ({
        type: r.type,
        value: parseInt(r.value)
      }))
    });
  } catch (error) {
    console.error('[Admin API] Get order status error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得熱門時段分析
 * GET /api/admin/statistics/peak-hours
 */
router.get('/statistics/peak-hours', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT
        EXTRACT(HOUR FROM created_at) as hour,
        COUNT(*) as orders
      FROM orders
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY EXTRACT(HOUR FROM created_at)
      ORDER BY hour ASC`
    );

    // 補齊所有時段
    const data = [];
    for (let h = 0; h < 24; h++) {
      const found = result.rows.find((r: any) => parseInt(r.hour) === h);
      data.push({
        hour: `${h.toString().padStart(2, '0')}:00`,
        orders: found ? parseInt(found.orders) : 0
      });
    }

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('[Admin API] Get peak hours error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得最近訂單
 * GET /api/admin/statistics/recent-orders
 */
router.get('/statistics/recent-orders', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { limit = 10 } = req.query;

  try {
    const result = await query(
      `SELECT
        o.order_id,
        p.name as passenger_name,
        d.name as driver_name,
        o.status,
        o.meter_amount as fare,
        o.created_at
      FROM orders o
      LEFT JOIN passengers p ON o.passenger_id = p.passenger_id
      LEFT JOIN drivers d ON o.driver_id = d.driver_id
      ORDER BY o.created_at DESC
      LIMIT $1`,
      [parseInt(limit as string) || 10]
    );

    const now = new Date();
    const data = result.rows.map((r: any) => {
      const createdAt = new Date(r.created_at);
      const diffMs = now.getTime() - createdAt.getTime();
      const diffMins = Math.floor(diffMs / 60000);

      let timeAgo;
      if (diffMins < 1) timeAgo = '剛剛';
      else if (diffMins < 60) timeAgo = `${diffMins}分鐘前`;
      else if (diffMins < 1440) timeAgo = `${Math.floor(diffMins / 60)}小時前`;
      else timeAgo = `${Math.floor(diffMins / 1440)}天前`;

      return {
        key: r.order_id,
        orderId: r.order_id,
        passenger: r.passenger_name || '未知',
        driver: r.driver_name || '未指派',
        status: r.status.toLowerCase(),
        fare: r.fare ? parseFloat(r.fare) : 0,
        time: timeAgo
      };
    });

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('[Admin API] Get recent orders error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得司機活躍度分析（24小時）
 * GET /api/admin/statistics/driver-activity
 */
router.get('/statistics/driver-activity', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // 從 driver_locations 表取得各時段的活躍司機數
    const result = await query(
      `SELECT
        EXTRACT(HOUR FROM recorded_at) as hour,
        COUNT(DISTINCT driver_id) as active_drivers,
        COUNT(DISTINCT CASE WHEN on_trip = true THEN driver_id END) as busy_drivers
      FROM driver_locations
      WHERE recorded_at >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY EXTRACT(HOUR FROM recorded_at)
      ORDER BY hour ASC`
    );

    // 補齊所有時段 - 為 grouped column chart 格式化數據
    const data = [];
    for (let h = 0; h < 24; h += 3) {
      const hourData = result.rows.filter((r: any) => {
        const rHour = parseInt(r.hour);
        return rHour >= h && rHour < h + 3;
      });

      const active = hourData.reduce((sum: number, r: any) => sum + parseInt(r.active_drivers || 0), 0);
      const busy = hourData.reduce((sum: number, r: any) => sum + parseInt(r.busy_drivers || 0), 0);

      const timeStr = `${h.toString().padStart(2, '0')}:00`;

      // 為 grouped chart 生成兩條數據
      data.push({
        time: timeStr,
        active: Math.round(active / 3) || 0,
        type: '空閒'
      });
      data.push({
        time: timeStr,
        active: Math.round(busy / 3) || 0,
        type: '載客中'
      });
    }

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('[Admin API] Get driver activity error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得頂級司機排行榜
 * GET /api/admin/statistics/top-drivers
 */
router.get('/statistics/top-drivers', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { limit = 10 } = req.query;

  try {
    const result = await query(
      `SELECT
        d.driver_id,
        d.name,
        d.total_trips as trips,
        d.total_earnings as revenue,
        d.rating,
        d.acceptance_rate
      FROM drivers d
      WHERE d.total_trips > 0
      ORDER BY d.total_earnings DESC
      LIMIT $1`,
      [parseInt(limit as string) || 10]
    );

    const data = result.rows.map((r: any, index: number) => ({
      key: r.driver_id,
      rank: index + 1,
      name: r.name || '未知',
      trips: parseInt(r.trips) || 0,
      revenue: parseInt(r.revenue) || 0,
      rating: r.rating ? parseFloat(r.rating) : 0,
      acceptRate: r.acceptance_rate ? parseFloat(r.acceptance_rate) : 0
    }));

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('[Admin API] Get top drivers error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得區域熱點分析
 * GET /api/admin/statistics/regions
 */
router.get('/statistics/regions', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // 根據上車地址統計
    const result = await query(
      `SELECT
        CASE
          WHEN pickup_address ILIKE '%火車站%' OR pickup_address ILIKE '%車站%' THEN '花蓮火車站'
          WHEN pickup_address ILIKE '%夜市%' OR pickup_address ILIKE '%東大門%' THEN '東大門夜市'
          WHEN pickup_address ILIKE '%七星潭%' THEN '七星潭'
          WHEN pickup_address ILIKE '%太魯閣%' THEN '太魯閣'
          WHEN pickup_address ILIKE '%機場%' THEN '花蓮機場'
          WHEN pickup_address ILIKE '%遠百%' OR pickup_address ILIKE '%遠東%' OR pickup_address ILIKE '%中山路%' OR pickup_address ILIKE '%中正路%' THEN '市區商圈'
          ELSE '其他區域'
        END as region,
        COUNT(*) as orders,
        COALESCE(SUM(meter_amount), 0) as revenue
      FROM orders
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
        AND pickup_address IS NOT NULL
      GROUP BY
        CASE
          WHEN pickup_address ILIKE '%火車站%' OR pickup_address ILIKE '%車站%' THEN '花蓮火車站'
          WHEN pickup_address ILIKE '%夜市%' OR pickup_address ILIKE '%東大門%' THEN '東大門夜市'
          WHEN pickup_address ILIKE '%七星潭%' THEN '七星潭'
          WHEN pickup_address ILIKE '%太魯閣%' THEN '太魯閣'
          WHEN pickup_address ILIKE '%機場%' THEN '花蓮機場'
          WHEN pickup_address ILIKE '%遠百%' OR pickup_address ILIKE '%遠東%' OR pickup_address ILIKE '%中山路%' OR pickup_address ILIKE '%中正路%' THEN '市區商圈'
          ELSE '其他區域'
        END
      ORDER BY orders DESC`
    );

    res.json({
      success: true,
      data: result.rows.map((r: any) => ({
        region: r.region,
        orders: parseInt(r.orders),
        revenue: parseFloat(r.revenue)
      }))
    });
  } catch (error) {
    console.error('[Admin API] Get regions error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得支付方式分布
 * GET /api/admin/statistics/payment-methods
 */
router.get('/statistics/payment-methods', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT
        CASE
          WHEN payment_type = 'CASH' THEN '現金'
          WHEN payment_type = 'LOVE_CARD_PHYSICAL' THEN '愛心卡'
          ELSE '其他'
        END as type,
        COUNT(*) as value
      FROM orders
      WHERE status = 'DONE'
        AND created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY
        CASE
          WHEN payment_type = 'CASH' THEN '現金'
          WHEN payment_type = 'LOVE_CARD_PHYSICAL' THEN '愛心卡'
          ELSE '其他'
        END
      ORDER BY value DESC`
    );

    const total = result.rows.reduce((sum: number, r: any) => sum + parseInt(r.value), 0);

    res.json({
      success: true,
      data: result.rows.map((r: any) => ({
        type: r.type,
        value: parseInt(r.value),
        percentage: total > 0 ? Math.round((parseInt(r.value) / total) * 100) : 0
      })),
      total
    });
  } catch (error) {
    console.error('[Admin API] Get payment methods error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得評分分布
 * GET /api/admin/statistics/ratings
 */
router.get('/statistics/ratings', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT
        rating,
        COUNT(*) as count
      FROM ratings
      WHERE to_type = 'driver'
      GROUP BY rating
      ORDER BY rating DESC`
    );

    // 補齊所有評分
    const data = [];
    for (let r = 5; r >= 1; r--) {
      const found = result.rows.find((row: any) => parseInt(row.rating) === r);
      data.push({
        rating: `${r}星`,
        count: found ? parseInt(found.count) : 0
      });
    }

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('[Admin API] Get ratings error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 取得 Analytics 頁面完整統計資料
 * GET /api/admin/statistics/analytics
 */
router.get('/statistics/analytics', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { days = 7 } = req.query;
  const numDays = Math.min(parseInt(days as string) || 7, 90);

  try {
    // 並行取得所有統計資料
    const [
      totalRevenue,
      totalOrders,
      activeDrivers,
      activePassengers,
      prevRevenue,
      prevOrders,
      prevDrivers,
      prevPassengers
    ] = await Promise.all([
      // 當前週期
      queryOne(`SELECT COALESCE(SUM(meter_amount), 0) as value FROM orders WHERE status = 'DONE' AND completed_at >= CURRENT_DATE - INTERVAL '${numDays} days'`),
      queryOne(`SELECT COUNT(*) as value FROM orders WHERE created_at >= CURRENT_DATE - INTERVAL '${numDays} days'`),
      queryOne(`SELECT COUNT(DISTINCT driver_id) as value FROM orders WHERE created_at >= CURRENT_DATE - INTERVAL '${numDays} days'`),
      queryOne(`SELECT COUNT(DISTINCT passenger_id) as value FROM orders WHERE created_at >= CURRENT_DATE - INTERVAL '${numDays} days'`),
      // 前一週期（用於計算變化百分比）
      queryOne(`SELECT COALESCE(SUM(meter_amount), 0) as value FROM orders WHERE status = 'DONE' AND completed_at >= CURRENT_DATE - INTERVAL '${numDays * 2} days' AND completed_at < CURRENT_DATE - INTERVAL '${numDays} days'`),
      queryOne(`SELECT COUNT(*) as value FROM orders WHERE created_at >= CURRENT_DATE - INTERVAL '${numDays * 2} days' AND created_at < CURRENT_DATE - INTERVAL '${numDays} days'`),
      queryOne(`SELECT COUNT(DISTINCT driver_id) as value FROM orders WHERE created_at >= CURRENT_DATE - INTERVAL '${numDays * 2} days' AND created_at < CURRENT_DATE - INTERVAL '${numDays} days'`),
      queryOne(`SELECT COUNT(DISTINCT passenger_id) as value FROM orders WHERE created_at >= CURRENT_DATE - INTERVAL '${numDays * 2} days' AND created_at < CURRENT_DATE - INTERVAL '${numDays} days'`)
    ]);

    // 計算變化百分比
    const calcChange = (current: number, prev: number) => {
      if (prev === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - prev) / prev) * 1000) / 10;
    };

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue: parseFloat(totalRevenue.value),
          revenueChange: calcChange(parseFloat(totalRevenue.value), parseFloat(prevRevenue.value)),
          totalOrders: parseInt(totalOrders.value),
          ordersChange: calcChange(parseInt(totalOrders.value), parseInt(prevOrders.value)),
          activeDrivers: parseInt(activeDrivers.value),
          driversChange: calcChange(parseInt(activeDrivers.value), parseInt(prevDrivers.value)),
          activePassengers: parseInt(activePassengers.value),
          passengersChange: calcChange(parseInt(activePassengers.value), parseInt(prevPassengers.value))
        }
      }
    });
  } catch (error) {
    console.error('[Admin API] Get analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 獲取所有熱區統計總覽
 * GET /api/admin/hot-zones/stats/overview
 */
router.get('/hot-zones/stats/overview', async (req: Request, res: Response) => {
  const days = parseInt(req.query.days as string) || 7;

  try {
    const service = getHotZoneServiceInstance();
    const zones = await service.getAllActiveZones();

    const overview = await Promise.all(
      zones.map(async (zone) => {
        const stats = await service.getZoneStats(zone.zoneId, days);
        const status = await service.checkQuota(zone.zoneId);

        return {
          zoneId: zone.zoneId,
          zoneName: zone.zoneName,
          currentStatus: {
            usagePercentage: Math.round(status.usagePercentage * 100),
            currentSurge: status.currentSurge,
            queueLength: status.queueLength,
          },
          stats: {
            totalOrders: stats.totalOrders,
            totalFare: stats.totalFare,
            avgSurge: Math.round(stats.avgSurge * 100) / 100,
            cancelRate: Math.round(stats.cancelRate * 100),
          }
        };
      })
    );

    res.json({
      success: true,
      days,
      overview
    });
  } catch (error) {
    console.error('[HotZone] 獲取總覽錯誤:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: '獲取熱區總覽失敗'
    });
  }
});

// ============================================
// 通知管理 API
// ============================================

/**
 * 取得通知列表
 * GET /api/admin/notifications
 */
router.get('/notifications', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { category, unreadOnly, limit = 50 } = req.query;

  try {
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (category && category !== 'all') {
      whereClause += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (unreadOnly === 'true') {
      whereClause += ` AND is_read = false`;
    }

    params.push(parseInt(limit as string) || 50);

    const result = await query(
      `SELECT
        notification_id as id,
        type,
        category,
        title,
        message,
        related_id,
        link,
        is_read as read,
        created_at as time
      FROM notifications
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex}`,
      params
    );

    // 取得未讀數量
    const unreadCount = await queryOne(
      'SELECT COUNT(*) as count FROM notifications WHERE is_read = false'
    );

    res.json({
      success: true,
      data: result.rows.map((n: any) => ({
        ...n,
        id: n.id.toString(),
        read: n.read
      })),
      unreadCount: parseInt(unreadCount.count)
    });
  } catch (error) {
    console.error('[Admin API] Get notifications error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 標記通知為已讀
 * POST /api/admin/notifications/:id/read
 */
router.post('/notifications/:id/read', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    await query(
      'UPDATE notifications SET is_read = true WHERE notification_id = $1',
      [id]
    );

    res.json({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (error) {
    console.error('[Admin API] Mark notification as read error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 標記所有通知為已讀
 * POST /api/admin/notifications/read-all
 */
router.post('/notifications/read-all', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await query('UPDATE notifications SET is_read = true WHERE is_read = false');

    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('[Admin API] Mark all notifications as read error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 刪除通知
 * DELETE /api/admin/notifications/:id
 */
router.delete('/notifications/:id', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    await query('DELETE FROM notifications WHERE notification_id = $1', [id]);

    res.json({
      success: true,
      message: 'Notification deleted'
    });
  } catch (error) {
    console.error('[Admin API] Delete notification error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 清空所有通知
 * DELETE /api/admin/notifications
 */
router.delete('/notifications', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await query('DELETE FROM notifications');

    res.json({
      success: true,
      message: 'All notifications cleared'
    });
  } catch (error) {
    console.error('[Admin API] Clear notifications error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * 建立通知（內部使用或手動建立）
 * POST /api/admin/notifications
 */
router.post('/notifications', authenticateAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { type, category, title, message, relatedId, link } = req.body;

  try {
    if (!type || !category || !title || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: type, category, title, message'
      });
    }

    const result = await query(
      `INSERT INTO notifications (type, category, title, message, related_id, link)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING notification_id`,
      [type, category, title, message, relatedId || null, link || null]
    );

    res.json({
      success: true,
      data: {
        id: result.rows[0].notification_id
      }
    });
  } catch (error) {
    console.error('[Admin API] Create notification error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

export default router;
/**
 * admin-landmarks.ts
 *
 * Admin Panel 地標 CRUD API。掛在 /api/admin/landmarks 下（繼承 admin.ts 的 JWT 驗證）。
 *
 * 權限：
 *   - GET / GET/:id / GET/:id/audit：OPERATOR 以上可讀
 *   - POST / PATCH / DELETE / RESTORE：ADMIN 以上才能寫
 *
 * 寫入流程：
 *   1. 驗證欄位（座標在花蓮範圍、category 合法、priority 0-10）
 *   2. 交易內寫入 landmarks + landmark_aliases + landmark_audit
 *   3. 事件完成後呼叫 hualienAddressDB.rebuildIndex() 原子替換記憶體索引
 */

import { Router, Response, Request } from 'express';
import { authenticateAdmin, AdminRole, requireRole } from './admin';
import pool from '../db/connection';
import { hualienAddressDB, isWithinHualienBounds } from '../services/HualienAddressDB';

const router = Router();

interface AuthedRequest extends Request {
  admin?: { admin_id: string; username: string; role: AdminRole };
}

// 所有路由都要登入
router.use(authenticateAdmin);

// ============================================================
// 輸入驗證
// ============================================================

const VALID_CATEGORIES = [
  'TRANSPORT', 'MEDICAL', 'SCHOOL', 'COMMERCIAL',
  'GOVERNMENT', 'ATTRACTION', 'HOTEL', 'TOWNSHIP',
];

interface LandmarkInput {
  name?: string;
  lat?: number;
  lng?: number;
  address?: string;
  category?: string;
  district?: string;
  priority?: number;
  dropoff_lat?: number | null;
  dropoff_lng?: number | null;
  dropoff_address?: string | null;
  aliases?: string[];
  taigi_aliases?: string[];
}

/**
 * 驗證新增/修改輸入。回 null 表通過；回字串表錯誤訊息。
 */
function validateInput(input: LandmarkInput, isCreate: boolean): string | null {
  if (isCreate) {
    if (!input.name || !input.name.trim()) return '地標名稱不可為空';
    if (input.lat === undefined || input.lng === undefined) return '經緯度必填';
    if (!input.address || !input.address.trim()) return '地址不可為空';
    if (!input.category) return '分類必填';
    if (!input.district || !input.district.trim()) return '行政區必填';
  }

  if (input.name !== undefined && input.name.length > 100) return '名稱超過 100 字元';

  if (input.lat !== undefined && input.lng !== undefined) {
    if (typeof input.lat !== 'number' || typeof input.lng !== 'number') {
      return '經緯度必須是數字';
    }
    if (!isWithinHualienBounds(input.lat, input.lng)) {
      return `座標不在花蓮縣範圍內 (lat=${input.lat}, lng=${input.lng})`;
    }
  }

  if (input.category !== undefined && !VALID_CATEGORIES.includes(input.category)) {
    return `分類必須是 ${VALID_CATEGORIES.join('/')}`;
  }

  if (input.priority !== undefined &&
      (typeof input.priority !== 'number' || input.priority < 0 || input.priority > 10)) {
    return '優先級必須在 0-10 之間';
  }

  if (input.dropoff_lat !== null && input.dropoff_lat !== undefined &&
      input.dropoff_lng !== null && input.dropoff_lng !== undefined) {
    if (!isWithinHualienBounds(input.dropoff_lat, input.dropoff_lng)) {
      return `司機停靠點座標不在花蓮縣範圍內`;
    }
  }

  return null;
}

/**
 * 讀取單筆完整地標（含別名）供回應用
 */
async function fetchLandmarkById(id: number): Promise<any | null> {
  const result = await pool.query(
    `SELECT l.*,
            COALESCE(
              json_agg(
                json_build_object('id', la.id, 'alias', la.alias, 'type', la.alias_type)
                ORDER BY la.alias_type, la.alias
              ) FILTER (WHERE la.id IS NOT NULL),
              '[]'::json
            ) AS aliases
     FROM landmarks l
     LEFT JOIN landmark_aliases la ON la.landmark_id = l.id
     WHERE l.id = $1
     GROUP BY l.id`,
    [id]
  );
  return result.rows[0] || null;
}

// ============================================================
// GET /api/admin/landmarks
// 列表 + 搜尋 + 分頁
// ============================================================
router.get('/', async (req: AuthedRequest, res: Response) => {
  try {
    const q = (req.query.q as string || '').trim();
    const category = req.query.category as string;
    const district = req.query.district as string;
    const includeDeleted = req.query.include_deleted === 'true';
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.page_size as string) || 50, 200);
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: any[] = [];

    if (!includeDeleted) conditions.push('l.deleted_at IS NULL');

    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(l.name ILIKE $${params.length} OR EXISTS (
        SELECT 1 FROM landmark_aliases la2
        WHERE la2.landmark_id = l.id AND la2.alias ILIKE $${params.length}
      ))`);
    }
    if (category) {
      params.push(category);
      conditions.push(`l.category = $${params.length}`);
    }
    if (district) {
      params.push(district);
      conditions.push(`l.district = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(pageSize, offset);
    const listResult = await pool.query(
      `SELECT l.id, l.name, l.lat, l.lng, l.address, l.category, l.district,
              l.priority, l.dropoff_lat, l.dropoff_lng, l.dropoff_address,
              l.created_by, l.updated_by, l.created_at, l.updated_at, l.deleted_at,
              (SELECT COUNT(*) FROM landmark_aliases la WHERE la.landmark_id = l.id) AS alias_count
       FROM landmarks l
       ${whereClause}
       ORDER BY l.priority DESC, l.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM landmarks l ${whereClause}`,
      params.slice(0, -2)
    );

    res.json({
      success: true,
      data: listResult.rows,
      pagination: {
        page,
        page_size: pageSize,
        total: parseInt(countResult.rows[0].total),
      },
      index_built_at: hualienAddressDB.getLastBuiltAt(),
    });
  } catch (error: any) {
    console.error('[Admin Landmarks] 列表查詢失敗:', error);
    res.status(500).json({ success: false, error: error.message, stack: error.stack });
  }
});

// ============================================================
// GET /api/admin/landmarks/:id
// ============================================================
router.get('/:id', async (req: AuthedRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const row = await fetchLandmarkById(id);
    if (!row) {
      return res.status(404).json({ success: false, error: '找不到此地標' });
    }
    res.json({ success: true, data: row });
  } catch (error: any) {
    console.error('[Admin Landmarks] 讀取失敗:', error);
    res.status(500).json({ success: false, error: error.message, stack: error.stack });
  }
});

// ============================================================
// GET /api/admin/landmarks/:id/audit
// 審計歷史
// ============================================================
router.get('/:id/audit', async (req: AuthedRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const result = await pool.query(
      `SELECT la.*, a.username AS admin_username
       FROM landmark_audit la
       LEFT JOIN admins a ON a.admin_id = la.admin_id
       WHERE la.landmark_id = $1
       ORDER BY la.created_at DESC
       LIMIT 100`,
      [id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('[Admin Landmarks] 審計查詢失敗:', error);
    res.status(500).json({ success: false, error: error.message, stack: error.stack });
  }
});

// ============================================================
// POST /api/admin/landmarks（新增）
// ============================================================
router.post(
  '/',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    const client = await pool.connect();
    try {
      const input: LandmarkInput = req.body;
      const validationError = validateInput(input, true);
      if (validationError) {
        return res.status(400).json({ success: false, error: validationError });
      }

      await client.query('BEGIN');

      // 名稱唯一
      const existing = await client.query(
        'SELECT id FROM landmarks WHERE name = $1 AND deleted_at IS NULL',
        [input.name]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: `地標名稱「${input.name}」已存在（id=${existing.rows[0].id}）`,
        });
      }

      const insertResult = await client.query(
        `INSERT INTO landmarks
          (name, lat, lng, address, category, district, priority,
           dropoff_lat, dropoff_lng, dropoff_address, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         RETURNING *`,
        [
          input.name,
          input.lat,
          input.lng,
          input.address,
          input.category,
          input.district,
          input.priority ?? 5,
          input.dropoff_lat ?? null,
          input.dropoff_lng ?? null,
          input.dropoff_address ?? null,
          req.admin!.admin_id,
        ]
      );
      const landmark = insertResult.rows[0];

      // 別名
      for (const alias of input.aliases || []) {
        if (alias.trim()) {
          await client.query(
            `INSERT INTO landmark_aliases (landmark_id, alias, alias_type)
             VALUES ($1, $2, 'ALIAS') ON CONFLICT DO NOTHING`,
            [landmark.id, alias.trim()]
          );
        }
      }
      for (const taigi of input.taigi_aliases || []) {
        if (taigi.trim()) {
          await client.query(
            `INSERT INTO landmark_aliases (landmark_id, alias, alias_type)
             VALUES ($1, $2, 'TAIGI') ON CONFLICT DO NOTHING`,
            [landmark.id, taigi.trim()]
          );
        }
      }

      // 審計
      const after = await fetchLandmarkByIdInTx(client, landmark.id);
      await client.query(
        `INSERT INTO landmark_audit (landmark_id, admin_id, action, before_data, after_data)
         VALUES ($1, $2, 'CREATE', NULL, $3::jsonb)`,
        [landmark.id, req.admin!.admin_id, JSON.stringify(after)]
      );

      await client.query('COMMIT');

      // 重建記憶體索引
      hualienAddressDB.rebuildIndex().catch((err) =>
        console.error('[Admin Landmarks] rebuildIndex 失敗:', err)
      );

      res.status(201).json({ success: true, data: after });
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error('[Admin Landmarks] 新增失敗:', error);
      res.status(500).json({ success: false, error: error.message, stack: error.stack });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// PATCH /api/admin/landmarks/:id
// ============================================================
router.patch(
  '/:id',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    const client = await pool.connect();
    try {
      const id = parseInt(req.params.id);
      const input: LandmarkInput = req.body;

      const validationError = validateInput(input, false);
      if (validationError) {
        return res.status(400).json({ success: false, error: validationError });
      }

      await client.query('BEGIN');

      const before = await fetchLandmarkByIdInTx(client, id);
      if (!before) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: '找不到此地標' });
      }

      // 動態組 UPDATE
      const sets: string[] = [];
      const params: any[] = [];
      const fieldMap: Record<string, any> = {
        name: input.name,
        lat: input.lat,
        lng: input.lng,
        address: input.address,
        category: input.category,
        district: input.district,
        priority: input.priority,
        dropoff_lat: input.dropoff_lat,
        dropoff_lng: input.dropoff_lng,
        dropoff_address: input.dropoff_address,
      };
      for (const [col, val] of Object.entries(fieldMap)) {
        if (val !== undefined) {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        }
      }
      params.push(req.admin!.admin_id);
      sets.push(`updated_by = $${params.length}`);
      params.push(id);

      if (sets.length > 1) {
        await client.query(
          `UPDATE landmarks SET ${sets.join(', ')} WHERE id = $${params.length}`,
          params
        );
      }

      // 別名處理：如果傳了 aliases 陣列就整批替換，沒傳就保留
      if (input.aliases !== undefined) {
        await client.query(
          `DELETE FROM landmark_aliases WHERE landmark_id = $1 AND alias_type = 'ALIAS'`,
          [id]
        );
        for (const alias of input.aliases) {
          if (alias.trim()) {
            await client.query(
              `INSERT INTO landmark_aliases (landmark_id, alias, alias_type)
               VALUES ($1, $2, 'ALIAS') ON CONFLICT DO NOTHING`,
              [id, alias.trim()]
            );
          }
        }
      }
      if (input.taigi_aliases !== undefined) {
        await client.query(
          `DELETE FROM landmark_aliases WHERE landmark_id = $1 AND alias_type = 'TAIGI'`,
          [id]
        );
        for (const taigi of input.taigi_aliases) {
          if (taigi.trim()) {
            await client.query(
              `INSERT INTO landmark_aliases (landmark_id, alias, alias_type)
               VALUES ($1, $2, 'TAIGI') ON CONFLICT DO NOTHING`,
              [id, taigi.trim()]
            );
          }
        }
      }

      const after = await fetchLandmarkByIdInTx(client, id);
      await client.query(
        `INSERT INTO landmark_audit (landmark_id, admin_id, action, before_data, after_data)
         VALUES ($1, $2, 'UPDATE', $3::jsonb, $4::jsonb)`,
        [id, req.admin!.admin_id, JSON.stringify(before), JSON.stringify(after)]
      );

      await client.query('COMMIT');

      hualienAddressDB.rebuildIndex().catch((err) =>
        console.error('[Admin Landmarks] rebuildIndex 失敗:', err)
      );

      res.json({ success: true, data: after });
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error('[Admin Landmarks] 更新失敗:', error);
      res.status(500).json({ success: false, error: error.message, stack: error.stack });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// DELETE /api/admin/landmarks/:id（軟刪除）
// ============================================================
router.delete(
  '/:id',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    const client = await pool.connect();
    try {
      const id = parseInt(req.params.id);
      await client.query('BEGIN');

      const before = await fetchLandmarkByIdInTx(client, id);
      if (!before) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: '找不到此地標' });
      }
      if (before.deleted_at) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: '此地標已刪除' });
      }

      await client.query(
        `UPDATE landmarks SET deleted_at = NOW(), updated_by = $2 WHERE id = $1`,
        [id, req.admin!.admin_id]
      );

      await client.query(
        `INSERT INTO landmark_audit (landmark_id, admin_id, action, before_data, after_data)
         VALUES ($1, $2, 'DELETE', $3::jsonb, NULL)`,
        [id, req.admin!.admin_id, JSON.stringify(before)]
      );

      await client.query('COMMIT');

      hualienAddressDB.rebuildIndex().catch((err) =>
        console.error('[Admin Landmarks] rebuildIndex 失敗:', err)
      );

      res.json({ success: true, message: '地標已軟刪除' });
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error('[Admin Landmarks] 刪除失敗:', error);
      res.status(500).json({ success: false, error: error.message, stack: error.stack });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// DELETE /api/admin/landmarks/:id/hard（永久刪除 — 只允許已軟刪除的地標）
// 設計：二階段硬刪除。必須先 soft delete，然後在「顯示已刪除」畫面再按永久刪除。
// - landmark_aliases 透過 FK ON DELETE CASCADE 自動清
// - landmark_audit 保留歷史紀錄（不受 FK 連動）
// - 另寫一筆 audit 記錄永久刪除行為
// ============================================================
router.delete(
  '/:id/hard',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    const client = await pool.connect();
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'id 必須是數字' });
      }

      await client.query('BEGIN');

      const before = await fetchLandmarkByIdInTx(client, id);
      if (!before) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: '找不到此地標' });
      }
      // 必須先軟刪除過才能永久刪除（防誤操作）
      if (!before.deleted_at) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: '此地標尚未軟刪除，請先按「刪除」再執行永久刪除',
        });
      }

      // 先寫 audit（地標刪掉後還要留可追溯記錄）
      await client.query(
        `INSERT INTO landmark_audit (landmark_id, admin_id, action, before_data, after_data)
         VALUES ($1, $2, 'DELETE', $3::jsonb, '{"hard_deleted":true}'::jsonb)`,
        [id, req.admin!.admin_id, JSON.stringify(before)]
      );

      // 真正 DELETE（aliases 會 CASCADE 自動清）
      await client.query(`DELETE FROM landmarks WHERE id = $1`, [id]);

      await client.query('COMMIT');

      hualienAddressDB.rebuildIndex().catch((err) =>
        console.error('[Admin Landmarks] rebuildIndex 失敗:', err)
      );

      res.json({ success: true, message: '已永久刪除（不可復原）' });
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error('[Admin Landmarks] 永久刪除失敗:', error);
      res.status(500).json({ success: false, error: error.message, stack: error.stack });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// POST /api/admin/landmarks/:id/restore（還原軟刪除）
// ============================================================
router.post(
  '/:id/restore',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    const client = await pool.connect();
    try {
      const id = parseInt(req.params.id);
      await client.query('BEGIN');

      const before = await fetchLandmarkByIdInTx(client, id);
      if (!before) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: '找不到此地標' });
      }
      if (!before.deleted_at) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: '此地標未被刪除' });
      }

      await client.query(
        `UPDATE landmarks SET deleted_at = NULL, updated_by = $2 WHERE id = $1`,
        [id, req.admin!.admin_id]
      );

      const after = await fetchLandmarkByIdInTx(client, id);
      await client.query(
        `INSERT INTO landmark_audit (landmark_id, admin_id, action, before_data, after_data)
         VALUES ($1, $2, 'RESTORE', $3::jsonb, $4::jsonb)`,
        [id, req.admin!.admin_id, JSON.stringify(before), JSON.stringify(after)]
      );

      await client.query('COMMIT');

      hualienAddressDB.rebuildIndex().catch((err) =>
        console.error('[Admin Landmarks] rebuildIndex 失敗:', err)
      );

      res.json({ success: true, data: after });
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error('[Admin Landmarks] 還原失敗:', error);
      res.status(500).json({ success: false, error: error.message, stack: error.stack });
    } finally {
      client.release();
    }
  }
);

// ============================================================
// GET /api/admin/landmarks/config/gmaps-key
// 回傳 Google Maps API Key 供 Admin Panel 前端使用
//
// 優先使用 GOOGLE_MAPS_BROWSER_KEY — 這個 key 應在 Google Cloud Console 設定
// HTTP referrer 限制（只允許 api.hualientaxi.taxi/*），外洩也無法被他人濫用。
//
// Fallback 到 GOOGLE_MAPS_API_KEY（Server 用的 key），但那個 key 通常沒
// referrer 限制（因為 Node fetch 沒 Referer header），出現在前端等於裸奔，
// 只建議在本地開發 fallback 時用。
// ============================================================
router.get('/config/gmaps-key', async (_req: AuthedRequest, res: Response) => {
  try {
    const key = process.env.GOOGLE_MAPS_BROWSER_KEY || process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return res.status(500).json({
        success: false,
        error: 'Server 未設定 GOOGLE_MAPS_BROWSER_KEY（或 GOOGLE_MAPS_API_KEY）環境變數',
      });
    }
    res.json({
      success: true,
      api_key: key,
      has_referrer_restriction: !!process.env.GOOGLE_MAPS_BROWSER_KEY,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message, stack: error.stack });
  }
});

// ============================================================
// POST /api/admin/landmarks/rebuild-index（手動觸發索引重建）
// ============================================================
router.post(
  '/rebuild-index',
  requireRole([AdminRole.SUPER_ADMIN, AdminRole.ADMIN]),
  async (req: AuthedRequest, res: Response) => {
    try {
      await hualienAddressDB.rebuildIndex();
      res.json({
        success: true,
        message: '記憶體索引已重建',
        built_at: hualienAddressDB.getLastBuiltAt(),
      });
    } catch (error: any) {
      console.error('[Admin Landmarks] 手動重建失敗:', error);
      res.status(500).json({ success: false, error: error.message, stack: error.stack });
    }
  }
);

// Helper：在交易中的 client 上取單筆地標（含別名）
async function fetchLandmarkByIdInTx(client: any, id: number): Promise<any | null> {
  const result = await client.query(
    `SELECT l.*,
            COALESCE(
              json_agg(
                json_build_object('id', la.id, 'alias', la.alias, 'type', la.alias_type)
              ) FILTER (WHERE la.id IS NOT NULL),
              '[]'::json
            ) AS aliases
     FROM landmarks l
     LEFT JOIN landmark_aliases la ON la.landmark_id = l.id
     WHERE l.id = $1
     GROUP BY l.id`,
    [id]
  );
  return result.rows[0] || null;
}

export default router;

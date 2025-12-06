import { Router } from 'express';
import { query, queryOne } from '../db/connection';

const router = Router();

/**
 * 提交評分
 * POST /api/ratings
 * Body: { orderId, fromType, fromId, toType, toId, rating, comment }
 */
router.post('/', async (req, res) => {
  const { orderId, fromType, fromId, toType, toId, rating, comment } = req.body;

  try {
    // 驗證必要欄位
    if (!orderId || !fromType || !fromId || !toType || !toId || rating === undefined) {
      return res.status(400).json({ error: '缺少必要欄位' });
    }

    // 驗證評分範圍
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: '評分必須在 1-5 之間' });
    }

    // 驗證訂單存在且已完成
    const order = await queryOne(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );

    if (!order) {
      return res.status(404).json({ error: '訂單不存在' });
    }

    if (order.status !== 'DONE') {
      return res.status(400).json({ error: '只能對已完成的訂單進行評分' });
    }

    // 檢查是否已經評過分
    const existingRating = await queryOne(`
      SELECT * FROM ratings
      WHERE order_id = $1 AND from_type = $2 AND from_id = $3
    `, [orderId, fromType, fromId]);

    if (existingRating) {
      return res.status(400).json({ error: '已經評過分了' });
    }

    // 創建評分記錄
    const ratingId = `RAT${Date.now()}`;
    await query(`
      INSERT INTO ratings (rating_id, order_id, from_type, from_id, to_type, to_id, rating, comment, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
    `, [ratingId, orderId, fromType, fromId, toType, toId, rating, comment || null]);

    // 更新被評分者的平均評分
    if (toType === 'driver') {
      // 更新司機評分
      const avgResult = await queryOne(`
        SELECT AVG(rating)::numeric(2,1) as avg_rating, COUNT(*) as count
        FROM ratings
        WHERE to_type = 'driver' AND to_id = $1
      `, [toId]);

      await query(`
        UPDATE drivers
        SET rating = $1
        WHERE driver_id = $2
      `, [avgResult?.avg_rating || rating, toId]);

      console.log(`[Rating] 司機 ${toId} 評分更新為 ${avgResult?.avg_rating}`);

    } else if (toType === 'passenger') {
      // 更新乘客評分
      const avgResult = await queryOne(`
        SELECT AVG(rating)::numeric(2,1) as avg_rating, COUNT(*) as count
        FROM ratings
        WHERE to_type = 'passenger' AND to_id = $1
      `, [toId]);

      await query(`
        UPDATE passengers
        SET rating = $1
        WHERE passenger_id = $2
      `, [avgResult?.avg_rating || rating, toId]);

      console.log(`[Rating] 乘客 ${toId} 評分更新為 ${avgResult?.avg_rating}`);
    }

    console.log(`[Rating] 新增評分: ${fromType} ${fromId} -> ${toType} ${toId}, 評分: ${rating}`);

    res.json({
      success: true,
      message: '評分成功',
      rating: {
        ratingId,
        orderId,
        fromType,
        fromId,
        toType,
        toId,
        rating,
        comment
      }
    });

  } catch (error) {
    console.error('[Rating] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 查詢某人收到的評分
 * GET /api/ratings/:type/:id
 * type: driver | passenger
 */
router.get('/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const { limit = 20, offset = 0 } = req.query;

  try {
    if (!['driver', 'passenger'].includes(type)) {
      return res.status(400).json({ error: '無效的類型' });
    }

    const ratings = await query(`
      SELECT r.*, o.pickup_address, o.dest_address
      FROM ratings r
      LEFT JOIN orders o ON r.order_id = o.order_id
      WHERE r.to_type = $1 AND r.to_id = $2
      ORDER BY r.created_at DESC
      LIMIT $3 OFFSET $4
    `, [type, id, limit, offset]);

    // 計算平均評分
    const statsResult = await queryOne(`
      SELECT
        AVG(rating)::numeric(2,1) as avg_rating,
        COUNT(*) as total_count,
        COUNT(CASE WHEN rating = 5 THEN 1 END) as five_star,
        COUNT(CASE WHEN rating = 4 THEN 1 END) as four_star,
        COUNT(CASE WHEN rating = 3 THEN 1 END) as three_star,
        COUNT(CASE WHEN rating = 2 THEN 1 END) as two_star,
        COUNT(CASE WHEN rating = 1 THEN 1 END) as one_star
      FROM ratings
      WHERE to_type = $1 AND to_id = $2
    `, [type, id]);

    res.json({
      success: true,
      ratings: ratings.rows.map(r => ({
        ratingId: r.rating_id,
        orderId: r.order_id,
        fromType: r.from_type,
        fromId: r.from_id,
        rating: r.rating,
        comment: r.comment,
        pickupAddress: r.pickup_address,
        destAddress: r.dest_address,
        createdAt: r.created_at ? new Date(r.created_at).getTime() : null
      })),
      stats: {
        averageRating: parseFloat(statsResult?.avg_rating || '0'),
        totalCount: parseInt(statsResult?.total_count || '0'),
        distribution: {
          fiveStar: parseInt(statsResult?.five_star || '0'),
          fourStar: parseInt(statsResult?.four_star || '0'),
          threeStar: parseInt(statsResult?.three_star || '0'),
          twoStar: parseInt(statsResult?.two_star || '0'),
          oneStar: parseInt(statsResult?.one_star || '0')
        }
      }
    });

  } catch (error) {
    console.error('[Get Ratings] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * 檢查某訂單是否已評分
 * GET /api/ratings/check/:orderId/:fromType/:fromId
 */
router.get('/check/:orderId/:fromType/:fromId', async (req, res) => {
  const { orderId, fromType, fromId } = req.params;

  try {
    const existing = await queryOne(`
      SELECT * FROM ratings
      WHERE order_id = $1 AND from_type = $2 AND from_id = $3
    `, [orderId, fromType, fromId]);

    res.json({
      success: true,
      hasRated: !!existing,
      rating: existing ? {
        ratingId: existing.rating_id,
        rating: existing.rating,
        comment: existing.comment
      } : null
    });

  } catch (error) {
    console.error('[Check Rating] 錯誤:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;

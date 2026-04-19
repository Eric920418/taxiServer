/**
 * /api/landmarks/sync
 *
 * App 端同步地標 API（公開讀，不需 Admin Token）。
 * App 啟動時呼叫此 API 拉取最新地標，合併到本地 HualienLocalAddressDB 的記憶體索引，
 * 讓 Admin 在後台新增/修改的地標能即時到達 App 端，不需重新發 APK。
 *
 * 請求：
 *   GET /api/landmarks/sync?since=2026-04-19T00:00:00Z
 *   - since 為 null/空 → 回全部 active 地標（首次同步）
 *   - since 有值 → 只回 updated_at > since 的記錄（增量同步）
 *
 * 回應：
 *   {
 *     version: "2026-04-19T08:30:00Z",
 *     landmarks: [...],      // 新增/更新的
 *     deleted_ids: [...]     // 被軟刪除的 id
 *   }
 */

import { Router, Request, Response } from 'express';
import pool from '../db/connection';

const router = Router();

router.get('/sync', async (req: Request, res: Response) => {
  try {
    const since = req.query.since as string;
    let sinceDate: Date | null = null;

    if (since) {
      sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) {
        return res.status(400).json({
          success: false,
          error: `since 參數格式錯誤: ${since}`,
        });
      }
    }

    const params: any[] = [];
    let whereClause = '';

    if (sinceDate) {
      params.push(sinceDate);
      whereClause = `WHERE l.updated_at > $1`;
    } else {
      whereClause = `WHERE l.deleted_at IS NULL`;
    }

    const landmarksResult = await pool.query(
      `SELECT l.id, l.name, l.lat, l.lng, l.address, l.category, l.district,
              l.priority, l.dropoff_lat, l.dropoff_lng, l.dropoff_address,
              l.updated_at, l.deleted_at,
              COALESCE(
                json_agg(
                  json_build_object('alias', la.alias, 'type', la.alias_type)
                ) FILTER (WHERE la.id IS NOT NULL),
                '[]'::json
              ) AS aliases
       FROM landmarks l
       LEFT JOIN landmark_aliases la ON la.landmark_id = l.id
       ${whereClause}
       GROUP BY l.id
       ORDER BY l.updated_at DESC`,
      params
    );

    const activeLandmarks: any[] = [];
    const deletedNames: string[] = [];

    for (const row of landmarksResult.rows) {
      if (row.deleted_at) {
        deletedNames.push(row.name);
      } else {
        const aliasList: string[] = [];
        const taigiList: string[] = [];
        for (const a of row.aliases as Array<{ alias: string; type: string }>) {
          if (a.type === 'TAIGI') taigiList.push(a.alias);
          else aliasList.push(a.alias);
        }
        activeLandmarks.push({
          id: row.id,
          name: row.name,
          lat: parseFloat(row.lat),
          lng: parseFloat(row.lng),
          address: row.address,
          category: row.category,
          district: row.district,
          priority: row.priority,
          aliases: aliasList,
          taigi_aliases: taigiList,
          dropoff_lat: row.dropoff_lat ? parseFloat(row.dropoff_lat) : null,
          dropoff_lng: row.dropoff_lng ? parseFloat(row.dropoff_lng) : null,
          dropoff_address: row.dropoff_address,
          updated_at: row.updated_at,
        });
      }
    }

    // 回傳 version 作為下次 since 的基準（用伺服器最新 updated_at，或當下時間）
    const versionResult = await pool.query(
      `SELECT MAX(updated_at) AS latest FROM landmarks`
    );
    const version = versionResult.rows[0].latest || new Date();

    res.json({
      success: true,
      version,
      landmarks: activeLandmarks,
      deleted_names: deletedNames,
      count: activeLandmarks.length,
    });
  } catch (error: any) {
    console.error('[Landmarks Sync] 失敗:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

export default router;

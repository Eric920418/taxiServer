/**
 * SQL 查詢建構器
 * 提供安全且高效的查詢建構方式
 */

import { Pool } from 'pg';
import * as cache from './cache';
import logger, { performanceLogger } from './logger';

export class QueryBuilder {
  private pool: Pool;
  private table: string = '';
  private selectFields: string[] = ['*'];
  private whereConditions: string[] = [];
  private whereParams: any[] = [];
  private joins: string[] = [];
  private orderByClause: string = '';
  private limitValue: number | null = null;
  private offsetValue: number | null = null;
  private groupByFields: string[] = [];
  private havingConditions: string[] = [];
  private cacheKey: string | null = null;
  private cacheTTL: number = 0;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * 設定查詢的資料表
   */
  from(table: string): this {
    this.table = table;
    return this;
  }

  /**
   * 選擇要查詢的欄位
   */
  select(...fields: string[]): this {
    this.selectFields = fields.length > 0 ? fields : ['*'];
    return this;
  }

  /**
   * 添加 WHERE 條件
   */
  where(field: string, operator: string, value?: any): this {
    if (value === undefined) {
      value = operator;
      operator = '=';
    }

    const paramIndex = this.whereParams.length + 1;
    this.whereConditions.push(`${field} ${operator} $${paramIndex}`);
    this.whereParams.push(value);
    return this;
  }

  /**
   * 添加 WHERE IN 條件
   */
  whereIn(field: string, values: any[]): this {
    const paramIndex = this.whereParams.length + 1;
    this.whereConditions.push(`${field} = ANY($${paramIndex})`);
    this.whereParams.push(values);
    return this;
  }

  /**
   * 添加 WHERE NULL 條件
   */
  whereNull(field: string): this {
    this.whereConditions.push(`${field} IS NULL`);
    return this;
  }

  /**
   * 添加 WHERE NOT NULL 條件
   */
  whereNotNull(field: string): this {
    this.whereConditions.push(`${field} IS NOT NULL`);
    return this;
  }

  /**
   * 添加 WHERE BETWEEN 條件
   */
  whereBetween(field: string, min: any, max: any): this {
    const paramIndex1 = this.whereParams.length + 1;
    const paramIndex2 = this.whereParams.length + 2;
    this.whereConditions.push(`${field} BETWEEN $${paramIndex1} AND $${paramIndex2}`);
    this.whereParams.push(min, max);
    return this;
  }

  /**
   * 添加 OR WHERE 條件
   */
  orWhere(field: string, operator: string, value?: any): this {
    if (value === undefined) {
      value = operator;
      operator = '=';
    }

    const paramIndex = this.whereParams.length + 1;
    const condition = `${field} ${operator} $${paramIndex}`;

    if (this.whereConditions.length > 0) {
      const lastCondition = this.whereConditions.pop();
      this.whereConditions.push(`(${lastCondition} OR ${condition})`);
    } else {
      this.whereConditions.push(condition);
    }

    this.whereParams.push(value);
    return this;
  }

  /**
   * 添加 JOIN
   */
  join(table: string, field1: string, operator: string, field2?: string): this {
    if (field2 === undefined) {
      field2 = operator;
      operator = '=';
    }
    this.joins.push(`JOIN ${table} ON ${field1} ${operator} ${field2}`);
    return this;
  }

  /**
   * 添加 LEFT JOIN
   */
  leftJoin(table: string, field1: string, operator: string, field2?: string): this {
    if (field2 === undefined) {
      field2 = operator;
      operator = '=';
    }
    this.joins.push(`LEFT JOIN ${table} ON ${field1} ${operator} ${field2}`);
    return this;
  }

  /**
   * 排序
   */
  orderBy(field: string, direction: 'ASC' | 'DESC' = 'ASC'): this {
    this.orderByClause = `ORDER BY ${field} ${direction}`;
    return this;
  }

  /**
   * 分組
   */
  groupBy(...fields: string[]): this {
    this.groupByFields = fields;
    return this;
  }

  /**
   * HAVING 條件
   */
  having(condition: string): this {
    this.havingConditions.push(condition);
    return this;
  }

  /**
   * 限制筆數
   */
  limit(value: number): this {
    this.limitValue = value;
    return this;
  }

  /**
   * 偏移量
   */
  offset(value: number): this {
    this.offsetValue = value;
    return this;
  }

  /**
   * 設定快取
   */
  withCache(key: string, ttl: number = 60): this {
    this.cacheKey = key;
    this.cacheTTL = ttl;
    return this;
  }

  /**
   * 建構 SQL 查詢
   */
  private buildQuery(): { sql: string; params: any[] } {
    let sql = `SELECT ${this.selectFields.join(', ')} FROM ${this.table}`;

    // 添加 JOIN
    if (this.joins.length > 0) {
      sql += ' ' + this.joins.join(' ');
    }

    // 添加 WHERE
    if (this.whereConditions.length > 0) {
      sql += ' WHERE ' + this.whereConditions.join(' AND ');
    }

    // 添加 GROUP BY
    if (this.groupByFields.length > 0) {
      sql += ' GROUP BY ' + this.groupByFields.join(', ');
    }

    // 添加 HAVING
    if (this.havingConditions.length > 0) {
      sql += ' HAVING ' + this.havingConditions.join(' AND ');
    }

    // 添加 ORDER BY
    if (this.orderByClause) {
      sql += ' ' + this.orderByClause;
    }

    // 添加 LIMIT
    if (this.limitValue !== null) {
      sql += ` LIMIT ${this.limitValue}`;
    }

    // 添加 OFFSET
    if (this.offsetValue !== null) {
      sql += ` OFFSET ${this.offsetValue}`;
    }

    return { sql, params: this.whereParams };
  }

  /**
   * 執行查詢並返回多筆結果
   */
  async get(): Promise<any[]> {
    // 檢查快取
    if (this.cacheKey) {
      const cached = await cache.getCachedApiResponse(this.cacheKey);
      if (cached) {
        logger.debug(`Cache hit for key: ${this.cacheKey}`);
        return cached;
      }
    }

    const { sql, params } = this.buildQuery();
    const timer = performanceLogger.startTimer('query');

    try {
      const result = await this.pool.query(sql, params);
      timer.end({ rows: result.rowCount });

      // 儲存到快取
      if (this.cacheKey && result.rows.length > 0) {
        await cache.cacheApiResponse(this.cacheKey, result.rows, this.cacheTTL);
      }

      return result.rows;
    } catch (error) {
      timer.end({ error: true });
      logger.error('Query failed', { sql, params, error });
      throw error;
    }
  }

  /**
   * 執行查詢並返回單筆結果
   */
  async first(): Promise<any> {
    this.limit(1);
    const results = await this.get();
    return results[0] || null;
  }

  /**
   * 執行計數查詢
   */
  async count(field: string = '*'): Promise<number> {
    const originalSelect = this.selectFields;
    this.selectFields = [`COUNT(${field}) as count`];

    const result = await this.first();
    this.selectFields = originalSelect;

    return parseInt(result?.count || 0);
  }

  /**
   * 執行插入
   */
  async insert(data: Record<string, any>): Promise<any> {
    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

    const sql = `
      INSERT INTO ${this.table} (${fields.join(', ')})
      VALUES (${placeholders})
      RETURNING *
    `;

    const timer = performanceLogger.startTimer('insert');

    try {
      const result = await this.pool.query(sql, values);
      timer.end({ success: true });

      // 清除相關快取
      await cache.clearCache(`api:*${this.table}*`);

      return result.rows[0];
    } catch (error) {
      timer.end({ error: true });
      logger.error('Insert failed', { sql, values, error });
      throw error;
    }
  }

  /**
   * 執行批次插入
   */
  async insertBatch(records: Record<string, any>[]): Promise<any[]> {
    if (records.length === 0) return [];

    const fields = Object.keys(records[0]);
    const values: any[] = [];
    const placeholders: string[] = [];

    records.forEach((record, recordIndex) => {
      const recordPlaceholders = fields.map((field, fieldIndex) => {
        const paramIndex = recordIndex * fields.length + fieldIndex + 1;
        values.push(record[field]);
        return `$${paramIndex}`;
      });
      placeholders.push(`(${recordPlaceholders.join(', ')})`);
    });

    const sql = `
      INSERT INTO ${this.table} (${fields.join(', ')})
      VALUES ${placeholders.join(', ')}
      RETURNING *
    `;

    const timer = performanceLogger.startTimer('insertBatch');

    try {
      const result = await this.pool.query(sql, values);
      timer.end({ rows: result.rowCount });

      // 清除相關快取
      await cache.clearCache(`api:*${this.table}*`);

      return result.rows;
    } catch (error) {
      timer.end({ error: true });
      logger.error('Batch insert failed', { sql, error });
      throw error;
    }
  }

  /**
   * 執行更新
   */
  async update(data: Record<string, any>): Promise<any[]> {
    const fields = Object.keys(data);
    const values = Object.values(data);

    const setClause = fields.map((field, i) => {
      const paramIndex = this.whereParams.length + i + 1;
      return `${field} = $${paramIndex}`;
    }).join(', ');

    let sql = `UPDATE ${this.table} SET ${setClause}`;

    // 添加 WHERE
    if (this.whereConditions.length > 0) {
      sql += ' WHERE ' + this.whereConditions.join(' AND ');
    }

    sql += ' RETURNING *';

    const allParams = [...this.whereParams, ...values];
    const timer = performanceLogger.startTimer('update');

    try {
      const result = await this.pool.query(sql, allParams);
      timer.end({ rows: result.rowCount });

      // 清除相關快取
      await cache.clearCache(`api:*${this.table}*`);

      return result.rows;
    } catch (error) {
      timer.end({ error: true });
      logger.error('Update failed', { sql, allParams, error });
      throw error;
    }
  }

  /**
   * 執行刪除
   */
  async delete(): Promise<number> {
    let sql = `DELETE FROM ${this.table}`;

    // 添加 WHERE
    if (this.whereConditions.length > 0) {
      sql += ' WHERE ' + this.whereConditions.join(' AND ');
    }

    const timer = performanceLogger.startTimer('delete');

    try {
      const result = await this.pool.query(sql, this.whereParams);
      timer.end({ rows: result.rowCount });

      // 清除相關快取
      await cache.clearCache(`api:*${this.table}*`);

      return result.rowCount || 0;
    } catch (error) {
      timer.end({ error: true });
      logger.error('Delete failed', { sql, whereParams: this.whereParams, error });
      throw error;
    }
  }

  /**
   * 執行原始 SQL
   */
  async raw(sql: string, params: any[] = []): Promise<any> {
    const timer = performanceLogger.startTimer('raw');

    try {
      const result = await this.pool.query(sql, params);
      timer.end({ rows: result.rowCount });
      return result;
    } catch (error) {
      timer.end({ error: true });
      logger.error('Raw query failed', { sql, params, error });
      throw error;
    }
  }

  /**
   * 交易處理
   */
  async transaction(callback: (qb: QueryBuilder) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const qb = new QueryBuilder(client as any);
      await callback(qb);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 重置查詢建構器
   */
  reset(): this {
    this.table = '';
    this.selectFields = ['*'];
    this.whereConditions = [];
    this.whereParams = [];
    this.joins = [];
    this.orderByClause = '';
    this.limitValue = null;
    this.offsetValue = null;
    this.groupByFields = [];
    this.havingConditions = [];
    this.cacheKey = null;
    this.cacheTTL = 0;
    return this;
  }
}

// 工廠函數
export function createQueryBuilder(pool: Pool): QueryBuilder {
  return new QueryBuilder(pool);
}
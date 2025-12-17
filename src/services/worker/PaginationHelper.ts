/**
 * PaginationHelper: DRY pagination utility
 *
 * Responsibility:
 * - DRY helper for paginated queries
 * - Eliminates copy-paste across observations/summaries/prompts endpoints
 * - Efficient LIMIT+1 trick to avoid COUNT(*) query
 * - Supports both SQLite (sync) and PostgreSQL (async) backends
 */

import { DatabaseManager } from './DatabaseManager.js';
import type { PaginatedResult, Observation, Summary, UserPrompt } from '../worker-types.js';

// PostgreSQL query function (dynamic import to avoid loading when using SQLite)
type QueryFn = typeof import('../postgres/pool.js').query;

export class PaginationHelper {
  private dbManager: DatabaseManager;
  private pgQuery: QueryFn | null = null;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /**
   * Get PostgreSQL query function (lazy load)
   */
  private async getPgQuery(): Promise<QueryFn> {
    if (!this.pgQuery) {
      const { query } = await import('../postgres/pool.js');
      this.pgQuery = query;
    }
    return this.pgQuery;
  }

  /**
   * Check if using PostgreSQL backend
   */
  private isPostgres(): boolean {
    return this.dbManager.isPostgres();
  }

  /**
   * Coerce PostgreSQL BIGINT strings to numbers for epoch timestamps
   * PostgreSQL returns BIGINT as strings to avoid JS precision issues,
   * but our epoch timestamps are well within safe integer range.
   */
  private coerceEpochToNumber<T extends { created_at_epoch?: string | number }>(item: T): T {
    if (item.created_at_epoch !== undefined && typeof item.created_at_epoch === 'string') {
      return { ...item, created_at_epoch: parseInt(item.created_at_epoch, 10) };
    }
    return item;
  }

  /**
   * Strip project path from file paths using heuristic
   * Converts "/Users/user/project/src/file.ts" -> "src/file.ts"
   * Uses first occurrence of project name from left (project root)
   */
  private stripProjectPath(filePath: string, projectName: string): string {
    const marker = `/${projectName}/`;
    const index = filePath.indexOf(marker);

    if (index !== -1) {
      // Strip everything before and including the project name
      return filePath.substring(index + marker.length);
    }

    // Fallback: return original path if project name not found
    return filePath;
  }

  /**
   * Strip project path from JSON array of file paths
   */
  private stripProjectPaths(filePathsStr: string | null, projectName: string): string | null {
    if (!filePathsStr) return filePathsStr;

    try {
      // Parse JSON array
      const paths = JSON.parse(filePathsStr) as string[];

      // Strip project path from each file
      const strippedPaths = paths.map(p => this.stripProjectPath(p, projectName));

      // Return as JSON string
      return JSON.stringify(strippedPaths);
    } catch (error) {
      // If parsing fails, return original string
      return filePathsStr;
    }
  }

  /**
   * Sanitize observation by stripping project paths from files
   */
  private sanitizeObservation(obs: Observation): Observation {
    return {
      ...obs,
      files_read: this.stripProjectPaths(obs.files_read, obs.project),
      files_modified: this.stripProjectPaths(obs.files_modified, obs.project)
    };
  }

  /**
   * Get paginated observations
   */
  async getObservations(offset: number, limit: number, project?: string): Promise<PaginatedResult<Observation>> {
    const result = await this.paginate<Observation>(
      'observations',
      'id, sdk_session_id, project, type, title, subtitle, narrative, text, facts, concepts, files_read, files_modified, prompt_number, created_at, created_at_epoch',
      offset,
      limit,
      project
    );

    // Strip project paths from file paths before returning
    return {
      ...result,
      items: result.items.map(obs => this.sanitizeObservation(obs))
    };
  }

  /**
   * Get paginated summaries
   */
  async getSummaries(offset: number, limit: number, project?: string): Promise<PaginatedResult<Summary>> {
    if (this.isPostgres()) {
      const pgQuery = await this.getPgQuery();
      let sql = `
        SELECT
          ss.id,
          s.claude_session_id as session_id,
          ss.request,
          ss.investigated,
          ss.learned,
          ss.completed,
          ss.next_steps,
          ss.project,
          ss.created_at,
          ss.created_at_epoch
        FROM session_summaries ss
        JOIN sdk_sessions s ON ss.sdk_session_id = s.sdk_session_id
      `;
      const params: any[] = [];
      let paramIndex = 1;

      if (project) {
        sql += ` WHERE ss.project = $${paramIndex++}`;
        params.push(project);
      }

      sql += ` ORDER BY ss.created_at_epoch DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
      params.push(limit + 1, offset);

      const result = await pgQuery<Summary>(sql, params);
      // Coerce BIGINT epoch strings to numbers for PostgreSQL
      const items = result.rows.slice(0, limit).map(row => this.coerceEpochToNumber(row));
      return {
        items,
        hasMore: result.rows.length > limit,
        offset,
        limit
      };
    }

    // SQLite
    const db = this.dbManager.getSessionStore().db;

    let query = `
      SELECT
        ss.id,
        s.claude_session_id as session_id,
        ss.request,
        ss.investigated,
        ss.learned,
        ss.completed,
        ss.next_steps,
        ss.project,
        ss.created_at,
        ss.created_at_epoch
      FROM session_summaries ss
      JOIN sdk_sessions s ON ss.sdk_session_id = s.sdk_session_id
    `;
    const params: any[] = [];

    if (project) {
      query += ' WHERE ss.project = ?';
      params.push(project);
    }

    query += ' ORDER BY ss.created_at_epoch DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset);

    const stmt = db.prepare(query);
    const results = stmt.all(...params) as Summary[];

    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }

  /**
   * Get paginated user prompts
   */
  async getPrompts(offset: number, limit: number, project?: string): Promise<PaginatedResult<UserPrompt>> {
    if (this.isPostgres()) {
      const pgQuery = await this.getPgQuery();
      let sql = `
        SELECT up.id, up.claude_session_id, s.project, up.prompt_number, up.prompt_text, up.created_at, up.created_at_epoch
        FROM user_prompts up
        JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      `;
      const params: any[] = [];
      let paramIndex = 1;

      if (project) {
        sql += ` WHERE s.project = $${paramIndex++}`;
        params.push(project);
      }

      sql += ` ORDER BY up.created_at_epoch DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
      params.push(limit + 1, offset);

      const result = await pgQuery<UserPrompt>(sql, params);
      // Coerce BIGINT epoch strings to numbers for PostgreSQL
      const items = result.rows.slice(0, limit).map(row => this.coerceEpochToNumber(row));
      return {
        items,
        hasMore: result.rows.length > limit,
        offset,
        limit
      };
    }

    // SQLite
    const db = this.dbManager.getSessionStore().db;

    let query = `
      SELECT up.id, up.claude_session_id, s.project, up.prompt_number, up.prompt_text, up.created_at, up.created_at_epoch
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
    `;
    const params: any[] = [];

    if (project) {
      query += ' WHERE s.project = ?';
      params.push(project);
    }

    query += ' ORDER BY up.created_at_epoch DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset);

    const stmt = db.prepare(query);
    const results = stmt.all(...params) as UserPrompt[];

    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }

  /**
   * Generic pagination implementation (DRY)
   */
  private async paginate<T>(
    table: string,
    columns: string,
    offset: number,
    limit: number,
    project?: string
  ): Promise<PaginatedResult<T>> {
    if (this.isPostgres()) {
      const pgQuery = await this.getPgQuery();
      let sql = `SELECT ${columns} FROM ${table}`;
      const params: any[] = [];
      let paramIndex = 1;

      if (project) {
        sql += ` WHERE project = $${paramIndex++}`;
        params.push(project);
      }

      sql += ` ORDER BY created_at_epoch DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
      params.push(limit + 1, offset);

      const result = await pgQuery<T>(sql, params);
      // Coerce BIGINT epoch strings to numbers for PostgreSQL
      const items = result.rows.slice(0, limit).map(row =>
        this.coerceEpochToNumber(row as T & { created_at_epoch?: string | number }) as T
      );
      return {
        items,
        hasMore: result.rows.length > limit,
        offset,
        limit
      };
    }

    // SQLite
    const db = this.dbManager.getSessionStore().db;

    let query = `SELECT ${columns} FROM ${table}`;
    const params: any[] = [];

    if (project) {
      query += ' WHERE project = ?';
      params.push(project);
    }

    query += ' ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset); // Fetch one extra to check hasMore

    const stmt = db.prepare(query);
    const results = stmt.all(...params) as T[];

    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }
}

/**
 * PostgreSQL Session Store
 *
 * PostgreSQL implementation of ISessionStore for team sharing.
 * Converts SQLite patterns to PostgreSQL equivalents.
 */

import { query, transaction, closePool, getPool } from './pool.js';
import { runMigrations } from './migrations.js';
import { getUserId } from '../../shared/user-identity.js';
import { logger } from '../../utils/logger.js';
import type {
  ISessionStore,
  ObservationInput,
  SummaryInput,
  QueryOptions
} from '../database/ISessionStore.js';
import type {
  ObservationRecord,
  SessionSummaryRecord,
  UserPromptRecord
} from '../../types/database.js';

export class PostgresSessionStore implements ISessionStore {
  private initialized = false;

  constructor() {
    // Pool is initialized lazily via getPool()
  }

  /**
   * Initialize database (run migrations)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await runMigrations();
    this.initialized = true;
    logger.info('PG_STORE', 'PostgresSessionStore initialized');
  }

  // ============================
  // Session Management
  // ============================

  async createSDKSession(claudeSessionId: string, project: string, userPrompt: string): Promise<number> {
    const now = new Date();
    const nowEpoch = now.getTime();
    const userId = getUserId();

    // Try to insert, on conflict return existing
    const result = await query<{ id: number }>(
      `INSERT INTO sdk_sessions
       (claude_session_id, sdk_session_id, project, user_id, user_prompt, started_at, started_at_epoch, status)
       VALUES ($1, $1, $2, $3, $4, $5, $6, 'active')
       ON CONFLICT (claude_session_id) DO UPDATE SET
         project = CASE WHEN sdk_sessions.project = '' THEN EXCLUDED.project ELSE sdk_sessions.project END,
         user_prompt = EXCLUDED.user_prompt
       RETURNING id`,
      [claudeSessionId, project, userId, userPrompt, now.toISOString(), nowEpoch]
    );

    return result.rows[0].id;
  }

  async findActiveSDKSession(claudeSessionId: string): Promise<{
    id: number;
    sdk_session_id: string | null;
    project: string;
    worker_port: number | null;
  } | null> {
    const result = await query<{
      id: number;
      sdk_session_id: string | null;
      project: string;
      worker_port: number | null;
    }>(
      `SELECT id, sdk_session_id, project, worker_port
       FROM sdk_sessions
       WHERE claude_session_id = $1 AND status = 'active'
       LIMIT 1`,
      [claudeSessionId]
    );

    return result.rows[0] || null;
  }

  async findAnySDKSession(claudeSessionId: string): Promise<{ id: number } | null> {
    const result = await query<{ id: number }>(
      `SELECT id FROM sdk_sessions WHERE claude_session_id = $1 LIMIT 1`,
      [claudeSessionId]
    );
    return result.rows[0] || null;
  }

  async reactivateSession(id: number, userPrompt: string): Promise<void> {
    await query(
      `UPDATE sdk_sessions SET status = 'active', user_prompt = $1, worker_port = NULL WHERE id = $2`,
      [userPrompt, id]
    );
  }

  async getSessionById(id: number): Promise<{
    id: number;
    claude_session_id: string;
    sdk_session_id: string | null;
    project: string;
    user_prompt: string;
  } | null> {
    const result = await query<{
      id: number;
      claude_session_id: string;
      sdk_session_id: string | null;
      project: string;
      user_prompt: string;
    }>(
      `SELECT id, claude_session_id, sdk_session_id, project, user_prompt
       FROM sdk_sessions WHERE id = $1 LIMIT 1`,
      [id]
    );
    return result.rows[0] || null;
  }

  async updateSDKSessionId(id: number, sdkSessionId: string): Promise<boolean> {
    const result = await query(
      `UPDATE sdk_sessions SET sdk_session_id = $1 WHERE id = $2 AND sdk_session_id IS NULL`,
      [sdkSessionId, id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setWorkerPort(id: number, port: number): Promise<void> {
    await query(`UPDATE sdk_sessions SET worker_port = $1 WHERE id = $2`, [port, id]);
  }

  async getWorkerPort(id: number): Promise<number | null> {
    const result = await query<{ worker_port: number | null }>(
      `SELECT worker_port FROM sdk_sessions WHERE id = $1 LIMIT 1`,
      [id]
    );
    return result.rows[0]?.worker_port ?? null;
  }

  async markSessionCompleted(id: number): Promise<void> {
    const now = new Date();
    await query(
      `UPDATE sdk_sessions SET status = 'completed', completed_at = $1, completed_at_epoch = $2 WHERE id = $3`,
      [now.toISOString(), now.getTime(), id]
    );
  }

  async markSessionFailed(id: number): Promise<void> {
    const now = new Date();
    await query(
      `UPDATE sdk_sessions SET status = 'failed', completed_at = $1, completed_at_epoch = $2 WHERE id = $3`,
      [now.toISOString(), now.getTime(), id]
    );
  }

  // ============================
  // Prompt Tracking
  // ============================

  async incrementPromptCounter(id: number): Promise<number> {
    const result = await query<{ prompt_counter: number }>(
      `UPDATE sdk_sessions SET prompt_counter = COALESCE(prompt_counter, 0) + 1 WHERE id = $1 RETURNING prompt_counter`,
      [id]
    );
    return result.rows[0]?.prompt_counter ?? 1;
  }

  async getPromptCounter(id: number): Promise<number> {
    const result = await query<{ prompt_counter: number | null }>(
      `SELECT prompt_counter FROM sdk_sessions WHERE id = $1`,
      [id]
    );
    return result.rows[0]?.prompt_counter ?? 0;
  }

  async saveUserPrompt(claudeSessionId: string, promptNumber: number, promptText: string): Promise<number> {
    const now = new Date();
    const userId = getUserId();

    const result = await query<{ id: number }>(
      `INSERT INTO user_prompts (claude_session_id, user_id, prompt_number, prompt_text, created_at, created_at_epoch)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [claudeSessionId, userId, promptNumber, promptText, now.toISOString(), now.getTime()]
    );
    return result.rows[0].id;
  }

  async getUserPrompt(claudeSessionId: string, promptNumber: number): Promise<string | null> {
    const result = await query<{ prompt_text: string }>(
      `SELECT prompt_text FROM user_prompts WHERE claude_session_id = $1 AND prompt_number = $2 LIMIT 1`,
      [claudeSessionId, promptNumber]
    );
    return result.rows[0]?.prompt_text ?? null;
  }

  async getLatestUserPrompt(claudeSessionId: string): Promise<{
    id: number;
    claude_session_id: string;
    sdk_session_id: string;
    project: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  } | undefined> {
    const result = await query<{
      id: number;
      claude_session_id: string;
      sdk_session_id: string;
      project: string;
      prompt_number: number;
      prompt_text: string;
      created_at_epoch: number;
    }>(
      `SELECT up.*, s.sdk_session_id, s.project
       FROM user_prompts up
       JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
       WHERE up.claude_session_id = $1
       ORDER BY up.created_at_epoch DESC
       LIMIT 1`,
      [claudeSessionId]
    );
    return result.rows[0];
  }

  // ============================
  // Observation Storage
  // ============================

  async storeObservation(
    sdkSessionId: string,
    project: string,
    observation: ObservationInput,
    promptNumber?: number,
    discoveryTokens: number = 0
  ): Promise<{ id: number; createdAtEpoch: number }> {
    const now = new Date();
    const nowEpoch = now.getTime();
    const userId = getUserId();

    // Ensure session exists
    await this.ensureSessionExists(sdkSessionId, project);

    const result = await query<{ id: number }>(
      `INSERT INTO observations
       (sdk_session_id, project, user_id, type, title, subtitle, facts, narrative, concepts,
        files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        sdkSessionId, project, userId, observation.type,
        observation.title, observation.subtitle,
        JSON.stringify(observation.facts), observation.narrative,
        JSON.stringify(observation.concepts),
        JSON.stringify(observation.files_read),
        JSON.stringify(observation.files_modified),
        promptNumber ?? null, discoveryTokens,
        now.toISOString(), nowEpoch
      ]
    );

    return { id: result.rows[0].id, createdAtEpoch: nowEpoch };
  }

  private async ensureSessionExists(sdkSessionId: string, project: string): Promise<void> {
    const now = new Date();
    const userId = getUserId();

    await query(
      `INSERT INTO sdk_sessions
       (claude_session_id, sdk_session_id, project, user_id, started_at, started_at_epoch, status)
       VALUES ($1, $1, $2, $3, $4, $5, 'active')
       ON CONFLICT (claude_session_id) DO NOTHING`,
      [sdkSessionId, project, userId, now.toISOString(), now.getTime()]
    );
  }

  async getObservationById(id: number): Promise<ObservationRecord | null> {
    const result = await query<ObservationRecord>(
      `SELECT * FROM observations WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  async getObservationsByIds(ids: number[], options: QueryOptions = {}): Promise<ObservationRecord[]> {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project, type, concepts, files } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';

    let paramIndex = 1;
    const params: any[] = [];
    const conditions: string[] = [`id = ANY($${paramIndex++})`];
    params.push(ids);

    if (project) {
      conditions.push(`project = $${paramIndex++}`);
      params.push(project);
    }

    if (type) {
      if (Array.isArray(type)) {
        conditions.push(`type = ANY($${paramIndex++})`);
        params.push(type);
      } else {
        conditions.push(`type = $${paramIndex++}`);
        params.push(type);
      }
    }

    if (concepts) {
      const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
      conditions.push(`concepts ?| $${paramIndex++}`);
      params.push(conceptsList);
    }

    if (files) {
      const filesList = Array.isArray(files) ? files : [files];
      // Search in both files_read and files_modified JSONB arrays
      const fileConditions = filesList.map((_, i) => {
        const idx = paramIndex++;
        params.push(`%${filesList[i]}%`);
        return `(files_read::text ILIKE $${idx} OR files_modified::text ILIKE $${idx})`;
      });
      conditions.push(`(${fileConditions.join(' OR ')})`);
    }

    let sql = `SELECT * FROM observations WHERE ${conditions.join(' AND ')} ORDER BY created_at_epoch ${orderClause}`;
    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    const result = await query<ObservationRecord>(sql, params);
    return result.rows;
  }

  async getObservationsForSession(sdkSessionId: string): Promise<Array<{
    title: string;
    subtitle: string;
    type: string;
    prompt_number: number | null;
  }>> {
    const result = await query<{
      title: string;
      subtitle: string;
      type: string;
      prompt_number: number | null;
    }>(
      `SELECT title, subtitle, type, prompt_number
       FROM observations WHERE sdk_session_id = $1
       ORDER BY created_at_epoch ASC`,
      [sdkSessionId]
    );
    return result.rows;
  }

  async getRecentObservations(project: string, limit: number = 20): Promise<Array<{
    type: string;
    text: string;
    prompt_number: number | null;
    created_at: string;
  }>> {
    const result = await query<{
      type: string;
      text: string;
      prompt_number: number | null;
      created_at: string;
    }>(
      `SELECT type, text, prompt_number, created_at
       FROM observations WHERE project = $1
       ORDER BY created_at_epoch DESC LIMIT $2`,
      [project, limit]
    );
    return result.rows;
  }

  async getAllRecentObservations(limit: number = 100): Promise<Array<{
    id: number;
    type: string;
    title: string | null;
    subtitle: string | null;
    text: string;
    project: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }>> {
    const result = await query<{
      id: number;
      type: string;
      title: string | null;
      subtitle: string | null;
      text: string;
      project: string;
      prompt_number: number | null;
      created_at: string;
      created_at_epoch: number;
    }>(
      `SELECT id, type, title, subtitle, text, project, prompt_number, created_at, created_at_epoch
       FROM observations ORDER BY created_at_epoch DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  // ============================
  // Summary Storage
  // ============================

  async storeSummary(
    sdkSessionId: string,
    project: string,
    summary: SummaryInput,
    promptNumber?: number,
    discoveryTokens: number = 0
  ): Promise<{ id: number; createdAtEpoch: number }> {
    const now = new Date();
    const nowEpoch = now.getTime();
    const userId = getUserId();

    await this.ensureSessionExists(sdkSessionId, project);

    const result = await query<{ id: number }>(
      `INSERT INTO session_summaries
       (sdk_session_id, project, user_id, request, investigated, learned, completed,
        next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        sdkSessionId, project, userId, summary.request, summary.investigated,
        summary.learned, summary.completed, summary.next_steps, summary.notes,
        promptNumber ?? null, discoveryTokens, now.toISOString(), nowEpoch
      ]
    );

    return { id: result.rows[0].id, createdAtEpoch: nowEpoch };
  }

  async getSummaryForSession(sdkSessionId: string): Promise<{
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    created_at: string;
  } | null> {
    const result = await query<{
      request: string | null;
      investigated: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      files_read: string | null;
      files_edited: string | null;
      notes: string | null;
      prompt_number: number | null;
      created_at: string;
    }>(
      `SELECT request, investigated, learned, completed, next_steps,
              files_read::text as files_read, files_edited::text as files_edited,
              notes, prompt_number, created_at
       FROM session_summaries WHERE sdk_session_id = $1
       ORDER BY created_at_epoch DESC LIMIT 1`,
      [sdkSessionId]
    );
    return result.rows[0] || null;
  }

  async getRecentSummaries(project: string, limit: number = 10): Promise<Array<{
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    created_at: string;
  }>> {
    const result = await query<{
      request: string | null;
      investigated: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      files_read: string | null;
      files_edited: string | null;
      notes: string | null;
      prompt_number: number | null;
      created_at: string;
    }>(
      `SELECT request, investigated, learned, completed, next_steps,
              files_read::text as files_read, files_edited::text as files_edited,
              notes, prompt_number, created_at
       FROM session_summaries WHERE project = $1
       ORDER BY created_at_epoch DESC LIMIT $2`,
      [project, limit]
    );
    return result.rows;
  }

  async getRecentSummariesWithSessionInfo(project: string, limit: number = 3): Promise<Array<{
    sdk_session_id: string;
    request: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    prompt_number: number | null;
    created_at: string;
  }>> {
    const result = await query<{
      sdk_session_id: string;
      request: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      prompt_number: number | null;
      created_at: string;
    }>(
      `SELECT sdk_session_id, request, learned, completed, next_steps, prompt_number, created_at
       FROM session_summaries WHERE project = $1
       ORDER BY created_at_epoch DESC LIMIT $2`,
      [project, limit]
    );
    return result.rows;
  }

  async getAllRecentSummaries(limit: number = 50): Promise<Array<{
    id: number;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    project: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }>> {
    const result = await query<{
      id: number;
      request: string | null;
      investigated: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      files_read: string | null;
      files_edited: string | null;
      notes: string | null;
      project: string;
      prompt_number: number | null;
      created_at: string;
      created_at_epoch: number;
    }>(
      `SELECT id, request, investigated, learned, completed, next_steps,
              files_read::text as files_read, files_edited::text as files_edited,
              notes, project, prompt_number, created_at, created_at_epoch
       FROM session_summaries ORDER BY created_at_epoch DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async getSessionSummariesByIds(ids: number[], options: QueryOptions = {}): Promise<SessionSummaryRecord[]> {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';

    let paramIndex = 1;
    const params: any[] = [ids];
    let sql = `SELECT * FROM session_summaries WHERE id = ANY($${paramIndex++})`;

    if (project) {
      sql += ` AND project = $${paramIndex++}`;
      params.push(project);
    }

    sql += ` ORDER BY created_at_epoch ${orderClause}`;
    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    const result = await query<SessionSummaryRecord>(sql, params);
    return result.rows;
  }

  // ============================
  // Query Operations
  // ============================

  async getAllProjects(): Promise<string[]> {
    const result = await query<{ project: string }>(
      `SELECT DISTINCT project FROM sdk_sessions
       WHERE project IS NOT NULL AND project != ''
       ORDER BY project ASC`
    );
    return result.rows.map(r => r.project);
  }

  async getRecentSessionsWithStatus(project: string, limit: number = 3): Promise<Array<{
    sdk_session_id: string | null;
    status: string;
    started_at: string;
    user_prompt: string | null;
    has_summary: boolean;
  }>> {
    const result = await query<{
      sdk_session_id: string | null;
      status: string;
      started_at: string;
      user_prompt: string | null;
      has_summary: boolean;
    }>(
      `SELECT
         s.sdk_session_id, s.status, s.started_at, s.user_prompt,
         EXISTS(SELECT 1 FROM session_summaries ss WHERE ss.sdk_session_id = s.sdk_session_id) as has_summary
       FROM sdk_sessions s
       WHERE s.project = $1 AND s.sdk_session_id IS NOT NULL
       ORDER BY s.started_at_epoch DESC
       LIMIT $2`,
      [project, limit]
    );
    return result.rows;
  }

  async getFilesForSession(sdkSessionId: string): Promise<{
    filesRead: string[];
    filesModified: string[];
  }> {
    const result = await query<{ files_read: any; files_modified: any }>(
      `SELECT files_read, files_modified FROM observations WHERE sdk_session_id = $1`,
      [sdkSessionId]
    );

    const filesReadSet = new Set<string>();
    const filesModifiedSet = new Set<string>();

    for (const row of result.rows) {
      if (row.files_read) {
        const files = typeof row.files_read === 'string' ? JSON.parse(row.files_read) : row.files_read;
        if (Array.isArray(files)) files.forEach(f => filesReadSet.add(f));
      }
      if (row.files_modified) {
        const files = typeof row.files_modified === 'string' ? JSON.parse(row.files_modified) : row.files_modified;
        if (Array.isArray(files)) files.forEach(f => filesModifiedSet.add(f));
      }
    }

    return {
      filesRead: Array.from(filesReadSet),
      filesModified: Array.from(filesModifiedSet)
    };
  }

  async getAllRecentUserPrompts(limit: number = 100): Promise<Array<{
    id: number;
    claude_session_id: string;
    project: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }>> {
    const result = await query<{
      id: number;
      claude_session_id: string;
      project: string;
      prompt_number: number;
      prompt_text: string;
      created_at: string;
      created_at_epoch: number;
    }>(
      `SELECT up.id, up.claude_session_id, s.project, up.prompt_number, up.prompt_text,
              up.created_at, up.created_at_epoch
       FROM user_prompts up
       LEFT JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
       ORDER BY up.created_at_epoch DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async getUserPromptsByIds(ids: number[], options: QueryOptions = {}): Promise<UserPromptRecord[]> {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';

    let paramIndex = 1;
    const params: any[] = [ids];
    let sql = `
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id = ANY($${paramIndex++})`;

    if (project) {
      sql += ` AND s.project = $${paramIndex++}`;
      params.push(project);
    }

    sql += ` ORDER BY up.created_at_epoch ${orderClause}`;
    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    const result = await query<UserPromptRecord>(sql, params);
    return result.rows;
  }

  async getPromptById(id: number): Promise<{
    id: number;
    claude_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  } | null> {
    const result = await query<{
      id: number;
      claude_session_id: string;
      prompt_number: number;
      prompt_text: string;
      project: string;
      created_at: string;
      created_at_epoch: number;
    }>(
      `SELECT p.id, p.claude_session_id, p.prompt_number, p.prompt_text, s.project,
              p.created_at, p.created_at_epoch
       FROM user_prompts p
       LEFT JOIN sdk_sessions s ON p.claude_session_id = s.claude_session_id
       WHERE p.id = $1 LIMIT 1`,
      [id]
    );
    return result.rows[0] || null;
  }

  async getPromptsByIds(ids: number[]): Promise<Array<{
    id: number;
    claude_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  }>> {
    if (ids.length === 0) return [];

    const result = await query<{
      id: number;
      claude_session_id: string;
      prompt_number: number;
      prompt_text: string;
      project: string;
      created_at: string;
      created_at_epoch: number;
    }>(
      `SELECT p.id, p.claude_session_id, p.prompt_number, p.prompt_text, s.project,
              p.created_at, p.created_at_epoch
       FROM user_prompts p
       LEFT JOIN sdk_sessions s ON p.claude_session_id = s.claude_session_id
       WHERE p.id = ANY($1)
       ORDER BY p.created_at_epoch DESC`,
      [ids]
    );
    return result.rows;
  }

  async getSessionSummaryById(id: number): Promise<{
    id: number;
    sdk_session_id: string | null;
    claude_session_id: string;
    project: string;
    user_prompt: string;
    request_summary: string | null;
    learned_summary: string | null;
    status: string;
    created_at: string;
    created_at_epoch: number;
  } | null> {
    const result = await query<{
      id: number;
      sdk_session_id: string | null;
      claude_session_id: string;
      project: string;
      user_prompt: string;
      request_summary: string | null;
      learned_summary: string | null;
      status: string;
      created_at: string;
      created_at_epoch: number;
    }>(
      `SELECT id, sdk_session_id, claude_session_id, project, user_prompt,
              request_summary, learned_summary, status, created_at, created_at_epoch
       FROM sdk_sessions WHERE id = $1 LIMIT 1`,
      [id]
    );
    return result.rows[0] || null;
  }

  async getSdkSessionsBySessionIds(sdkSessionIds: string[]): Promise<Array<{
    id: number;
    claude_session_id: string;
    sdk_session_id: string;
    project: string;
    user_prompt: string;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }>> {
    if (sdkSessionIds.length === 0) return [];

    const result = await query<{
      id: number;
      claude_session_id: string;
      sdk_session_id: string;
      project: string;
      user_prompt: string;
      started_at: string;
      started_at_epoch: number;
      completed_at: string | null;
      completed_at_epoch: number | null;
      status: string;
    }>(
      `SELECT id, claude_session_id, sdk_session_id, project, user_prompt,
              started_at, started_at_epoch, completed_at, completed_at_epoch, status
       FROM sdk_sessions WHERE sdk_session_id = ANY($1)
       ORDER BY started_at_epoch DESC`,
      [sdkSessionIds]
    );
    return result.rows;
  }

  // ============================
  // Timeline Operations
  // ============================

  async getTimelineAroundTimestamp(
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string
  ): Promise<{
    observations: any[];
    sessions: any[];
    prompts: any[];
  }> {
    return this.getTimelineAroundObservation(null, anchorEpoch, depthBefore, depthAfter, project);
  }

  async getTimelineAroundObservation(
    anchorObservationId: number | null,
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string
  ): Promise<{
    observations: any[];
    sessions: any[];
    prompts: any[];
  }> {
    const projectFilter = project ? 'AND project = $2' : '';
    const params: any[] = [anchorEpoch];
    if (project) params.push(project);

    // Get time boundaries
    const beforeResult = await query<{ created_at_epoch: number }>(
      `SELECT created_at_epoch FROM observations
       WHERE created_at_epoch <= $1 ${projectFilter}
       ORDER BY created_at_epoch DESC LIMIT $${params.length + 1}`,
      [...params, depthBefore]
    );

    const afterResult = await query<{ created_at_epoch: number }>(
      `SELECT created_at_epoch FROM observations
       WHERE created_at_epoch >= $1 ${projectFilter}
       ORDER BY created_at_epoch ASC LIMIT $${params.length + 1}`,
      [...params, depthAfter + 1]
    );

    if (beforeResult.rows.length === 0 && afterResult.rows.length === 0) {
      return { observations: [], sessions: [], prompts: [] };
    }

    const startEpoch = beforeResult.rows.length > 0
      ? beforeResult.rows[beforeResult.rows.length - 1].created_at_epoch
      : anchorEpoch;
    const endEpoch = afterResult.rows.length > 0
      ? afterResult.rows[afterResult.rows.length - 1].created_at_epoch
      : anchorEpoch;

    // Query all record types in time window
    const timeParams: any[] = [startEpoch, endEpoch];
    if (project) timeParams.push(project);

    const obsResult = await query(
      `SELECT * FROM observations
       WHERE created_at_epoch >= $1 AND created_at_epoch <= $2 ${projectFilter}
       ORDER BY created_at_epoch ASC`,
      timeParams
    );

    const sessResult = await query(
      `SELECT * FROM session_summaries
       WHERE created_at_epoch >= $1 AND created_at_epoch <= $2 ${projectFilter}
       ORDER BY created_at_epoch ASC`,
      timeParams
    );

    const promptProjectFilter = project ? 'AND s.project = $3' : '';
    const promptResult = await query(
      `SELECT up.*, s.project, s.sdk_session_id
       FROM user_prompts up
       JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
       WHERE up.created_at_epoch >= $1 AND up.created_at_epoch <= $2 ${promptProjectFilter}
       ORDER BY up.created_at_epoch ASC`,
      timeParams
    );

    return {
      observations: obsResult.rows,
      sessions: sessResult.rows,
      prompts: promptResult.rows
    };
  }

  // ============================
  // Import Operations
  // ============================

  async importSdkSession(session: {
    claude_session_id: string;
    sdk_session_id: string;
    project: string;
    user_prompt: string;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }): Promise<{ imported: boolean; id: number }> {
    // Check if exists
    const existing = await query<{ id: number }>(
      `SELECT id FROM sdk_sessions WHERE claude_session_id = $1`,
      [session.claude_session_id]
    );

    if (existing.rows[0]) {
      return { imported: false, id: existing.rows[0].id };
    }

    const result = await query<{ id: number }>(
      `INSERT INTO sdk_sessions
       (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch,
        completed_at, completed_at_epoch, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        session.claude_session_id, session.sdk_session_id, session.project, session.user_prompt,
        session.started_at, session.started_at_epoch, session.completed_at,
        session.completed_at_epoch, session.status
      ]
    );

    return { imported: true, id: result.rows[0].id };
  }

  async importSessionSummary(summary: {
    sdk_session_id: string;
    project: string;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
  }): Promise<{ imported: boolean; id: number }> {
    const existing = await query<{ id: number }>(
      `SELECT id FROM session_summaries WHERE sdk_session_id = $1`,
      [summary.sdk_session_id]
    );

    if (existing.rows[0]) {
      return { imported: false, id: existing.rows[0].id };
    }

    const result = await query<{ id: number }>(
      `INSERT INTO session_summaries
       (sdk_session_id, project, request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        summary.sdk_session_id, summary.project, summary.request, summary.investigated,
        summary.learned, summary.completed, summary.next_steps,
        summary.files_read, summary.files_edited, summary.notes,
        summary.prompt_number, summary.discovery_tokens || 0,
        summary.created_at, summary.created_at_epoch
      ]
    );

    return { imported: true, id: result.rows[0].id };
  }

  async importObservation(obs: {
    sdk_session_id: string;
    project: string;
    text: string | null;
    type: string;
    title: string | null;
    subtitle: string | null;
    facts: string | null;
    narrative: string | null;
    concepts: string | null;
    files_read: string | null;
    files_modified: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
  }): Promise<{ imported: boolean; id: number }> {
    const existing = await query<{ id: number }>(
      `SELECT id FROM observations
       WHERE sdk_session_id = $1 AND title = $2 AND created_at_epoch = $3`,
      [obs.sdk_session_id, obs.title, obs.created_at_epoch]
    );

    if (existing.rows[0]) {
      return { imported: false, id: existing.rows[0].id };
    }

    const result = await query<{ id: number }>(
      `INSERT INTO observations
       (sdk_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
        files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        obs.sdk_session_id, obs.project, obs.text, obs.type, obs.title, obs.subtitle,
        obs.facts, obs.narrative, obs.concepts, obs.files_read, obs.files_modified,
        obs.prompt_number, obs.discovery_tokens || 0, obs.created_at, obs.created_at_epoch
      ]
    );

    return { imported: true, id: result.rows[0].id };
  }

  async importUserPrompt(prompt: {
    claude_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }): Promise<{ imported: boolean; id: number }> {
    const existing = await query<{ id: number }>(
      `SELECT id FROM user_prompts WHERE claude_session_id = $1 AND prompt_number = $2`,
      [prompt.claude_session_id, prompt.prompt_number]
    );

    if (existing.rows[0]) {
      return { imported: false, id: existing.rows[0].id };
    }

    const result = await query<{ id: number }>(
      `INSERT INTO user_prompts
       (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [prompt.claude_session_id, prompt.prompt_number, prompt.prompt_text,
       prompt.created_at, prompt.created_at_epoch]
    );

    return { imported: true, id: result.rows[0].id };
  }

  // ============================
  // Lifecycle
  // ============================

  async close(): Promise<void> {
    await closePool();
  }
}

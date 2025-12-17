/**
 * Data Routes
 *
 * Handles data retrieval operations: observations, summaries, prompts, stats, processing status.
 * All endpoints use direct database access via domain services.
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, statSync, existsSync } from 'fs';
import { homedir } from 'os';
import { getPackageRoot } from '../../../../shared/paths.js';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { PaginationHelper } from '../../PaginationHelper.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

export class DataRoutes extends BaseRouteHandler {
  constructor(
    private paginationHelper: PaginationHelper,
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager,
    private sseBroadcaster: SSEBroadcaster,
    private workerService: WorkerService,
    private startTime: number
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Pagination endpoints
    app.get('/api/observations', this.handleGetObservations.bind(this));
    app.get('/api/summaries', this.handleGetSummaries.bind(this));
    app.get('/api/prompts', this.handleGetPrompts.bind(this));

    // Fetch by ID endpoints
    app.get('/api/observation/:id', this.handleGetObservationById.bind(this));
    app.post('/api/observations/batch', this.handleGetObservationsByIds.bind(this));
    app.get('/api/session/:id', this.handleGetSessionById.bind(this));
    app.post('/api/sdk-sessions/batch', this.handleGetSdkSessionsByIds.bind(this));
    app.get('/api/prompt/:id', this.handleGetPromptById.bind(this));

    // Metadata endpoints
    app.get('/api/stats', this.handleGetStats.bind(this));
    app.get('/api/projects', this.handleGetProjects.bind(this));

    // Processing status endpoints
    app.get('/api/processing-status', this.handleGetProcessingStatus.bind(this));
    app.post('/api/processing', this.handleSetProcessing.bind(this));

    // Import endpoint
    app.post('/api/import', this.handleImport.bind(this));
  }

  /**
   * Get paginated observations
   */
  private handleGetObservations = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { offset, limit, project } = this.parsePaginationParams(req);
    const result = await this.paginationHelper.getObservations(offset, limit, project);
    res.json(result);
  });

  /**
   * Get paginated summaries
   */
  private handleGetSummaries = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { offset, limit, project } = this.parsePaginationParams(req);
    const result = await this.paginationHelper.getSummaries(offset, limit, project);
    res.json(result);
  });

  /**
   * Get paginated user prompts
   */
  private handleGetPrompts = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { offset, limit, project } = this.parsePaginationParams(req);
    const result = await this.paginationHelper.getPrompts(offset, limit, project);
    res.json(result);
  });

  /**
   * Get observation by ID
   * GET /api/observation/:id
   */
  private handleGetObservationById = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    // Await handles both sync (SQLite) and async (PostgreSQL) stores
    const observation = await Promise.resolve(store.getObservationById(id));

    if (!observation) {
      this.notFound(res, `Observation #${id} not found`);
      return;
    }

    res.json(observation);
  });

  /**
   * Get observations by array of IDs
   * POST /api/observations/batch
   * Body: { ids: number[], orderBy?: 'date_desc' | 'date_asc', limit?: number, project?: string }
   */
  private handleGetObservationsByIds = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { ids, orderBy, limit, project } = req.body;

    if (!ids || !Array.isArray(ids)) {
      this.badRequest(res, 'ids must be an array of numbers');
      return;
    }

    if (ids.length === 0) {
      res.json([]);
      return;
    }

    // Validate all IDs are numbers
    if (!ids.every(id => typeof id === 'number' && Number.isInteger(id))) {
      this.badRequest(res, 'All ids must be integers');
      return;
    }

    const store = this.dbManager.getSessionStore();
    // Await handles both sync (SQLite) and async (PostgreSQL) stores
    const observations = await Promise.resolve(store.getObservationsByIds(ids, { orderBy, limit, project }));

    res.json(observations);
  });

  /**
   * Get session by ID
   * GET /api/session/:id
   */
  private handleGetSessionById = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    // Await handles both sync (SQLite) and async (PostgreSQL) stores
    const sessions = await Promise.resolve(store.getSessionSummariesByIds([id]));

    if (sessions.length === 0) {
      this.notFound(res, `Session #${id} not found`);
      return;
    }

    res.json(sessions[0]);
  });

  /**
   * Get SDK sessions by SDK session IDs
   * POST /api/sdk-sessions/batch
   * Body: { sdkSessionIds: string[] }
   */
  private handleGetSdkSessionsByIds = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { sdkSessionIds } = req.body;

    if (!Array.isArray(sdkSessionIds)) {
      this.badRequest(res, 'sdkSessionIds must be an array');
      return;
    }

    const store = this.dbManager.getSessionStore();
    // Await handles both sync (SQLite) and async (PostgreSQL) stores
    const sessions = await Promise.resolve(store.getSdkSessionsBySessionIds(sdkSessionIds));
    res.json(sessions);
  });

  /**
   * Get user prompt by ID
   * GET /api/prompt/:id
   */
  private handleGetPromptById = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    // Await handles both sync (SQLite) and async (PostgreSQL) stores
    const prompts = await Promise.resolve(store.getUserPromptsByIds([id]));

    if (prompts.length === 0) {
      this.notFound(res, `Prompt #${id} not found`);
      return;
    }

    res.json(prompts[0]);
  });

  /**
   * Get database statistics (with worker metadata)
   */
  private handleGetStats = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    // Read version from package.json
    const packageRoot = getPackageRoot();
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version;

    let totalObservations: number;
    let totalSessions: number;
    let totalSummaries: number;
    let dbPath: string;
    let dbSize = 0;

    if (this.dbManager.isPostgres()) {
      // PostgreSQL
      const { query } = await import('../../../postgres/pool.js');
      const obsResult = await query<{ count: string }>('SELECT COUNT(*) as count FROM observations');
      const sessResult = await query<{ count: string }>('SELECT COUNT(*) as count FROM sdk_sessions');
      const sumResult = await query<{ count: string }>('SELECT COUNT(*) as count FROM session_summaries');

      totalObservations = parseInt(obsResult.rows[0]?.count || '0', 10);
      totalSessions = parseInt(sessResult.rows[0]?.count || '0', 10);
      totalSummaries = parseInt(sumResult.rows[0]?.count || '0', 10);
      dbPath = process.env.CLAUDE_MEM_DATABASE_URL || 'postgres://...';
    } else {
      // SQLite
      const db = this.dbManager.getSessionStore().db;
      const obsResult = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      const sessResult = db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
      const sumResult = db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };

      totalObservations = obsResult.count;
      totalSessions = sessResult.count;
      totalSummaries = sumResult.count;

      dbPath = path.join(homedir(), '.claude-mem', 'claude-mem.db');
      if (existsSync(dbPath)) {
        dbSize = statSync(dbPath).size;
      }
    }

    // Worker metadata
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const activeSessions = this.sessionManager.getActiveSessionCount();
    const sseClients = this.sseBroadcaster.getClientCount();

    res.json({
      worker: {
        version,
        uptime,
        activeSessions,
        sseClients,
        port: getWorkerPort(),
        backend: this.dbManager.isPostgres() ? 'postgres' : 'sqlite'
      },
      database: {
        path: dbPath,
        size: dbSize,
        observations: totalObservations,
        sessions: totalSessions,
        summaries: totalSummaries
      }
    });
  });

  /**
   * Get list of distinct projects from observations
   * GET /api/projects
   */
  private handleGetProjects = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    let projects: string[];

    if (this.dbManager.isPostgres()) {
      // PostgreSQL - include aggregate in SELECT to satisfy ORDER BY requirement
      const { query } = await import('../../../postgres/pool.js');
      const result = await query<{ project: string }>(`
        SELECT project, MAX(created_at_epoch) as last_activity
        FROM observations
        WHERE project IS NOT NULL
        GROUP BY project
        ORDER BY last_activity DESC
      `);
      projects = result.rows.map(row => row.project);
    } else {
      // SQLite - more lenient, works with implicit aggregate in ORDER BY
      const db = this.dbManager.getSessionStore().db;
      const rows = db.prepare(`
        SELECT project
        FROM observations
        WHERE project IS NOT NULL
        GROUP BY project
        ORDER BY MAX(created_at_epoch) DESC
      `).all() as Array<{ project: string }>;
      projects = rows.map(row => row.project);
    }

    res.json({ projects });
  });

  /**
   * Get current processing status
   * GET /api/processing-status
   */
  private handleGetProcessingStatus = this.wrapHandler((req: Request, res: Response): void => {
    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork(); // Includes queued + actively processing
    res.json({ isProcessing, queueDepth });
  });

  /**
   * Set processing status (called by hooks)
   * NOTE: This now broadcasts computed status based on active processing (ignores input)
   */
  private handleSetProcessing = this.wrapHandler((req: Request, res: Response): void => {
    // Broadcast current computed status (ignores manual input)
    this.workerService.broadcastProcessingStatus();

    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalQueueDepth();
    const activeSessions = this.sessionManager.getActiveSessionCount();

    res.json({ status: 'ok', isProcessing });
  });

  /**
   * Parse pagination parameters from request query
   */
  private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string } {
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100); // Max 100
    const project = req.query.project as string | undefined;

    return { offset, limit, project };
  }

  /**
   * Import memories from export file
   * POST /api/import
   * Body: { sessions: [], summaries: [], observations: [], prompts: [] }
   */
  private handleImport = this.wrapHandler((req: Request, res: Response): void => {
    const { sessions, summaries, observations, prompts } = req.body;

    const stats = {
      sessionsImported: 0,
      sessionsSkipped: 0,
      summariesImported: 0,
      summariesSkipped: 0,
      observationsImported: 0,
      observationsSkipped: 0,
      promptsImported: 0,
      promptsSkipped: 0
    };

    const store = this.dbManager.getSessionStore();

    // Import sessions first (dependency for everything else)
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        const result = store.importSdkSession(session);
        if (result.imported) {
          stats.sessionsImported++;
        } else {
          stats.sessionsSkipped++;
        }
      }
    }

    // Import summaries (depends on sessions)
    if (Array.isArray(summaries)) {
      for (const summary of summaries) {
        const result = store.importSessionSummary(summary);
        if (result.imported) {
          stats.summariesImported++;
        } else {
          stats.summariesSkipped++;
        }
      }
    }

    // Import observations (depends on sessions)
    if (Array.isArray(observations)) {
      for (const obs of observations) {
        const result = store.importObservation(obs);
        if (result.imported) {
          stats.observationsImported++;
        } else {
          stats.observationsSkipped++;
        }
      }
    }

    // Import prompts (depends on sessions)
    if (Array.isArray(prompts)) {
      for (const prompt of prompts) {
        const result = store.importUserPrompt(prompt);
        if (result.imported) {
          stats.promptsImported++;
        } else {
          stats.promptsSkipped++;
        }
      }
    }

    res.json({
      success: true,
      stats
    });
  });
}

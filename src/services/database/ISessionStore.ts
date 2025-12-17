/**
 * ISessionStore Interface
 *
 * Abstract interface for session/observation storage backends.
 * Implementations: SQLiteSessionStore (default), PostgresSessionStore (for team sharing)
 *
 * All methods are async to support both sync (SQLite) and async (PostgreSQL) backends.
 */

import type {
  ObservationRecord,
  SessionSummaryRecord,
  UserPromptRecord
} from '../../types/database.js';

// Observation input for storage
export interface ObservationInput {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

// Summary input for storage
export interface SummaryInput {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

// Session record for queries
export interface SessionRecord {
  id: number;
  claude_session_id: string;
  sdk_session_id: string | null;
  project: string;
  user_prompt: string | null;
  user_id?: string | null;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: string;
  worker_port: number | null;
  prompt_counter: number | null;
}

// Query options for batch operations
export interface QueryOptions {
  orderBy?: 'date_desc' | 'date_asc';
  limit?: number;
  project?: string;
  type?: string | string[];
  concepts?: string | string[];
  files?: string | string[];
}

export interface ISessionStore {
  // ============================
  // Session Management
  // ============================

  /**
   * Create or get existing SDK session (idempotent)
   * Returns the session database ID
   */
  createSDKSession(claudeSessionId: string, project: string, userPrompt: string): Promise<number>;

  /**
   * Find active SDK session for a Claude session
   */
  findActiveSDKSession(claudeSessionId: string): Promise<{
    id: number;
    sdk_session_id: string | null;
    project: string;
    worker_port: number | null;
  } | null>;

  /**
   * Find any SDK session (active, failed, or completed)
   */
  findAnySDKSession(claudeSessionId: string): Promise<{ id: number } | null>;

  /**
   * Reactivate an existing session
   */
  reactivateSession(id: number, userPrompt: string): Promise<void>;

  /**
   * Get session by ID
   */
  getSessionById(id: number): Promise<{
    id: number;
    claude_session_id: string;
    sdk_session_id: string | null;
    project: string;
    user_prompt: string;
  } | null>;

  /**
   * Update SDK session ID
   */
  updateSDKSessionId(id: number, sdkSessionId: string): Promise<boolean>;

  /**
   * Set worker port for session
   */
  setWorkerPort(id: number, port: number): Promise<void>;

  /**
   * Get worker port for session
   */
  getWorkerPort(id: number): Promise<number | null>;

  /**
   * Mark session as completed
   */
  markSessionCompleted(id: number): Promise<void>;

  /**
   * Mark session as failed
   */
  markSessionFailed(id: number): Promise<void>;

  // ============================
  // Prompt Tracking
  // ============================

  /**
   * Increment prompt counter and return new value
   */
  incrementPromptCounter(id: number): Promise<number>;

  /**
   * Get current prompt counter
   */
  getPromptCounter(id: number): Promise<number>;

  /**
   * Save user prompt
   */
  saveUserPrompt(claudeSessionId: string, promptNumber: number, promptText: string): Promise<number>;

  /**
   * Get user prompt by session and number
   */
  getUserPrompt(claudeSessionId: string, promptNumber: number): Promise<string | null>;

  /**
   * Get latest user prompt with session info
   */
  getLatestUserPrompt(claudeSessionId: string): Promise<{
    id: number;
    claude_session_id: string;
    sdk_session_id: string;
    project: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  } | undefined>;

  // ============================
  // Observation Storage
  // ============================

  /**
   * Store an observation
   */
  storeObservation(
    sdkSessionId: string,
    project: string,
    observation: ObservationInput,
    promptNumber?: number,
    discoveryTokens?: number
  ): Promise<{ id: number; createdAtEpoch: number }>;

  /**
   * Get observation by ID
   */
  getObservationById(id: number): Promise<ObservationRecord | null>;

  /**
   * Get observations by IDs with filtering
   */
  getObservationsByIds(ids: number[], options?: QueryOptions): Promise<ObservationRecord[]>;

  /**
   * Get observations for a session
   */
  getObservationsForSession(sdkSessionId: string): Promise<Array<{
    title: string;
    subtitle: string;
    type: string;
    prompt_number: number | null;
  }>>;

  /**
   * Get recent observations for a project
   */
  getRecentObservations(project: string, limit?: number): Promise<Array<{
    type: string;
    text: string;
    prompt_number: number | null;
    created_at: string;
  }>>;

  /**
   * Get all recent observations (for UI)
   */
  getAllRecentObservations(limit?: number): Promise<Array<{
    id: number;
    type: string;
    title: string | null;
    subtitle: string | null;
    text: string;
    project: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }>>;

  // ============================
  // Summary Storage
  // ============================

  /**
   * Store a session summary
   */
  storeSummary(
    sdkSessionId: string,
    project: string,
    summary: SummaryInput,
    promptNumber?: number,
    discoveryTokens?: number
  ): Promise<{ id: number; createdAtEpoch: number }>;

  /**
   * Get summary for a session
   */
  getSummaryForSession(sdkSessionId: string): Promise<{
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
  } | null>;

  /**
   * Get recent summaries for a project
   */
  getRecentSummaries(project: string, limit?: number): Promise<Array<{
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
  }>>;

  /**
   * Get recent summaries with session info
   */
  getRecentSummariesWithSessionInfo(project: string, limit?: number): Promise<Array<{
    sdk_session_id: string;
    request: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    prompt_number: number | null;
    created_at: string;
  }>>;

  /**
   * Get all recent summaries (for UI)
   */
  getAllRecentSummaries(limit?: number): Promise<Array<{
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
  }>>;

  /**
   * Get session summaries by IDs
   */
  getSessionSummariesByIds(ids: number[], options?: QueryOptions): Promise<SessionSummaryRecord[]>;

  // ============================
  // Query Operations
  // ============================

  /**
   * Get all unique projects
   */
  getAllProjects(): Promise<string[]>;

  /**
   * Get recent sessions with status
   */
  getRecentSessionsWithStatus(project: string, limit?: number): Promise<Array<{
    sdk_session_id: string | null;
    status: string;
    started_at: string;
    user_prompt: string | null;
    has_summary: boolean;
  }>>;

  /**
   * Get files for a session
   */
  getFilesForSession(sdkSessionId: string): Promise<{
    filesRead: string[];
    filesModified: string[];
  }>;

  /**
   * Get all recent user prompts (for UI)
   */
  getAllRecentUserPrompts(limit?: number): Promise<Array<{
    id: number;
    claude_session_id: string;
    project: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }>>;

  /**
   * Get user prompts by IDs
   */
  getUserPromptsByIds(ids: number[], options?: QueryOptions): Promise<UserPromptRecord[]>;

  /**
   * Get prompt by ID
   */
  getPromptById(id: number): Promise<{
    id: number;
    claude_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  } | null>;

  /**
   * Get prompts by IDs
   */
  getPromptsByIds(ids: number[]): Promise<Array<{
    id: number;
    claude_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  }>>;

  /**
   * Get session summary by ID
   */
  getSessionSummaryById(id: number): Promise<{
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
  } | null>;

  /**
   * Get SDK sessions by session IDs
   */
  getSdkSessionsBySessionIds(sdkSessionIds: string[]): Promise<Array<{
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
  }>>;

  // ============================
  // Timeline Operations
  // ============================

  /**
   * Get timeline around a timestamp
   */
  getTimelineAroundTimestamp(
    anchorEpoch: number,
    depthBefore?: number,
    depthAfter?: number,
    project?: string
  ): Promise<{
    observations: any[];
    sessions: any[];
    prompts: any[];
  }>;

  /**
   * Get timeline around an observation
   */
  getTimelineAroundObservation(
    anchorObservationId: number | null,
    anchorEpoch: number,
    depthBefore?: number,
    depthAfter?: number,
    project?: string
  ): Promise<{
    observations: any[];
    sessions: any[];
    prompts: any[];
  }>;

  // ============================
  // Import Operations (for data migration)
  // ============================

  /**
   * Import SDK session (idempotent)
   */
  importSdkSession(session: {
    claude_session_id: string;
    sdk_session_id: string;
    project: string;
    user_prompt: string;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }): Promise<{ imported: boolean; id: number }>;

  /**
   * Import session summary (idempotent)
   */
  importSessionSummary(summary: {
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
  }): Promise<{ imported: boolean; id: number }>;

  /**
   * Import observation (idempotent)
   */
  importObservation(obs: {
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
  }): Promise<{ imported: boolean; id: number }>;

  /**
   * Import user prompt (idempotent)
   */
  importUserPrompt(prompt: {
    claude_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }): Promise<{ imported: boolean; id: number }>;

  // ============================
  // Lifecycle
  // ============================

  /**
   * Close database connection
   */
  close(): Promise<void>;
}

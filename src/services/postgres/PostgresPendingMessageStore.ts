/**
 * PostgresPendingMessageStore - Async work queue for PostgreSQL backend
 *
 * Provides the same functionality as PendingMessageStore but uses
 * PostgreSQL async queries instead of SQLite sync operations.
 */

import { query } from './pool.js';
import type { PendingMessage } from '../worker-types.js';
import type { PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';

/**
 * PostgreSQL implementation of PendingMessageStore
 * All methods are async to work with the connection pool
 */
export class PostgresPendingMessageStore {
  private maxRetries: number;

  constructor(maxRetries: number = 3) {
    this.maxRetries = maxRetries;
  }

  /**
   * Enqueue a new message (persist before processing)
   * @returns The database ID of the persisted message
   */
  async enqueue(sessionDbId: number, claudeSessionId: string, message: PendingMessage): Promise<number> {
    const now = Date.now();
    const result = await query<{ id: number }>(
      `INSERT INTO pending_messages (
        session_db_id, claude_session_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_user_message, last_assistant_message,
        prompt_number, status, retry_count, created_at_epoch
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 0, $11)
      RETURNING id`,
      [
        sessionDbId,
        claudeSessionId,
        message.type,
        message.tool_name || null,
        message.tool_input ? JSON.stringify(message.tool_input) : null,
        message.tool_response ? JSON.stringify(message.tool_response) : null,
        message.cwd || null,
        message.last_user_message || null,
        message.last_assistant_message || null,
        message.prompt_number || null,
        now
      ]
    );

    return result.rows[0].id;
  }

  /**
   * Peek at oldest pending message for session (does NOT change status)
   * @returns The oldest pending message or null if none
   */
  async peekPending(sessionDbId: number): Promise<PersistentPendingMessage | null> {
    const result = await query<PersistentPendingMessage>(
      `SELECT * FROM pending_messages
       WHERE session_db_id = $1 AND status = 'pending'
       ORDER BY id ASC
       LIMIT 1`,
      [sessionDbId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all pending messages for session (ordered by creation time)
   */
  async getAllPending(sessionDbId: number): Promise<PersistentPendingMessage[]> {
    const result = await query<PersistentPendingMessage>(
      `SELECT * FROM pending_messages
       WHERE session_db_id = $1 AND status = 'pending'
       ORDER BY id ASC`,
      [sessionDbId]
    );
    return result.rows;
  }

  /**
   * Get all queue messages (for UI display)
   */
  async getQueueMessages(): Promise<(PersistentPendingMessage & { project: string | null })[]> {
    const result = await query<PersistentPendingMessage & { project: string | null }>(
      `SELECT pm.*, ss.project
       FROM pending_messages pm
       LEFT JOIN sdk_sessions ss ON pm.claude_session_id = ss.claude_session_id
       WHERE pm.status IN ('pending', 'processing', 'failed')
       ORDER BY
         CASE pm.status
           WHEN 'failed' THEN 0
           WHEN 'processing' THEN 1
           WHEN 'pending' THEN 2
         END,
         pm.created_at_epoch ASC`
    );
    return result.rows;
  }

  /**
   * Get count of stuck messages (processing longer than threshold)
   */
  async getStuckCount(thresholdMs: number): Promise<number> {
    const cutoff = Date.now() - thresholdMs;
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM pending_messages
       WHERE status = 'processing' AND started_processing_at_epoch < $1`,
      [cutoff]
    );
    return parseInt(result.rows[0]?.count || '0', 10);
  }

  /**
   * Retry a specific message (reset to pending)
   */
  async retryMessage(messageId: number): Promise<boolean> {
    const result = await query(
      `UPDATE pending_messages
       SET status = 'pending', started_processing_at_epoch = NULL
       WHERE id = $1 AND status IN ('pending', 'processing', 'failed')`,
      [messageId]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * Reset all processing messages for a session to pending
   */
  async resetProcessingToPending(sessionDbId: number): Promise<number> {
    const result = await query(
      `UPDATE pending_messages
       SET status = 'pending', started_processing_at_epoch = NULL
       WHERE session_db_id = $1 AND status = 'processing'`,
      [sessionDbId]
    );
    return result.rowCount || 0;
  }

  /**
   * Abort a specific message (delete from queue)
   */
  async abortMessage(messageId: number): Promise<boolean> {
    const result = await query(
      'DELETE FROM pending_messages WHERE id = $1',
      [messageId]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * Retry all stuck messages at once
   */
  async retryAllStuck(thresholdMs: number): Promise<number> {
    const cutoff = Date.now() - thresholdMs;
    const result = await query(
      `UPDATE pending_messages
       SET status = 'pending', started_processing_at_epoch = NULL
       WHERE status = 'processing' AND started_processing_at_epoch < $1`,
      [cutoff]
    );
    return result.rowCount || 0;
  }

  /**
   * Get recently processed messages (for UI feedback)
   */
  async getRecentlyProcessed(limit: number = 10, withinMinutes: number = 30): Promise<(PersistentPendingMessage & { project: string | null })[]> {
    const cutoff = Date.now() - (withinMinutes * 60 * 1000);
    const result = await query<PersistentPendingMessage & { project: string | null }>(
      `SELECT pm.*, ss.project
       FROM pending_messages pm
       LEFT JOIN sdk_sessions ss ON pm.claude_session_id = ss.claude_session_id
       WHERE pm.status = 'processed' AND pm.completed_at_epoch > $1
       ORDER BY pm.completed_at_epoch DESC
       LIMIT $2`,
      [cutoff, limit]
    );
    return result.rows;
  }

  /**
   * Mark message as being processed (status: pending -> processing)
   */
  async markProcessing(messageId: number): Promise<void> {
    const now = Date.now();
    await query(
      `UPDATE pending_messages
       SET status = 'processing', started_processing_at_epoch = $1
       WHERE id = $2 AND status = 'pending'`,
      [now, messageId]
    );
  }

  /**
   * Mark message as successfully processed (status: processing -> processed)
   */
  async markProcessed(messageId: number): Promise<void> {
    const now = Date.now();
    await query(
      `UPDATE pending_messages
       SET
         status = 'processed',
         completed_at_epoch = $1,
         tool_input = NULL,
         tool_response = NULL
       WHERE id = $2 AND status = 'processing'`,
      [now, messageId]
    );
  }

  /**
   * Mark message as failed
   */
  async markFailed(messageId: number): Promise<void> {
    const now = Date.now();

    // Get current retry count
    const result = await query<{ retry_count: number }>(
      'SELECT retry_count FROM pending_messages WHERE id = $1',
      [messageId]
    );

    const msg = result.rows[0];
    if (!msg) return;

    if (msg.retry_count < this.maxRetries) {
      // Move back to pending for retry
      await query(
        `UPDATE pending_messages
         SET status = 'pending', retry_count = retry_count + 1, started_processing_at_epoch = NULL
         WHERE id = $1`,
        [messageId]
      );
    } else {
      // Max retries exceeded, mark as permanently failed
      await query(
        `UPDATE pending_messages
         SET status = 'failed', completed_at_epoch = $1
         WHERE id = $2`,
        [now, messageId]
      );
    }
  }

  /**
   * Reset stuck messages (processing -> pending if stuck longer than threshold)
   */
  async resetStuckMessages(thresholdMs: number): Promise<number> {
    const cutoff = thresholdMs === 0 ? Date.now() : Date.now() - thresholdMs;
    const result = await query(
      `UPDATE pending_messages
       SET status = 'pending', started_processing_at_epoch = NULL
       WHERE status = 'processing' AND started_processing_at_epoch < $1`,
      [cutoff]
    );
    return result.rowCount || 0;
  }

  /**
   * Get count of pending messages for a session
   */
  async getPendingCount(sessionDbId: number): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM pending_messages
       WHERE session_db_id = $1 AND status IN ('pending', 'processing')`,
      [sessionDbId]
    );
    return parseInt(result.rows[0]?.count || '0', 10);
  }

  /**
   * Check if any session has pending work
   */
  async hasAnyPendingWork(): Promise<boolean> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM pending_messages
       WHERE status IN ('pending', 'processing')`
    );
    return parseInt(result.rows[0]?.count || '0', 10) > 0;
  }

  /**
   * Get all session IDs that have pending messages (for recovery on startup)
   */
  async getSessionsWithPendingMessages(): Promise<number[]> {
    const result = await query<{ session_db_id: number }>(
      `SELECT DISTINCT session_db_id FROM pending_messages
       WHERE status IN ('pending', 'processing')`
    );
    return result.rows.map(r => r.session_db_id);
  }

  /**
   * Get session info for a pending message (for recovery)
   */
  async getSessionInfoForMessage(messageId: number): Promise<{ sessionDbId: number; claudeSessionId: string } | null> {
    const result = await query<{ session_db_id: number; claude_session_id: string }>(
      `SELECT session_db_id, claude_session_id FROM pending_messages WHERE id = $1`,
      [messageId]
    );
    const row = result.rows[0];
    return row ? { sessionDbId: row.session_db_id, claudeSessionId: row.claude_session_id } : null;
  }

  /**
   * Cleanup old processed messages (retention policy)
   */
  async cleanupProcessed(retentionCount: number = 100): Promise<number> {
    const result = await query(
      `DELETE FROM pending_messages
       WHERE status = 'processed'
       AND id NOT IN (
         SELECT id FROM pending_messages
         WHERE status = 'processed'
         ORDER BY completed_at_epoch DESC
         LIMIT $1
       )`,
      [retentionCount]
    );
    return result.rowCount || 0;
  }

  /**
   * Convert a PersistentPendingMessage back to PendingMessage format
   */
  toPendingMessage(persistent: PersistentPendingMessage): PendingMessage {
    return {
      type: persistent.message_type,
      tool_name: persistent.tool_name || undefined,
      tool_input: persistent.tool_input ? JSON.parse(persistent.tool_input) : undefined,
      tool_response: persistent.tool_response ? JSON.parse(persistent.tool_response) : undefined,
      prompt_number: persistent.prompt_number || undefined,
      cwd: persistent.cwd || undefined,
      last_user_message: persistent.last_user_message || undefined,
      last_assistant_message: persistent.last_assistant_message || undefined
    };
  }
}

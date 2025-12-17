import { SessionStore } from '../../sqlite/SessionStore.js';
import { logger } from '../../../utils/logger.js';

// Store type that supports both SQLite and PostgreSQL
type SessionStoreType = SessionStore | { getUserPrompt(claudeSessionId: string, promptNumber: number): Promise<string | null> | string | null };

/**
 * Validates user prompt privacy for session operations
 *
 * Centralizes privacy checks to avoid duplicate validation logic across route handlers.
 * If user prompt was entirely private (stripped to empty string), we skip processing.
 */
export class PrivacyCheckValidator {
  /**
   * Check if user prompt is public (not entirely private)
   *
   * @param store - SessionStore instance (SQLite or PostgreSQL)
   * @param claudeSessionId - Claude session ID
   * @param promptNumber - Prompt number within session
   * @param operationType - Type of operation being validated ('observation' or 'summarize')
   * @returns User prompt text if public, null if private
   */
  static async checkUserPromptPrivacy(
    store: SessionStoreType,
    claudeSessionId: string,
    promptNumber: number,
    operationType: 'observation' | 'summarize',
    sessionDbId: number,
    additionalContext?: Record<string, any>
  ): Promise<string | null> {
    // Handle both sync (SQLite) and async (PostgreSQL) stores
    const userPrompt = await Promise.resolve(store.getUserPrompt(claudeSessionId, promptNumber));

    if (!userPrompt || userPrompt.trim() === '') {
      logger.debug('HOOK', `Skipping ${operationType} - user prompt was entirely private`, {
        sessionId: sessionDbId,
        promptNumber,
        ...additionalContext
      });
      return null;
    }

    return userPrompt;
  }
}

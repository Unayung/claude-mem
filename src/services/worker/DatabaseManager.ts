/**
 * DatabaseManager: Single long-lived database connection
 *
 * Responsibility:
 * - Manage single database connection for worker lifetime
 * - Provide centralized access to SessionStore and SessionSearch
 * - High-level database operations
 * - ChromaSync integration
 *
 * Supports SQLite (default) and PostgreSQL (for team sharing).
 * Set CLAUDE_MEM_DATABASE=postgres to use PostgreSQL.
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { PendingMessageStore } from '../sqlite/PendingMessageStore.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';

// PostgreSQL imports (dynamic to avoid loading when using SQLite)
type PostgresSessionStoreType = import('../postgres/PostgresSessionStore.js').PostgresSessionStore;
type PostgresPendingMessageStoreType = import('../postgres/PostgresPendingMessageStore.js').PostgresPendingMessageStore;

export type DatabaseBackend = 'sqlite' | 'postgres';

export class DatabaseManager {
  private sessionStore: SessionStore | PostgresSessionStoreType | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;
  private pendingStore: PendingMessageStore | PostgresPendingMessageStoreType | null = null;
  private backend: DatabaseBackend = 'sqlite';

  /**
   * Get configured database backend
   */
  private getBackendType(): DatabaseBackend {
    const dbType = process.env.CLAUDE_MEM_DATABASE?.toLowerCase();
    if (dbType === 'postgres' || dbType === 'postgresql') {
      return 'postgres';
    }
    return 'sqlite';
  }

  /**
   * Initialize database connection (once, stays open)
   */
  async initialize(): Promise<void> {
    this.backend = this.getBackendType();

    if (this.backend === 'postgres') {
      // Check for required PostgreSQL URL
      if (!process.env.CLAUDE_MEM_DATABASE_URL) {
        throw new Error('CLAUDE_MEM_DATABASE_URL is required when CLAUDE_MEM_DATABASE=postgres');
      }

      // Dynamic import to avoid loading pg when not needed
      const { PostgresSessionStore } = await import('../postgres/PostgresSessionStore.js');
      const { PostgresPendingMessageStore } = await import('../postgres/PostgresPendingMessageStore.js');
      const pgStore = new PostgresSessionStore();
      await pgStore.initialize();
      this.sessionStore = pgStore;
      this.pendingStore = new PostgresPendingMessageStore(3); // maxRetries = 3

      // Note: SessionSearch for PostgreSQL would need a separate implementation
      // For now, using SQLite search as fallback (hybrid search via Chroma)
      this.sessionSearch = null; // PostgreSQL uses different search patterns

      logger.info('DB', 'PostgreSQL database initialized', {
        url: process.env.CLAUDE_MEM_DATABASE_URL?.replace(/:[^:@]+@/, ':***@') // Mask password
      });
    } else {
      // SQLite (default)
      this.sessionStore = new SessionStore();
      this.sessionSearch = new SessionSearch();
      this.pendingStore = new PendingMessageStore(this.sessionStore.db, 3); // maxRetries = 3
      logger.info('DB', 'SQLite database initialized');
    }

    // Initialize ChromaSync (works with both backends)
    this.chromaSync = new ChromaSync('claude-mem');

    // Start background backfill (fire-and-forget, with error logging)
    this.chromaSync.ensureBackfilled().catch((error) => {
      logger.error('DB', 'Chroma backfill failed (non-fatal)', {}, error);
    });

    logger.info('DB', 'Database initialized', { backend: this.backend });
  }

  /**
   * Get current backend type
   */
  getBackend(): DatabaseBackend {
    return this.backend;
  }

  /**
   * Check if using PostgreSQL backend
   */
  isPostgres(): boolean {
    return this.backend === 'postgres';
  }

  /**
   * Close database connection and cleanup all resources
   */
  async close(): Promise<void> {
    // Close ChromaSync first (terminates uvx/python processes)
    if (this.chromaSync) {
      try {
        await this.chromaSync.close();
        this.chromaSync = null;
      } catch (error) {
        logger.error('DB', 'Failed to close ChromaSync', {}, error as Error);
      }
    }

    if (this.sessionStore) {
      if (this.backend === 'postgres') {
        // PostgreSQL close is async
        await (this.sessionStore as PostgresSessionStoreType).close();
      } else {
        // SQLite close is sync
        (this.sessionStore as SessionStore).close();
      }
      this.sessionStore = null;
    }
    if (this.sessionSearch) {
      this.sessionSearch.close();
      this.sessionSearch = null;
    }
    logger.info('DB', 'Database closed', { backend: this.backend });
  }

  /**
   * Get SessionStore instance (throws if not initialized)
   * Returns SQLite or PostgreSQL store depending on backend configuration
   */
  getSessionStore(): SessionStore | PostgresSessionStoreType {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  /**
   * Get SessionStore as SQLite type (throws if PostgreSQL backend)
   * Use this when you specifically need SQLite-only features
   */
  getSQLiteSessionStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    if (this.backend === 'postgres') {
      throw new Error('SQLite session store not available with PostgreSQL backend');
    }
    return this.sessionStore as SessionStore;
  }

  /**
   * Get SessionSearch instance
   * Returns null for PostgreSQL backend (FTS handled differently)
   */
  getSessionSearch(): SessionSearch | null {
    return this.sessionSearch;
  }

  /**
   * Check if SessionSearch is available (false for PostgreSQL)
   */
  hasSessionSearch(): boolean {
    return this.sessionSearch !== null;
  }

  /**
   * Get ChromaSync instance (throws if not initialized)
   */
  getChromaSync(): ChromaSync {
    if (!this.chromaSync) {
      throw new Error('ChromaSync not initialized');
    }
    return this.chromaSync;
  }

  /**
   * Get PendingMessageStore instance (throws if not initialized)
   * Returns SQLite or PostgreSQL store depending on backend configuration
   */
  getPendingMessageStore(): PendingMessageStore | PostgresPendingMessageStoreType {
    if (!this.pendingStore) {
      throw new Error('PendingMessageStore not initialized');
    }
    return this.pendingStore;
  }

  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // Worker restarts don't make sessions orphaned. Sessions are managed by hooks
  // and exist independently of worker state.

  /**
   * Get session by ID (throws if not found)
   * Note: For PostgreSQL backend, this must be awaited
   */
  async getSessionByIdAsync(sessionDbId: number): Promise<{
    id: number;
    claude_session_id: string;
    sdk_session_id: string | null;
    project: string;
    user_prompt: string;
  }> {
    const store = this.getSessionStore();
    let session;
    if (this.backend === 'postgres') {
      session = await (store as PostgresSessionStoreType).getSessionById(sessionDbId);
    } else {
      session = (store as SessionStore).getSessionById(sessionDbId);
    }
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

  /**
   * Get session by ID (throws if not found)
   * @deprecated Use getSessionByIdAsync for PostgreSQL compatibility
   */
  getSessionById(sessionDbId: number): {
    id: number;
    claude_session_id: string;
    sdk_session_id: string | null;
    project: string;
    user_prompt: string;
  } {
    if (this.backend === 'postgres') {
      throw new Error('Use getSessionByIdAsync() for PostgreSQL backend');
    }
    const session = (this.getSessionStore() as SessionStore).getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

  /**
   * Mark session as completed
   * Note: For PostgreSQL backend, this must be awaited
   */
  async markSessionCompleteAsync(sessionDbId: number): Promise<void> {
    const store = this.getSessionStore();
    if (this.backend === 'postgres') {
      await (store as PostgresSessionStoreType).markSessionCompleted(sessionDbId);
    } else {
      (store as SessionStore).markSessionCompleted(sessionDbId);
    }
  }

  /**
   * Mark session as completed
   * @deprecated Use markSessionCompleteAsync for PostgreSQL compatibility
   */
  markSessionComplete(sessionDbId: number): void {
    if (this.backend === 'postgres') {
      throw new Error('Use markSessionCompleteAsync() for PostgreSQL backend');
    }
    (this.getSessionStore() as SessionStore).markSessionCompleted(sessionDbId);
  }
}

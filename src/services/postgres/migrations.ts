/**
 * PostgreSQL Migrations
 *
 * Schema creation and management for PostgreSQL backend.
 * Designed to be compatible with SQLite schema structure.
 */

import { PoolClient } from 'pg';
import { query, transaction } from './pool.js';
import { logger } from '../../utils/logger.js';

/**
 * Run all migrations
 */
export async function runMigrations(): Promise<void> {
  logger.info('PG_MIGRATE', 'Running PostgreSQL migrations...');

  await transaction(async (client) => {
    // Create schema_versions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id SERIAL PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Get applied versions
    const result = await client.query('SELECT version FROM schema_versions ORDER BY version');
    const appliedVersions = new Set(result.rows.map(r => r.version));

    // Run each migration if not applied
    for (const migration of migrations) {
      if (!appliedVersions.has(migration.version)) {
        logger.info('PG_MIGRATE', `Applying migration ${migration.version}: ${migration.name}`);
        await migration.up(client);
        await client.query(
          'INSERT INTO schema_versions (version) VALUES ($1)',
          [migration.version]
        );
      }
    }
  });

  logger.info('PG_MIGRATE', 'PostgreSQL migrations complete');
}

interface Migration {
  version: number;
  name: string;
  up: (client: PoolClient) => Promise<void>;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'Create core tables',
    up: async (client) => {
      // SDK Sessions table
      await client.query(`
        CREATE TABLE sdk_sessions (
          id SERIAL PRIMARY KEY,
          claude_session_id TEXT UNIQUE NOT NULL,
          sdk_session_id TEXT UNIQUE,
          project TEXT NOT NULL,
          user_id TEXT,
          user_prompt TEXT,
          started_at TIMESTAMPTZ NOT NULL,
          started_at_epoch BIGINT NOT NULL,
          completed_at TIMESTAMPTZ,
          completed_at_epoch BIGINT,
          status TEXT CHECK(status IN ('active', 'completed', 'failed')) DEFAULT 'active',
          worker_port INTEGER,
          prompt_counter INTEGER DEFAULT 0
        )
      `);

      await client.query('CREATE INDEX idx_sdk_sessions_claude_id ON sdk_sessions(claude_session_id)');
      await client.query('CREATE INDEX idx_sdk_sessions_sdk_id ON sdk_sessions(sdk_session_id)');
      await client.query('CREATE INDEX idx_sdk_sessions_project ON sdk_sessions(project)');
      await client.query('CREATE INDEX idx_sdk_sessions_status ON sdk_sessions(status)');
      await client.query('CREATE INDEX idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)');
      await client.query('CREATE INDEX idx_sdk_sessions_user ON sdk_sessions(user_id)');

      // Observations table
      await client.query(`
        CREATE TABLE observations (
          id SERIAL PRIMARY KEY,
          sdk_session_id TEXT NOT NULL REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE,
          project TEXT NOT NULL,
          user_id TEXT,
          text TEXT,
          type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
          title TEXT,
          subtitle TEXT,
          facts JSONB,
          narrative TEXT,
          concepts JSONB,
          files_read JSONB,
          files_modified JSONB,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL,
          created_at_epoch BIGINT NOT NULL,
          search_vector tsvector
        )
      `);

      await client.query('CREATE INDEX idx_observations_sdk_session ON observations(sdk_session_id)');
      await client.query('CREATE INDEX idx_observations_project ON observations(project)');
      await client.query('CREATE INDEX idx_observations_type ON observations(type)');
      await client.query('CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC)');
      await client.query('CREATE INDEX idx_observations_project_created ON observations(project, created_at_epoch DESC)');
      await client.query('CREATE INDEX idx_observations_user ON observations(user_id)');
      await client.query('CREATE INDEX idx_observations_search ON observations USING GIN(search_vector)');

      // Session summaries table
      await client.query(`
        CREATE TABLE session_summaries (
          id SERIAL PRIMARY KEY,
          sdk_session_id TEXT NOT NULL REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE,
          project TEXT NOT NULL,
          user_id TEXT,
          request TEXT,
          investigated TEXT,
          learned TEXT,
          completed TEXT,
          next_steps TEXT,
          files_read JSONB,
          files_edited JSONB,
          notes TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL,
          created_at_epoch BIGINT NOT NULL,
          search_vector tsvector
        )
      `);

      await client.query('CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(sdk_session_id)');
      await client.query('CREATE INDEX idx_session_summaries_project ON session_summaries(project)');
      await client.query('CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC)');
      await client.query('CREATE INDEX idx_session_summaries_user ON session_summaries(user_id)');
      await client.query('CREATE INDEX idx_session_summaries_search ON session_summaries USING GIN(search_vector)');

      // User prompts table
      await client.query(`
        CREATE TABLE user_prompts (
          id SERIAL PRIMARY KEY,
          claude_session_id TEXT NOT NULL REFERENCES sdk_sessions(claude_session_id) ON DELETE CASCADE,
          user_id TEXT,
          prompt_number INTEGER NOT NULL,
          prompt_text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          created_at_epoch BIGINT NOT NULL
        )
      `);

      await client.query('CREATE INDEX idx_user_prompts_claude_session ON user_prompts(claude_session_id)');
      await client.query('CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC)');
      await client.query('CREATE INDEX idx_user_prompts_lookup ON user_prompts(claude_session_id, prompt_number)');

      // Pending messages table (for work queue)
      await client.query(`
        CREATE TABLE pending_messages (
          id SERIAL PRIMARY KEY,
          session_db_id INTEGER NOT NULL REFERENCES sdk_sessions(id) ON DELETE CASCADE,
          claude_session_id TEXT NOT NULL,
          message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
          tool_name TEXT,
          tool_input TEXT,
          tool_response TEXT,
          cwd TEXT,
          last_user_message TEXT,
          last_assistant_message TEXT,
          prompt_number INTEGER,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
          retry_count INTEGER NOT NULL DEFAULT 0,
          created_at_epoch BIGINT NOT NULL,
          started_processing_at_epoch BIGINT,
          completed_at_epoch BIGINT
        )
      `);

      await client.query('CREATE INDEX idx_pending_messages_session ON pending_messages(session_db_id)');
      await client.query('CREATE INDEX idx_pending_messages_status ON pending_messages(status)');
      await client.query('CREATE INDEX idx_pending_messages_claude_session ON pending_messages(claude_session_id)');
    }
  },
  {
    version: 2,
    name: 'Create full-text search triggers',
    up: async (client) => {
      // Trigger function for observations search vector
      await client.query(`
        CREATE OR REPLACE FUNCTION update_observations_search() RETURNS trigger AS $$
        BEGIN
          NEW.search_vector := to_tsvector('english',
            COALESCE(NEW.title, '') || ' ' ||
            COALESCE(NEW.subtitle, '') || ' ' ||
            COALESCE(NEW.narrative, '')
          );
          RETURN NEW;
        END
        $$ LANGUAGE plpgsql
      `);

      await client.query(`
        CREATE TRIGGER observations_search_update
          BEFORE INSERT OR UPDATE ON observations
          FOR EACH ROW EXECUTE FUNCTION update_observations_search()
      `);

      // Trigger function for session summaries search vector
      await client.query(`
        CREATE OR REPLACE FUNCTION update_summaries_search() RETURNS trigger AS $$
        BEGIN
          NEW.search_vector := to_tsvector('english',
            COALESCE(NEW.request, '') || ' ' ||
            COALESCE(NEW.learned, '') || ' ' ||
            COALESCE(NEW.completed, '')
          );
          RETURN NEW;
        END
        $$ LANGUAGE plpgsql
      `);

      await client.query(`
        CREATE TRIGGER summaries_search_update
          BEFORE INSERT OR UPDATE ON session_summaries
          FOR EACH ROW EXECUTE FUNCTION update_summaries_search()
      `);
    }
  }
];

/**
 * Check if database is initialized
 */
export async function isDatabaseInitialized(): Promise<boolean> {
  try {
    const result = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'sdk_sessions'
      ) as exists
    `);
    return result.rows[0]?.exists === true;
  } catch {
    return false;
  }
}

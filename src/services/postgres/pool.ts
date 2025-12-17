/**
 * PostgreSQL Connection Pool
 *
 * Manages database connections for the PostgreSQL backend.
 * Uses pg-pool for connection management with sensible defaults.
 */

import { Pool, PoolConfig, PoolClient, QueryResult } from 'pg';
import { logger } from '../../utils/logger.js';

let pool: Pool | null = null;

/**
 * Get default pool configuration
 */
function getDefaultConfig(): PoolConfig {
  return {
    // Connection settings
    connectionString: process.env.CLAUDE_MEM_DATABASE_URL,

    // Pool size
    max: 10,                    // Max connections in pool
    min: 2,                     // Min connections to maintain
    idleTimeoutMillis: 30000,   // Close idle connections after 30s
    connectionTimeoutMillis: 5000, // Timeout when acquiring connection

    // Keep-alive
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  };
}

/**
 * Initialize the connection pool
 */
export function initPool(config?: Partial<PoolConfig>): Pool {
  if (pool) {
    return pool;
  }

  const finalConfig = { ...getDefaultConfig(), ...config };

  if (!finalConfig.connectionString) {
    throw new Error('CLAUDE_MEM_DATABASE_URL is required for PostgreSQL backend');
  }

  pool = new Pool(finalConfig);

  // Handle pool errors
  pool.on('error', (err) => {
    logger.error('PG_POOL', 'Unexpected error on idle client', {}, err);
  });

  pool.on('connect', () => {
    logger.debug('PG_POOL', 'New client connected to pool');
  });

  logger.info('PG_POOL', 'PostgreSQL connection pool initialized', {
    max: finalConfig.max,
    connectionString: maskConnectionString(finalConfig.connectionString)
  });

  return pool;
}

/**
 * Get the connection pool (initializes if needed)
 */
export function getPool(): Pool {
  if (!pool) {
    return initPool();
  }
  return pool;
}

/**
 * Execute a query using the pool
 */
export async function query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await getPool().query<T>(text, params);
  const duration = Date.now() - start;

  logger.debug('PG_QUERY', 'Executed query', {
    text: text.substring(0, 100),
    duration,
    rowCount: result.rowCount
  });

  return result;
}

/**
 * Get a client from the pool for transactions
 */
export async function getClient(): Promise<PoolClient> {
  return getPool().connect();
}

/**
 * Execute a transaction
 */
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Close the connection pool
 */
export async function closePool(): Promise<void> {
  if (pool) {
    logger.info('PG_POOL', 'Closing PostgreSQL connection pool');
    await pool.end();
    pool = null;
  }
}

/**
 * Check if pool is connected and healthy
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const result = await query('SELECT 1 as health');
    return result.rows[0]?.health === 1;
  } catch (err) {
    logger.error('PG_POOL', 'Health check failed', {}, err);
    return false;
  }
}

/**
 * Mask sensitive parts of connection string for logging
 */
function maskConnectionString(connString: string): string {
  try {
    const url = new URL(connString);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '[invalid connection string]';
  }
}

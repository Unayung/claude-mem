import path from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { ProcessManager } from "../services/process/ProcessManager.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { getWorkerRestartInstructions } from "../utils/error-messages.js";

const MARKETPLACE_ROOT = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

// Named constants for health checks
const HEALTH_CHECK_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK);

// Port cache to avoid repeated settings file reads
let cachedPort: number | null = null;
let cachedPorts: number[] | null = null;

// Default primary port (SQLite worker)
const DEFAULT_PRIMARY_PORT = 37777;

/**
 * Get the worker port number from settings
 * Priority: ENV var > settings file > default
 * Caches the port value to avoid repeated file reads
 */
export function getWorkerPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }

  // 1. Check environment variable first (highest priority)
  if (process.env.CLAUDE_MEM_WORKER_PORT) {
    const envPort = parseInt(process.env.CLAUDE_MEM_WORKER_PORT, 10);
    if (!isNaN(envPort) && envPort >= 1024 && envPort <= 65535) {
      cachedPort = envPort;
      return cachedPort;
    }
  }

  // 2. Try settings file
  try {
    const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    cachedPort = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
    return cachedPort;
  } catch (error) {
    // Fallback to default if settings load fails
    logger.debug('SYSTEM', 'Failed to load port from settings, using default', { error });
    cachedPort = parseInt(SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT'), 10);
    return cachedPort;
  }
}

/**
 * Clear the cached port value
 * Call this when settings are updated to force re-reading from file
 */
export function clearPortCache(): void {
  cachedPort = null;
  cachedPorts = null;
}

/**
 * Get all worker ports to send data to (multi-port fan-out support)
 *
 * Primary port (37777 default) is ALWAYS included - it's the local SQLite worker.
 * Additional ports from CLAUDE_MEM_WORKER_PORTS are added for team sharing (e.g., PostgreSQL).
 *
 * Example:
 *   CLAUDE_MEM_WORKER_PORTS=38888,39999 → returns [37777, 38888, 39999]
 *   (no env var set) → returns [37777]
 *
 * @returns Array of unique port numbers, primary port always first
 */
export function getWorkerPorts(): number[] {
  if (cachedPorts !== null) {
    return cachedPorts;
  }

  const ports = new Set<number>();

  // 1. Always include the primary port (local SQLite worker)
  const primaryPort = getWorkerPort();
  ports.add(primaryPort);

  // 2. Add additional ports from CLAUDE_MEM_WORKER_PORTS env var
  const additionalPortsEnv = process.env.CLAUDE_MEM_WORKER_PORTS;
  if (additionalPortsEnv) {
    const additionalPorts = additionalPortsEnv
      .split(',')
      .map(p => parseInt(p.trim(), 10))
      .filter(p => !isNaN(p) && p >= 1024 && p <= 65535);

    for (const port of additionalPorts) {
      ports.add(port);
    }
  }

  // Convert to array with primary port first
  cachedPorts = [primaryPort, ...Array.from(ports).filter(p => p !== primaryPort)];
  return cachedPorts;
}

/**
 * Check if multi-port mode is enabled
 * @returns true if additional ports are configured beyond the primary
 */
export function isMultiPortEnabled(): boolean {
  return getWorkerPorts().length > 1;
}

/**
 * Fan-out a request to all configured worker ports
 *
 * Sends the same request to all ports in parallel. Primary port (37777) failures
 * are critical and will throw. Secondary port failures are logged but don't fail
 * the overall operation.
 *
 * @param path - URL path (e.g., '/api/session/123/observations')
 * @param options - Fetch options (method, body, headers, etc.)
 * @returns Response from the primary port
 */
export async function fanOutRequest(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const ports = getWorkerPorts();
  const host = getWorkerHost();

  // Send to all ports in parallel
  const requests = ports.map(async (port, index) => {
    const url = `http://${host}:${port}${path}`;
    const isPrimary = index === 0;

    try {
      const response = await fetch(url, options);

      if (!response.ok && isPrimary) {
        // Primary port failure is critical
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Primary worker (port ${port}) returned ${response.status}: ${errorText}`);
      }

      if (!response.ok && !isPrimary) {
        // Secondary port failure - log but don't fail
        logger.warn('MULTI_PORT', `Secondary worker (port ${port}) returned ${response.status}`, {
          path,
          port,
          status: response.status
        });
      }

      return { port, response, isPrimary, success: response.ok };
    } catch (error: any) {
      if (isPrimary) {
        // Primary port failure is critical
        throw error;
      }

      // Secondary port failure - log but don't fail
      logger.warn('MULTI_PORT', `Secondary worker (port ${port}) request failed`, {
        path,
        port,
        error: error.message
      });

      return { port, response: null, isPrimary, success: false };
    }
  });

  const results = await Promise.all(requests);

  // Return the primary port's response
  const primaryResult = results.find(r => r.isPrimary);
  if (!primaryResult?.response) {
    throw new Error('Primary worker request failed');
  }

  // Log multi-port status if enabled
  if (ports.length > 1) {
    const successCount = results.filter(r => r.success).length;
    logger.debug('MULTI_PORT', `Fan-out complete: ${successCount}/${ports.length} ports succeeded`, {
      path,
      ports: results.map(r => ({ port: r.port, success: r.success }))
    });
  }

  return primaryResult.response;
}

/**
 * Fan-out a POST request with JSON body to all configured worker ports
 * Convenience wrapper around fanOutRequest for JSON POST requests
 */
export async function fanOutPost(
  path: string,
  body: any,
  timeoutMs?: number
): Promise<Response> {
  const options: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };

  if (timeoutMs) {
    options.signal = AbortSignal.timeout(timeoutMs);
  }

  return fanOutRequest(path, options);
}

/**
 * Get the worker host address
 * Priority: ~/.claude-mem/settings.json > env var > default (127.0.0.1)
 */
export function getWorkerHost(): string {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_WORKER_HOST;
}

/**
 * Check if worker is responsive by trying the health endpoint
 */
async function isWorkerHealthy(): Promise<boolean> {
  try {
    const port = getWorkerPort();
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
    });
    return response.ok;
  } catch (error) {
    logger.debug('SYSTEM', 'Worker health check failed', {
      error: error instanceof Error ? error.message : String(error),
      errorType: error?.constructor?.name
    });
    return false;
  }
}

/**
 * Get the current plugin version from package.json
 */
function getPluginVersion(): string | null {
  try {
    const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch (error) {
    logger.debug('SYSTEM', 'Failed to read plugin version', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Get the running worker's version from the API
 */
async function getWorkerVersion(): Promise<string | null> {
  try {
    const port = getWorkerPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/version`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const data = await response.json() as { version: string };
    return data.version;
  } catch (error) {
    logger.debug('SYSTEM', 'Failed to get worker version', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Check if worker version matches plugin version
 * If mismatch detected, restart the worker automatically
 */
async function ensureWorkerVersionMatches(): Promise<void> {
  const pluginVersion = getPluginVersion();
  const workerVersion = await getWorkerVersion();

  if (!pluginVersion || !workerVersion) {
    // Can't determine versions, skip check
    return;
  }

  if (pluginVersion !== workerVersion) {
    logger.info('SYSTEM', 'Worker version mismatch detected - restarting worker', {
      pluginVersion,
      workerVersion
    });

    // Give files time to sync before restart
    await new Promise(resolve => setTimeout(resolve, getTimeout(HOOK_TIMEOUTS.PRE_RESTART_SETTLE_DELAY)));

    // Restart the worker
    await ProcessManager.restart(getWorkerPort());

    // Give it a moment to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify it's healthy
    if (!await isWorkerHealthy()) {
      logger.error('SYSTEM', 'Worker failed to restart after version mismatch', {
        expectedVersion: pluginVersion,
        runningVersion: workerVersion,
        port: getWorkerPort()
      });
    }
  }
}

/**
 * Start the worker service using ProcessManager
 * Handles both Unix (Bun) and Windows (compiled exe) platforms
 */
async function startWorker(): Promise<boolean> {
  // Clean up legacy PM2 (one-time migration)
  const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
  const pm2MigratedMarker = path.join(dataDir, '.pm2-migrated');

  // Ensure data directory exists (may not exist on fresh install)
  mkdirSync(dataDir, { recursive: true });

  if (!existsSync(pm2MigratedMarker)) {
    try {
      spawnSync('pm2', ['delete', 'claude-mem-worker'], { stdio: 'ignore' });
      // Mark migration as complete
      writeFileSync(pm2MigratedMarker, new Date().toISOString(), 'utf-8');
      logger.debug('SYSTEM', 'PM2 cleanup completed and marked');
    } catch {
      // PM2 not installed or process doesn't exist - still mark as migrated
      writeFileSync(pm2MigratedMarker, new Date().toISOString(), 'utf-8');
    }
  }

  const port = getWorkerPort();
  const result = await ProcessManager.start(port);

  if (!result.success) {
    logger.error('SYSTEM', 'Failed to start worker', {
      platform: process.platform,
      port,
      error: result.error,
      marketplaceRoot: MARKETPLACE_ROOT
    });
  }

  return result.success;
}

/**
 * Ensure worker service is running
 * Checks health and auto-starts if not running
 * Also ensures worker version matches plugin version
 */
export async function ensureWorkerRunning(): Promise<void> {
  // Check if already healthy
  if (await isWorkerHealthy()) {
    // Worker is healthy, but check if version matches
    await ensureWorkerVersionMatches();
    return;
  }

  // Try to start the worker
  const started = await startWorker();

  if (!started) {
    const port = getWorkerPort();
    throw new Error(
      getWorkerRestartInstructions({
        port,
        customPrefix: `Worker service failed to start on port ${port}.`
      })
    );
  }

  // Wait for worker to become responsive after starting
  // Try up to 5 times with 500ms delays (2.5 seconds total)
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (await isWorkerHealthy()) {
      await ensureWorkerVersionMatches();
      return;
    }
  }

  // Worker started but isn't responding
  const port = getWorkerPort();
  logger.error('SYSTEM', 'Worker started but not responding to health checks');
  throw new Error(
    getWorkerRestartInstructions({
      port,
      customPrefix: `Worker service started but is not responding on port ${port}.`
    })
  );
}

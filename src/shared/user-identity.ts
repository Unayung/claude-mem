/**
 * User Identity Helper
 *
 * Simple user identification for multi-user database sharing.
 * Uses git config user.name if available, falls back to hostname.
 * No user management - just attribution for observations.
 */

import { execSync } from 'child_process';
import { hostname } from 'os';

let cachedUserId: string | null = null;

/**
 * Get the current user ID for attribution.
 * Tries git config user.name first, falls back to hostname.
 * Result is cached for performance.
 */
export function getUserId(): string {
  if (cachedUserId !== null) {
    return cachedUserId;
  }

  try {
    // Try git config first - most likely to be a meaningful identifier
    const gitUser = execSync('git config user.name', {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['pipe', 'pipe', 'ignore'] // Suppress stderr
    }).trim();

    if (gitUser) {
      cachedUserId = gitUser;
      return cachedUserId;
    }
  } catch {
    // Git not available or not configured - fall through to hostname
  }

  // Fall back to hostname
  cachedUserId = hostname();
  return cachedUserId;
}

/**
 * Clear the cached user ID (for testing)
 */
export function clearUserIdCache(): void {
  cachedUserId = null;
}

/**
 * Set user ID explicitly (for testing or override)
 */
export function setUserId(userId: string): void {
  cachedUserId = userId;
}

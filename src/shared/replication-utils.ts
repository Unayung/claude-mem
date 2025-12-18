/**
 * Replication Utilities
 *
 * Handles replicating processed observations and summaries to secondary worker ports.
 * This ensures AI processing happens only once (on primary), then results are copied.
 */

import { getWorkerPort, getWorkerPorts, getWorkerHost } from './worker-utils.js';
import { logger } from '../utils/logger.js';

/**
 * Check if replication is enabled (multiple ports configured)
 */
export function isReplicationEnabled(): boolean {
  return getWorkerPorts().length > 1;
}

/**
 * Get secondary ports (all ports except primary)
 */
export function getSecondaryPorts(): number[] {
  const allPorts = getWorkerPorts();
  const primaryPort = getWorkerPort();
  return allPorts.filter(p => p !== primaryPort);
}

/**
 * Replicate an observation to all secondary ports
 * Fire-and-forget - errors are logged but don't fail the primary operation
 */
export async function replicateObservation(data: {
  claudeSessionId: string;
  project: string;
  observation: any;
  promptNumber: number;
  discoveryTokens: number;
  obsId: number;
  createdAtEpoch: number;
}): Promise<void> {
  const secondaryPorts = getSecondaryPorts();
  if (secondaryPorts.length === 0) return;

  const host = getWorkerHost();

  for (const port of secondaryPorts) {
    try {
      const response = await fetch(`http://${host}:${port}/api/replicate/observation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        logger.warn('REPLICATION', `Failed to replicate observation to port ${port}`, {
          status: response.status,
          obsId: data.obsId
        });
      } else {
        logger.debug('REPLICATION', `Observation replicated to port ${port}`, {
          obsId: data.obsId
        });
      }
    } catch (error: any) {
      logger.warn('REPLICATION', `Error replicating observation to port ${port}`, {
        error: error.message,
        obsId: data.obsId
      });
    }
  }
}

/**
 * Replicate a summary to all secondary ports
 * Fire-and-forget - errors are logged but don't fail the primary operation
 */
export async function replicateSummary(data: {
  claudeSessionId: string;
  project: string;
  summary: any;
  promptNumber: number;
  discoveryTokens: number;
  summaryId: number;
  createdAtEpoch: number;
}): Promise<void> {
  const secondaryPorts = getSecondaryPorts();
  if (secondaryPorts.length === 0) return;

  const host = getWorkerHost();

  for (const port of secondaryPorts) {
    try {
      const response = await fetch(`http://${host}:${port}/api/replicate/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        logger.warn('REPLICATION', `Failed to replicate summary to port ${port}`, {
          status: response.status,
          summaryId: data.summaryId
        });
      } else {
        logger.debug('REPLICATION', `Summary replicated to port ${port}`, {
          summaryId: data.summaryId
        });
      }
    } catch (error: any) {
      logger.warn('REPLICATION', `Error replicating summary to port ${port}`, {
        error: error.message,
        summaryId: data.summaryId
      });
    }
  }
}

/**
 * Replicate session initialization to all secondary ports
 * Fire-and-forget - errors are logged but don't fail the primary operation
 */
export async function replicateSessionInit(data: {
  claudeSessionId: string;
  project: string;
  prompt: string;
  sessionDbId: number;
  promptNumber: number;
}): Promise<void> {
  const secondaryPorts = getSecondaryPorts();
  if (secondaryPorts.length === 0) return;

  const host = getWorkerHost();

  for (const port of secondaryPorts) {
    try {
      const response = await fetch(`http://${host}:${port}/api/replicate/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        logger.warn('REPLICATION', `Failed to replicate session to port ${port}`, {
          status: response.status,
          sessionDbId: data.sessionDbId
        });
      } else {
        logger.debug('REPLICATION', `Session replicated to port ${port}`, {
          sessionDbId: data.sessionDbId
        });
      }
    } catch (error: any) {
      logger.warn('REPLICATION', `Error replicating session to port ${port}`, {
        error: error.message,
        sessionDbId: data.sessionDbId
      });
    }
  }
}

/**
 * Replicate user prompt to all secondary ports
 */
export async function replicateUserPrompt(data: {
  claudeSessionId: string;
  promptNumber: number;
  promptText: string;
}): Promise<void> {
  const secondaryPorts = getSecondaryPorts();
  if (secondaryPorts.length === 0) return;

  const host = getWorkerHost();

  for (const port of secondaryPorts) {
    try {
      const response = await fetch(`http://${host}:${port}/api/replicate/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        logger.warn('REPLICATION', `Failed to replicate prompt to port ${port}`, {
          status: response.status,
          promptNumber: data.promptNumber
        });
      } else {
        logger.debug('REPLICATION', `Prompt replicated to port ${port}`, {
          promptNumber: data.promptNumber
        });
      }
    } catch (error: any) {
      logger.warn('REPLICATION', `Error replicating prompt to port ${port}`, {
        error: error.message,
        promptNumber: data.promptNumber
      });
    }
  }
}

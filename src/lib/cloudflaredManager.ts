import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';
import { getHostPortForContainer, portMappingCache } from './dockerPortManager.js';

export interface TunnelInfo {
  publicUrl: string;
  process: ChildProcess;
  subdomain: string;
  actualPort: number;
  tunnelId?: string;
}

// Enhanced process tracking with metadata
interface TunnelProcess {
  process: ChildProcess;
  subdomain: string;
  publicUrl: string;
  startTime: number;
  lastHealthCheck?: number;
}

const cloudflaredProcesses = new Map<number, TunnelProcess>();
const prSubdomains = new Map<number, string>();

// Global process cleanup with enhanced error handling
const setupGlobalCleanup = (() => {
  let setupDone = false;
  return () => {
    if (setupDone) return;
    setupDone = true;

    const cleanup = async (signal: string) => {
      logger.info({ signal, processCount: cloudflaredProcesses.size }, '🧹 Global cleanup triggered');

      const cleanupPromises = Array.from(cloudflaredProcesses.entries()).map(async ([prNumber, tunnelProcess]) => {
        try {
          tunnelProcess.process.kill('SIGTERM');

          // Give process time to gracefully shutdown
          await new Promise(resolve => setTimeout(resolve, 2000));

          if (!tunnelProcess.process.killed) {
            tunnelProcess.process.kill('SIGKILL');
          }

          logger.info({ pr: prNumber, subdomain: tunnelProcess.subdomain }, '✅ Cleaned up tunnel process');
        } catch (error) {
          logger.warn({ err: error, pr: prNumber }, '⚠️ Error during tunnel cleanup');
        }
      });

      await Promise.allSettled(cleanupPromises);
      cloudflaredProcesses.clear();
      prSubdomains.clear();
      portMappingCache.clear();

      logger.info('🏁 Global tunnel cleanup complete');
    };

    process.on('exit', () => cleanup('exit'));
    process.on('SIGINT', () => cleanup('SIGINT').then(() => process.exit(0)));
    process.on('SIGTERM', () => cleanup('SIGTERM').then(() => process.exit(0)));
  };
})();

/**
 * Enhanced tunnel startup with optimized port detection
 */
export async function startHttpTunnel(
  containerPort: number,
  containerName: string,
  prNumber?: number
): Promise<TunnelInfo> {
  setupGlobalCleanup();

  logger.info({ containerPort, containerName, prNumber }, '🔌 Starting enhanced cloudflared tunnel');

  // Get actual Docker host port using Docker API (faster than docker port command)
  let actualPort: number;
  try {
    actualPort = await getHostPortForContainer(containerName, containerPort);
    logger.info({ containerName, containerPort, actualPort, prNumber }, '📍 Retrieved port mapping via Docker API');
  } catch (error) {
    logger.error({ err: error, containerName, containerPort, prNumber }, '❌ Failed to get port mapping');
    throw error;
  }

  // Generate UUID subdomain with better entropy
  const uuid = randomUUID();
  const subdomain = `${uuid}.muozez.com`;

  if (prNumber) {
    // Clean up any existing tunnel for this PR
    await stopTunnelForPR(prNumber);
    prSubdomains.set(prNumber, subdomain);
  }

  // Verify credentials exist
  const credentialsPath = path.resolve(process.cwd(), 'keys', 'tunnel-credentials.json');
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Tunnel credentials not found at ${credentialsPath}. Run: cloudflared tunnel create envzilla`);
  }

  const tunnelName = process.env.CLOUDFLARED_TUNNEL_NAME || 'envzilla';
  const args = [
    'tunnel', 'run',
    '--credentials-file', credentialsPath,
    '--url', `http://localhost:${actualPort}`,
    '--hostname', subdomain,
    '--protocol', process.env.CLOUDFLARED_PROTOCOL || 'http2',
    '--logfile', `/tmp/cloudflared-pr-${prNumber || 'unknown'}.log`, // Better debugging
    tunnelName
  ];

  logger.info({ args, prNumber, subdomain, actualPort }, 'Starting cloudflared with enhanced config');

  const child = spawn('cloudflared', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Optimize for faster startup
      TUNNEL_ORIGIN_CERT: process.env.CLOUDFLARE_ORIGIN_CERT_PATH,
      TUNNEL_CREDS_FILE: credentialsPath
    },
    detached: false
  });

  const startTime = Date.now();
  let resolved = false;
  let connectionEstablished = false;

  const urlPromise = new Promise<string>((resolve, reject) => {
    // Increased timeout for global propagation
    const timeoutMs = Number(process.env.CLOUDFLARED_STARTUP_TIMEOUT_MS) || 90_000;
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;

      if (connectionEstablished) {
        logger.info({ pr: prNumber, subdomain, elapsed: Date.now() - startTime }, '⏰ Timeout reached but connection established');
        resolve(`https://${subdomain}`);
      } else {
        logger.error({ pr: prNumber, timeoutMs, subdomain }, '❌ Tunnel startup timeout');
        try { 
          child.kill('SIGKILL'); 
        } catch (killError) {
          logger.warn({ err: killError, pr: prNumber }, '⚠️ Failed to kill timed out cloudflared process');
        }
        if (prNumber) {
          prSubdomains.delete(prNumber);
        }
        reject(new Error(`Tunnel startup timeout after ${timeoutMs}ms for ${subdomain}`));
      }
    }, timeoutMs);

    const handleOutput = (data: Buffer, stream: 'stdout' | 'stderr') => {
      const lines = data.toString().split('\n').filter(line => line.trim());

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        logger.debug({ pr: prNumber, stream, line: trimmed, subdomain }, `cloudflared ${stream}`);

        // Enhanced connection detection
        if (trimmed.includes('Connection') && (trimmed.includes('registered') || trimmed.includes('established'))) {
          connectionEstablished = true;
          logger.info({ pr: prNumber, subdomain, elapsed: Date.now() - startTime }, '🔗 Cloudflared connection registered');
        }

        if (trimmed.includes('serving tunnel') ||
            trimmed.includes('tunnel connected') ||
            (trimmed.includes('tunnel') && trimmed.includes('started'))) {
          connectionEstablished = true;
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(`https://${subdomain}`);
          }
        }

        // Enhanced error detection
        if (/error.*tunnel|failed.*establish|panic|fatal|unable to connect/i.test(trimmed) && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          try { 
            child.kill('SIGKILL'); 
          } catch (killError) {
            logger.warn({ err: killError, pr: prNumber }, '⚠️ Failed to kill cloudflared process on error');
          }
          if (prNumber) prSubdomains.delete(prNumber);
          reject(new Error(`Cloudflared error: ${trimmed}`));
        }

        // DNS propagation warnings
        if (/NXDOMAIN|Name or service not known/i.test(trimmed)) {
          logger.warn({ pr: prNumber, subdomain }, '🌐 DNS propagation delay detected - this is normal for new subdomains');
        }
      }
    };

    child.stdout?.on('data', (data) => handleOutput(data, 'stdout'));
    child.stderr?.on('data', (data) => handleOutput(data, 'stderr'));

    child.on('exit', (code, signal) => {
      const elapsed = Date.now() - startTime;
      logger.info({ pr: prNumber, code, signal, subdomain, elapsed }, 'Cloudflared process exited');

      if (prNumber) {
        const tunnelProcess = cloudflaredProcesses.get(prNumber);
        if (tunnelProcess?.process === child) {
          cloudflaredProcesses.delete(prNumber);
          prSubdomains.delete(prNumber);
        }
      }

      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Cloudflared exited unexpectedly (code=${code}, signal=${signal})`));
      }
    });

    child.on('error', (error) => {
      logger.error({ err: error, pr: prNumber, subdomain }, 'Cloudflared process error');
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        if (prNumber) prSubdomains.delete(prNumber);
        reject(error);
      }
    });
  });

  const publicUrl = await urlPromise;

  // Store enhanced process info
  if (prNumber) {
    cloudflaredProcesses.set(prNumber, {
      process: child,
      subdomain,
      publicUrl,
      startTime,
      lastHealthCheck: Date.now()
    });
  }

  const elapsed = Date.now() - startTime;
  logger.info({
    publicUrl,
    actualPort,
    containerPort,
    prNumber,
    subdomain,
    elapsed
  }, '✅ Enhanced cloudflared tunnel established');

  return {
    publicUrl,
    process: child,
    subdomain,
    actualPort,
    tunnelId: uuid
  };
}

/**
 * Enhanced verification with adaptive timeouts based on global conditions
 */
export async function verifyTunnelWithRetry(
  url: string,
  maxAttempts: number = 15, // Increased for global propagation
  baseDelayMs: number = 3000 // Longer base delay
): Promise<{ verified: boolean; attempts: number; lastError?: string; propagationTime?: number }> {
  const startTime = Date.now();
  logger.info({ url, maxAttempts, baseDelayMs }, '🔍 Starting adaptive tunnel verification');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // Longer timeout per request

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Envzilla-Tunnel-Verification/2.0',
          'Cache-Control': 'no-cache',
          'Accept': 'text/html,application/json,*/*'
        }
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const propagationTime = Date.now() - startTime;
        logger.info({
          url,
          attempt,
          status: response.status,
          propagationTime,
          propagationSeconds: Math.round(propagationTime / 1000)
        }, '✅ Tunnel verification successful');
        return { verified: true, attempts: attempt, propagationTime };
      }

      logger.warn({ url, attempt, status: response.status }, '⚠️ Tunnel responded but not OK');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Different handling for different error types
      if (errorMessage.includes('NXDOMAIN') || errorMessage.includes('Name or service not known')) {
        logger.info({ url, attempt, error: 'DNS_PROPAGATION' }, '🌐 DNS still propagating globally');
      } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
        logger.info({ url, attempt, error: 'CONNECTION_REFUSED' }, '🔄 Service not yet available');
      } else {
        logger.warn({ url, attempt, error: errorMessage }, '❌ Tunnel verification attempt failed');
      }

      if (attempt === maxAttempts) {
        const totalTime = Date.now() - startTime;
        return {
          verified: false,
          attempts: attempt,
          lastError: errorMessage,
          propagationTime: totalTime
        };
      }
    }

    // Adaptive backoff with jitter - longer delays for DNS propagation
    const baseDelay = baseDelayMs * Math.pow(1.3, attempt - 1);
    const maxDelay = 45000; // Max 45 seconds between attempts
    const delay = Math.min(baseDelay, maxDelay);
    const jitter = Math.random() * 2000; // Up to 2 seconds jitter

    logger.debug({
      attempt,
      delay: delay + jitter,
      nextAttemptIn: Math.round((delay + jitter) / 1000) + 's'
    }, '⏳ Waiting before next verification attempt');

    await new Promise(resolve => setTimeout(resolve, delay + jitter));
  }

  const totalTime = Date.now() - startTime;
  return { verified: false, attempts: maxAttempts, propagationTime: totalTime };
}

/**
 * Enhanced tunnel stop with async cleanup
 */
export async function stopTunnelForPR(prNumber: number): Promise<void> {
  const tunnelProcess = cloudflaredProcesses.get(prNumber);
  const subdomain = prSubdomains.get(prNumber);

  if (!tunnelProcess && !subdomain) {
    logger.debug({ pr: prNumber }, 'No tunnel found for PR, skipping cleanup');
    return;
  }

  logger.info({ pr: prNumber, subdomain }, '🛑 Stopping tunnel with enhanced cleanup');

  if (tunnelProcess) {
    try {
      // Graceful shutdown with timeout
      tunnelProcess.process.kill('SIGTERM');

      const gracefulTimeout = new Promise(resolve => setTimeout(resolve, 5000));
      const processExit = new Promise(resolve => {
        tunnelProcess.process.on('exit', resolve);
      });

      await Promise.race([gracefulTimeout, processExit]);

      // Force kill if still running
      if (!tunnelProcess.process.killed) {
        tunnelProcess.process.kill('SIGKILL');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      const runTime = Date.now() - tunnelProcess.startTime;
      logger.info({
        pr: prNumber,
        subdomain,
        runTimeSeconds: Math.round(runTime / 1000)
      }, '✅ Tunnel process stopped');

    } catch (error) {
      logger.warn({ err: error, pr: prNumber }, '⚠️ Error stopping tunnel process');
    }

    cloudflaredProcesses.delete(prNumber);
  }

  if (subdomain) {
    prSubdomains.delete(prNumber);
    portMappingCache.clear(); // Clear cache for this cleanup
    logger.info({ pr: prNumber, subdomain }, '🧹 Tunnel metadata cleaned up');
  }
}

/**
 * Get tunnel health status
 */
export function getTunnelStatus(prNumber: number): {
  exists: boolean;
  subdomain?: string;
  publicUrl?: string;
  uptime?: number;
  lastHealthCheck?: number;
} {
  const tunnelProcess = cloudflaredProcesses.get(prNumber);
  const subdomain = prSubdomains.get(prNumber);

  if (!tunnelProcess && !subdomain) {
    return { exists: false };
  }

  return {
    exists: true,
    subdomain,
    publicUrl: tunnelProcess?.publicUrl,
    uptime: tunnelProcess ? Date.now() - tunnelProcess.startTime : undefined,
    lastHealthCheck: tunnelProcess?.lastHealthCheck
  };
}

export function getSubdomainForPR(prNumber: number): string | undefined {
  return prSubdomains.get(prNumber);
}

export function getAllActiveTunnels(): Array<{
  prNumber: number;
  subdomain: string;
  publicUrl: string;
  uptime: number;
}> {
  return Array.from(cloudflaredProcesses.entries()).map(([prNumber, tunnelProcess]) => ({
    prNumber,
    subdomain: tunnelProcess.subdomain,
    publicUrl: tunnelProcess.publicUrl,
    uptime: Date.now() - tunnelProcess.startTime
  }));
}

// Legacy compatibility functions
export async function stopAllTunnels(): Promise<void> {
  logger.info({}, '🛑 Stopping all tunnels via enhanced cleanup');
  for (const prNumber of cloudflaredProcesses.keys()) {
    await stopTunnelForPR(prNumber);
  }
}


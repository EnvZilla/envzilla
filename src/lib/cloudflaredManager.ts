import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

export interface TunnelInfo {
  publicUrl: string;
  proto: string;
  port: number;
}

// Track cloudflared processes by PR number so we can stop them later
const cloudflaredProcesses = new Map<number, ChildProcess>();

function extractUrlFromChunk(chunk: string): string | null {
  const m = chunk.match(/https?:\/\/[^\s'"\)]+/i);
  return m ? m[0] : null;
}

/**
 * Returns true for URLs that are known non-tunnel Cloudflare links (for example
 * the website-terms redirect) which should be ignored while waiting for the
 * actual quick-tunnel public URL.
 */
function isIgnorableCloudflareUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    // Cloudflare may print the website-terms link to stderr as a generic banner.
    if ((host === 'www.cloudflare.com' || host === 'cloudflare.com') && path.includes('website-terms')) return true;

    // Many cloudflared informational links live under cloudflare.com. Accept
    // quick-tunnel subdomains from trycloudflare.com but ignore other
    // cloudflare.com hosts which are unlikely to be a real tunnel endpoint.
    if (host.endsWith('cloudflare.com') && !host.endsWith('trycloudflare.com')) return true;

    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Start a Cloudflare Tunnel using the `cloudflared` binary. Requires cloudflared installed.
 * Spawns `cloudflared tunnel --url http://localhost:<port>` and resolves with the public URL parsed from stdout.
 */
export async function startHttpTunnel(port: number, name?: string, region?: string, prNumber?: number): Promise<TunnelInfo> {
  logger.info({ port, name, region, prNumber }, '🔌 Starting cloudflared tunnel');

  const args = ['tunnel', '--url', `http://localhost:${port}`];

  // Allow overriding the protocol via environment for testing (quic or http2).
  // Default to http2 which avoids UDP buffer / QUIC issues on many hosts.
  const protocol = process.env.CLOUDFLARED_PROTOCOL || 'http2';
  args.push('--protocol', protocol);

  // If keys/cert.pem exists, pass it as --origincert to cloudflared to use a session cert
  try {
    const certPath = path.resolve(process.cwd(), 'keys', 'cert.pem');
    if (fs.existsSync(certPath)) {
      args.push('--origincert', certPath);
      logger.info({ pr: prNumber, certPath }, 'Using Cloudflare origincert for cloudflared');
    }
  } catch (e) {
    logger.warn({ err: e, pr: prNumber }, 'Failed to check for cloudflared origincert, continuing without it');
  }

  const childEnv = { ...process.env };

  const child = spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  if (prNumber) cloudflaredProcesses.set(prNumber, child);

  let resolved = false;

  const urlPromise = new Promise<string>((resolve, reject) => {
    // Give cloudflared a bit more time to establish and print the public URL
    const timeoutMs = Number(process.env.CLOUDFLARED_STARTUP_TIMEOUT_MS) || 30_000;
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch {}
      if (prNumber) cloudflaredProcesses.delete(prNumber);
      reject(new Error('Timed out waiting for cloudflared to print public URL'));
    }, timeoutMs);

    const handleChunk = (s: string, stream: 'stdout' | 'stderr') => {
      if (!s) return;
      const trimmed = s.trim();
      logger.info({ pr: prNumber, stream, chunk: trimmed, protocol }, `cloudflared ${stream}`);
      if (resolved) return;
      const url = extractUrlFromChunk(trimmed);
      if (url) {
        // Some cloudflared messages contain non-tunnel links (eg. website-terms).
        // Ignore those and keep waiting for the actual quick-tunnel URL.
        if (isIgnorableCloudflareUrl(url)) {
          logger.info({ pr: prNumber, url }, 'Ignoring non-tunnel cloudflared URL');
          return;
        }

        resolved = true;
        clearTimeout(timeout);
        resolve(url);
      }
    };

    child.stdout?.on('data', (b) => handleChunk(b.toString(), 'stdout'));
    child.stderr?.on('data', (b) => {
      const s = b.toString();
      // Try to extract a URL from stderr as well (cloudflared sometimes logs the
      // quick-tunnel URL to stderr).
      handleChunk(s, 'stderr');

      // Provide a clearer error message for the common QUIC/UDP buffer issue.
      if (/failed to sufficiently increase receive buffer size/i.test(s)) {
        // include a hint rather than immediately rejecting so caller can decide
        logger.warn({ pr: prNumber }, 'cloudflared reported UDP buffer size issue — consider increasing net.core.rmem_max / rmem_default on the host or switching to HTTP/2 protocol');
      }

      // Only treat true fatal errors as failures. Cloudflared prints many non-fatal
      // informational messages to stderr, so be conservative here.
      if (/exited unexpectedly|exit|panic|fatal|unable to|failed to initialize/i.test(s) && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        try { child.kill(); } catch {}
        if (prNumber) cloudflaredProcesses.delete(prNumber);
        // Add the original stderr output to the error for debugging.
        const hint = /receive buffer size/i.test(s) ? ' (UDP buffer issue detected; try --protocol http2 or increase host UDP buffer limits)' : '';
        reject(new Error(`cloudflared error: ${s.trim()}${hint}`));
      }
    });

    child.on('exit', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (prNumber) cloudflaredProcesses.delete(prNumber);
      reject(new Error(`cloudflared exited unexpectedly (code=${code} signal=${signal})`));
    });
  });

  const publicUrl = await urlPromise;
  logger.info({ publicUrl, port, prNumber }, '✅ cloudflared tunnel established');
  return { publicUrl, proto: publicUrl.startsWith('https') ? 'https' : 'http', port };
}

export async function stopTunnelForPR(prNumber: number): Promise<void> {
  const child = cloudflaredProcesses.get(prNumber);
  if (!child) return;
  try {
    child.kill();
    cloudflaredProcesses.delete(prNumber);
    logger.info({ pr: prNumber }, '🛑 cloudflared process killed for PR');
  } catch (err: any) {
    logger.warn({ err, pr: prNumber }, 'Failed to kill cloudflared process for PR');
  }
}

export async function stopAllTunnels(): Promise<void> {
  for (const [pr, child] of cloudflaredProcesses.entries()) {
    try { child.kill(); } catch {}
    cloudflaredProcesses.delete(pr);
  }
  logger.info({}, '🛑 All cloudflared processes killed');
}


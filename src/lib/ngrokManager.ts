import { spawn, ChildProcess } from 'child_process';
import http from 'http';
import logger from '../utils/logger.js';

export interface TunnelInfo {
  publicUrl: string;
  proto: string;
  port: number;
}

// Track ngrok CLI processes by PR number so we can stop them later
const ngrokProcesses = new Map<number, ChildProcess>();

/**
 * Poll the local ngrok API for tunnels and return the public URL for the given local port.
 */
function pollNgrokApiForPort(port: number, timeoutMs = 10_000): Promise<string> {
  const apiUrl = 'http://127.0.0.1:4040/api/tunnels';

  return new Promise((resolve, reject) => {
    const start = Date.now();

    const attempt = async () => {
      http.get(apiUrl, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString();
            const data = JSON.parse(body);
            if (Array.isArray(data.tunnels)) {
              for (const t of data.tunnels) {
                const addr = t.config?.addr || t.addr || '';
                // config.addr may be like "http://localhost:5111" or "localhost:5111"
                if (String(addr).includes(String(port)) && t.public_url) {
                  return resolve(t.public_url as string);
                }
              }
              // fallback: return first tunnel public_url if exists
              if (data.tunnels.length > 0 && data.tunnels[0].public_url) {
                return resolve(data.tunnels[0].public_url as string);
              }
            }
            if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for ngrok API'));
            setTimeout(attempt, 250);
          } catch (err) {
            if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for ngrok API'));
            setTimeout(attempt, 250);
          }
        });
      }).on('error', (err) => {
        if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for ngrok API'));
        setTimeout(attempt, 250);
      });
    };

    attempt();
  });
}

/**
 * Start the ngrok CLI (ngrok must be installed and available in PATH).
 * Spawns `ngrok http <port>` and polls the local API for the public URL.
 */
export async function startHttpTunnel(port: number, name?: string, region?: string, prNumber?: number): Promise<TunnelInfo> {
  logger.info({ port, name, region, prNumber }, '🔌 Starting ngrok tunnel (CLI)');

  const args = ['http', String(port)];
  // If an auth token is set, rely on user's ngrok config; otherwise CLI will run unauthenticated
  // Additional CLI flags can be appended if needed

  const child = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  if (prNumber) ngrokProcesses.set(prNumber, child);

  child.stdout?.on('data', (b) => {
    const s = b.toString();
    logger.info({ pr: prNumber, chunk: s.trim() }, 'ngrok stdout');
  });
  child.stderr?.on('data', (b) => {
    const s = b.toString();
    logger.warn({ pr: prNumber, chunk: s.trim() }, 'ngrok stderr');
  });

  try {
    const publicUrl = await pollNgrokApiForPort(port, 12_000);
    logger.info({ publicUrl, port, prNumber }, '✅ ngrok tunnel established (CLI)');
    return { publicUrl, proto: 'http', port };
  } catch (err: any) {
    logger.warn({ err, pr: prNumber }, 'Failed to get ngrok public URL from local API');
    // If we failed, ensure we don't leave the process running
    try {
      child.kill();
    } catch {}
    if (prNumber) ngrokProcesses.delete(prNumber);
    throw err;
  }
}

export async function stopTunnelForPR(prNumber: number): Promise<void> {
  const child = ngrokProcesses.get(prNumber);
  if (!child) return;
  try {
    child.kill();
    ngrokProcesses.delete(prNumber);
    logger.info({ pr: prNumber }, '🛑 ngrok CLI process killed for PR');
  } catch (err: any) {
    logger.warn({ err, pr: prNumber }, 'Failed to kill ngrok process for PR');
  }
}

export async function stopAllTunnels(): Promise<void> {
  for (const [pr, child] of ngrokProcesses.entries()) {
    try { child.kill(); } catch {}
    ngrokProcesses.delete(pr);
  }
  logger.info({}, '🛑 All ngrok CLI processes killed');
}


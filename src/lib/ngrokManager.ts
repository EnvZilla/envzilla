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
// When using a single agent, we track the long-lived agent process and per-PR tunnel names
let sharedAgent: ChildProcess | null = null;
let sharedAgentStarting: Promise<void> | null = null;
const prTunnelNames = new Map<number, string>();

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

  // Create a cleaned environment for the ngrok child process so we can "valet" it
  const childEnv = { ...process.env };
  // remove user's authtoken so ngrok runs without using that credential
  // (acts like a guest/valet)
  delete (childEnv as any).NGROK_AUTHTOKEN;

  // If we can, prefer creating tunnels on a single shared agent process to avoid ERR_NGROK_108
  try {
    await ensureSharedAgent(prNumber);
    const publicUrl = await createTunnelViaApi(port, name, prNumber);
    logger.info({ publicUrl, port, prNumber }, '✅ ngrok tunnel established (shared agent)');
    return { publicUrl, proto: 'http', port };
  } catch (err) {
    logger.warn({ err, pr: prNumber }, 'Failed to create tunnel via shared ngrok agent, falling back to per-process CLI');
    // fall through to previous per-process behavior below
  }

  // Capture any existing user token so we can fall back to an authenticated run
  const originalToken = (process.env as any).NGROK_AUTHTOKEN;

  // We'll allow replacing the child if we need to restart with auth
  let child: ChildProcess = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  if (prNumber) ngrokProcesses.set(prNumber, child);

  const attachStdHandlers = (c: ChildProcess) => {
    c.stdout?.on('data', (b) => {
      const s = b.toString();
      logger.info({ pr: prNumber, chunk: s.trim() }, 'ngrok stdout');
    });

    c.stderr?.on('data', (b) => {
      const s = b.toString();
      logger.warn({ pr: prNumber, chunk: s.trim() }, 'ngrok stderr');

      // If ngrok reports the auth-required error, try to restart with the user's token
      if (s.includes('ERR_NGROK_108')) {
        logger.warn({ pr: prNumber }, 'ngrok CLI reported ERR_NGROK_108 (auth required)');
        try { c.kill(); } catch {}
        if (prNumber) ngrokProcesses.delete(prNumber);

        if (originalToken) {
          logger.info({ pr: prNumber }, 'Retrying ngrok with NGROK_AUTHTOKEN from environment');
          // spawn a new process using the original environment (which includes the token)
          const authEnv = { ...process.env, NGROK_AUTHTOKEN: originalToken } as NodeJS.ProcessEnv;
          child = spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'], env: authEnv });
          if (prNumber) ngrokProcesses.set(prNumber, child);
          attachStdHandlers(child);
        } else {
          // No token to fall back to — surface an error to the caller by rejecting the auth race
          rejectAuth(new Error('ngrok CLI requires an auth token (ERR_NGROK_108)'));
        }
      }
    });
  };

  attachStdHandlers(child);

  // Promise that will be rejected if we cannot recover from auth error
  let rejectAuth: (err: any) => void = () => {};
  const authErrorPromise = new Promise<never>((_, rej) => { rejectAuth = rej; });

  try {
    // Race between obtaining the public URL and an immediate auth error from stderr
    const publicUrl = await Promise.race([pollNgrokApiForPort(port, 12_000), authErrorPromise]);
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
  // First, try to stop via shared agent API (if we created a named tunnel)
  try {
    await stopTunnelViaApi(prNumber);
    logger.info({ pr: prNumber }, '🛑 ngrok tunnel stopped via shared agent API');
  } catch (e) {
    // ignore and try killing per-process child
  }

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

/**
 * Ensure a single shared ngrok agent is running. If not, spawn one (using user's env so it's authenticated if available).
 */
async function ensureSharedAgent(prNumber?: number): Promise<void> {
  if (sharedAgent) return;
  if (sharedAgentStarting) return sharedAgentStarting;

  sharedAgentStarting = (async () => {
    logger.info({ pr: prNumber }, 'Starting shared ngrok agent');
    // Spawn ngrok agent with default env (so if NGROK_AUTHTOKEN exists it will be used)
    const child = spawn('ngrok', ['start', '--none'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    sharedAgent = child;

    child.stdout?.on('data', (b) => logger.info({ pr: prNumber, chunk: b.toString().trim() }, 'ngrok agent stdout'));
    child.stderr?.on('data', (b) => logger.warn({ pr: prNumber, chunk: b.toString().trim() }, 'ngrok agent stderr'));

    // Wait for local API to become available
    const start = Date.now();
    const apiUrl = 'http://127.0.0.1:4040/api/tunnels';
    while (Date.now() - start < 10_000) {
      try {
        await new Promise<void>((res, rej) => {
          http.get(apiUrl, (resStream) => { res(); }).on('error', (e) => rej(e));
        });
        return;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error('Timed out waiting for shared ngrok agent API');
  })();

  return sharedAgentStarting;
}

/**
 * Create a tunnel via ngrok local API and return public URL. Uses a named tunnel per PR when provided.
 */
async function createTunnelViaApi(port: number, name?: string, prNumber?: number, timeoutMs = 10_000): Promise<string> {
  const start = Date.now();
  const apiUrl = `http://127.0.0.1:4040/api/tunnels`;

  // Create a unique name per PR when possible
  const tunnelName = name || (prNumber ? `envzilla-pr-${prNumber}` : `envzilla-${Date.now()}`);
  if (prNumber) prTunnelNames.set(prNumber, tunnelName);

  // Try to create a tunnel by POSTing to the local API
  const payload = JSON.stringify({ name: tunnelName, addr: String(port) });

  const doPost = () => new Promise<void>((resolve, reject) => {
    const req = http.request(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          const data = JSON.parse(body);
          if (data.public_url) return resolve();
          return reject(new Error('ngrok API did not return public_url on create'));
        } catch (e) { return reject(e); }
      });
    });
    req.on('error', (e) => reject(e));
    req.write(payload);
    req.end();
  });

  // attempt create and then poll for the tunnel entry
  try {
    await doPost();
  } catch (e) {
    // ignore and poll; sometimes create may return 409 if already exists
  }

  // Poll for the tunnel to appear
  while (Date.now() - start < timeoutMs) {
    try {
      const publicUrl = await pollNgrokApiForPort(port, 1000);
      if (publicUrl) return publicUrl;
    } catch (e) {
      // continue polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for tunnel creation via ngrok API');
}

/**
 * Stop a tunnel created via the shared agent using the local API and PR mapping
 */
async function stopTunnelViaApi(prNumber: number): Promise<void> {
  const name = prTunnelNames.get(prNumber);
  if (!name) return;
  const apiUrl = `http://127.0.0.1:4040/api/tunnels/${encodeURIComponent(name)}`;
  return new Promise((resolve) => {
    const req = http.request(apiUrl, { method: 'DELETE' }, (res) => { res.on('data', () => {}); res.on('end', () => { prTunnelNames.delete(prNumber); resolve(); }); });
    req.on('error', () => resolve());
    req.end();
  });
}


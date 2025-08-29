import { spawn } from 'child_process';
import Docker from 'dockerode';
import logger from './utils/logger.js'; // adjust path if needed
import { 
    clonePRRepo, 
    buildContainerFromPath, 
    ensureDockerIsAvailable, 
    cleanupTempDir,
    BuildResult 
} from './lib/buildContainer.js';
import { startHttpTunnel, stopTunnelForPR } from './lib/cloudflaredManager.js';
import { tunnelHealthMonitor } from './lib/tunnelHealthMonitor.js';
import { postPRComment } from './lib/githubClient.js';
import { getInstallationAccessToken } from './lib/githubAuth.js';
import { 
    destroyContainer, 
    destroyByPRNumber,
    DestroyResult 
} from './lib/destroyContainer.js';

type RunResult = { code: number; stdout: string; stderr: string };

interface BuildForPRResult extends RunResult {
    buildResult?: BuildResult;
}

interface DestroyForPRResult extends RunResult {
    destroyResult?: DestroyResult;
}

function runLocalScript(args: string[], cwd = process.cwd(), timeoutMs = 10 * 60 * 1000): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('npx', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {
                // Ignore kill errors
            }
            reject(new Error(`Script ${args.join(' ')} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout?.on('data', (b) => { const s = b.toString(); stdout += s; logger.info({ script: args.join(' '), chunk: s.trim() }, 'script stdout'); });
        child.stderr?.on('data', (b) => { const s = b.toString(); stderr += s; logger.warn({ script: args.join(' '), chunk: s.trim() }, 'script stderr'); });

        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }); });
    });
}

// Windows needs pipe path; other OS use default socket/ENV
const dockerOptions = process.platform === 'win32' ? { socketPath: '//./pipe/docker_engine' } : undefined;
new Docker(dockerOptions);

/**
 * Build a container for a PR by cloning the repository and building a Docker image.
 * This integrates the git clone and docker build logic.
 */
export async function buildForPR(
    prNumber: number, 
    branch?: string,
    repoURL?: string,
    repoFullNameArg?: string,
    author?: string,
    installationId?: number | string
): Promise<BuildForPRResult> {
  const startedAt = Date.now();
  try {
    logger.info({ pr: prNumber, branch, repoURL }, '🏗️ buildForPR started');

    // Ensure repoURL present
    if (!repoURL) throw new Error('Missing repoURL for build');

    // Ensure Docker is available
    await ensureDockerIsAvailable();
    
    // If we have branch and repo URL, use the integrated approach
    if (branch && repoURL) {
        logger.info({ pr: prNumber }, '🔄 Using integrated git clone + docker build approach');
        
        // Step 1: Clone the PR repository
        const tempDir = await clonePRRepo(branch, repoURL);
        
        // Step 2: Build container from the cloned path
        const buildResult = await buildContainerFromPath(tempDir, prNumber);
        
        // Step 3: Clean up temporary directory
        await cleanupTempDir(tempDir);
        
        // Step 4: Wait for the service to be ready before starting the tunnel
        // This prevents the tunnel from being available before the service can handle requests
        // 🔧 FIX: Previously, cloudflared tunnel was started immediately after container creation,
        // but before the application inside was ready to serve requests. This caused a brief
        // period where the tunnel was live but returned errors. Now we:
        // 1. Wait for the service to be responsive on localhost
        // 2. Only then start the cloudflared tunnel
        // 3. Verify tunnel connectivity as a final check
        const serviceReadyConfig = {
            attempts: Number(process.env.SERVICE_READY_ATTEMPTS) || 15,
            delayMs: Number(process.env.SERVICE_READY_DELAY_MS) || 2000,
            timeoutMs: Number(process.env.SERVICE_READY_REQUEST_TIMEOUT_MS) || 5000
        };
        
        const localUrl = `http://localhost:${buildResult.hostPort}`;
        
        async function waitForServiceReady(url: string, attempts = serviceReadyConfig.attempts, delayMs = serviceReadyConfig.delayMs, timeoutMs = serviceReadyConfig.timeoutMs) {
            logger.info({ pr: prNumber, url, attempts }, '⏳ Waiting for service to be ready before starting tunnel...');
            
            for (let i = 0; i < attempts; i++) {
                try {
                    const controller = new AbortController();
                    const id = setTimeout(() => controller.abort(), timeoutMs);
                    const res = await fetch(url, { method: 'GET', signal: controller.signal });
                    clearTimeout(id);
                    if (res && (res.ok || res.status < 500)) { // Accept any non-server-error response
                        logger.info({ pr: prNumber, url, attempt: i + 1, status: res.status }, '✅ Service is ready, starting tunnel');
                        return;
                    }
                    logger.debug({ pr: prNumber, url, attempt: i + 1, status: res.status }, '⏳ Service not ready yet (server error), retrying...');
                } catch (error: unknown) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    logger.debug({ pr: prNumber, url, attempt: i + 1, error: errorMsg }, '⏳ Service not ready yet (connection failed), retrying...');
                }
                if (i < attempts - 1) { // Don't delay after the last attempt
                    await new Promise((r) => setTimeout(r, delayMs));
                }
            }
            throw new Error(`Service not ready after ${attempts} attempts: ${url}`);
        }
        
        // Wait for the service to be ready
        try {
            await waitForServiceReady(localUrl);
        } catch (e: unknown) {
            logger.warn({ pr: prNumber, localUrl, err: e instanceof Error ? e.message : String(e) }, 'Service readiness check failed — proceeding with tunnel creation anyway');
        }
        
        // Format output to match expected format
        // Start an external tunnel for the container port so it is reachable from GitHub
        let publicUrl = localUrl;
        try {
            const name = `envzilla-pr-${prNumber}`;
            const tunnel = await startHttpTunnel(buildResult.hostPort, name, undefined, prNumber);
            publicUrl = tunnel.publicUrl;

            // Smart tunnel verification with progressive backoff and DNS propagation awareness
            const urlConfig = {
                // Initial quick checks for immediate availability
                quickAttempts: Number(process.env.PREVIEW_URL_QUICK_ATTEMPTS) || 2,
                quickDelayMs: Number(process.env.PREVIEW_URL_QUICK_DELAY_MS) || 500,
                
                // Extended checks with exponential backoff for DNS propagation
                extendedAttempts: Number(process.env.PREVIEW_URL_EXTENDED_ATTEMPTS) || 6,
                baseDelayMs: Number(process.env.PREVIEW_URL_BASE_DELAY_MS) || 2000,
                maxDelayMs: Number(process.env.PREVIEW_URL_MAX_DELAY_MS) || 15000,
                
                requestTimeoutMs: Number(process.env.PREVIEW_URL_REQUEST_TIMEOUT_MS) || 8000
            };
            
            async function smartTunnelVerification(url: string): Promise<{ verified: boolean; lastError?: string }> {
                logger.info({ pr: prNumber, url }, '🔍 Starting smart tunnel verification...');
                
                // Phase 1: Quick checks for immediate availability
                logger.debug({ pr: prNumber, attempts: urlConfig.quickAttempts }, 'Phase 1: Quick availability checks');
                for (let i = 0; i < urlConfig.quickAttempts; i++) {
                    try {
                        const controller = new AbortController();
                        const id = setTimeout(() => controller.abort(), urlConfig.requestTimeoutMs);
                        const res = await fetch(url, { 
                            method: 'HEAD', // Use HEAD for faster checks
                            signal: controller.signal,
                            headers: { 'User-Agent': 'EnvZilla-TunnelVerifier/1.0' }
                        });
                        clearTimeout(id);
                        
                        if (res && res.ok) {
                            logger.info({ pr: prNumber, url, phase: 1, attempt: i + 1 }, '✅ Tunnel verified immediately');
                            return { verified: true };
                        }
                        
                        logger.debug({ pr: prNumber, status: res?.status, attempt: i + 1 }, 'Quick check failed, continuing...');
                    } catch (error: unknown) {
                        logger.debug({ pr: prNumber, attempt: i + 1, error: error instanceof Error ? error.message : String(error) }, 'Quick check error, continuing...');
                    }
                    
                    if (i < urlConfig.quickAttempts - 1) {
                        await new Promise(r => setTimeout(r, urlConfig.quickDelayMs));
                    }
                }
                
                // Phase 2: Extended checks with exponential backoff for DNS propagation
                logger.debug({ pr: prNumber, attempts: urlConfig.extendedAttempts }, 'Phase 2: Extended DNS propagation checks');
                let lastError = '';
                
                for (let i = 0; i < urlConfig.extendedAttempts; i++) {
                    const delay = Math.min(
                        urlConfig.baseDelayMs * Math.pow(1.5, i), // Exponential backoff
                        urlConfig.maxDelayMs
                    );
                    
                    logger.debug({ pr: prNumber, attempt: i + 1, delayMs: delay }, 'Extended verification attempt');
                    
                    try {
                        const controller = new AbortController();
                        const id = setTimeout(() => controller.abort(), urlConfig.requestTimeoutMs);
                        const res = await fetch(url, { 
                            method: 'GET',
                            signal: controller.signal,
                            headers: { 'User-Agent': 'EnvZilla-TunnelVerifier/1.0' }
                        });
                        clearTimeout(id);
                        
                        if (res && res.ok) {
                            logger.info({ pr: prNumber, url, phase: 2, attempt: i + 1, totalTime: `${(delay * i) / 1000}s` }, '✅ Tunnel verified after propagation');
                            return { verified: true };
                        }
                        
                        lastError = `HTTP ${res?.status || 'unknown'}`;
                        logger.debug({ pr: prNumber, status: res?.status, attempt: i + 1 }, 'Extended check failed, retrying with backoff...');
                        
                    } catch (error: unknown) {
                        lastError = error instanceof Error ? error.message : String(error);
                        logger.debug({ pr: prNumber, attempt: i + 1, error: lastError }, 'Extended check error, retrying with backoff...');
                    }
                    
                    if (i < urlConfig.extendedAttempts - 1) {
                        await new Promise(r => setTimeout(r, delay));
                    }
                }
                
                return { verified: false, lastError };
            }

            // Run smart verification but don't block deployment on failure
            const verificationResult = await smartTunnelVerification(publicUrl);
            
            if (verificationResult.verified) {
                logger.info({ pr: prNumber, publicUrl }, '✅ Tunnel verification completed successfully');
            } else {
                // Log warning but continue - tunnel might still work for users
                logger.warn({ 
                    pr: prNumber, 
                    publicUrl, 
                    lastError: verificationResult.lastError 
                }, '⚠️ Tunnel verification incomplete - tunnel may still be propagating globally');
            }

            // Start background health monitoring for the tunnel
            tunnelHealthMonitor.startMonitoring(publicUrl, prNumber);
            logger.info({ pr: prNumber, publicUrl }, '🔍 Background tunnel health monitoring started');

            // If we have repository info in env, post a comment to the PR with the link
            // Expect REPO_FULL_NAME like owner/repo
            // Prefer explicit repo full name passed from the webhook (owner/repo).
            // Fallback to environment or derive from clone URL for backward-compat.
            const deriveRepoFullName = (explicit?: string, url?: string) => {
                if (explicit) return explicit;
                if (process.env.REPO_FULL_NAME) return process.env.REPO_FULL_NAME;
                if (!url) return undefined;
                // Support git@github.com:owner/repo.git and https://github.com/owner/repo.git
                let s = url.trim();
                // git@github.com:owner/repo.git
                const m = s.match(/^git@[^:]+:(.+)$/);
                if (m && m[1]) s = m[1];
                else s = s.replace(/^https?:\/\/(?:www\.)?[^/]+\//, '');
                return s.replace(/\.git$/, '');
            };

            const repoFullName = deriveRepoFullName(repoFullNameArg, repoURL);
            // Use per-job ephemeral token if available (in CI/GitHub App flow this will be provided per job)
            // Prefer a true installation token when installationId is provided
            let ephemeralToken = process.env.EPHEMERAL_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
            if (!ephemeralToken && installationId) {
                try {
                    ephemeralToken = await getInstallationAccessToken(installationId);
                } catch (e: unknown) {
                    logger.warn({ pr: prNumber, installationId, err: e instanceof Error ? e.message : String(e) }, 'Failed to create installation access token');
                }
            }

            if (repoFullName && ephemeralToken) {
                // Create an intelligent comment with tunnel health awareness
                const safeUrl = (publicUrl || '').toString().trim();
                const header = author ? `@${author} 👋` : '👀 Envzilla is peeking at your preview environment 👀';
                
                // Check if tunnel was successfully verified
                const tunnelStatus = verificationResult.verified 
                    ? '✅ Tunnel verified and ready'
                    : '🔄 Tunnel created (may still be propagating globally)';
                
                const body = [
                    header,
                    '🔥 The Beast Lives! 🔥',
                    '',
                    `🌐 **Preview:** ${safeUrl}`,
                    `📦 **Container:** ${buildResult.containerId}`,
                    `🔌 **Port:** ${buildResult.hostPort}`,
                    `🛡️ **Status:** ${tunnelStatus}`,
                    '',
                    verificationResult.verified 
                        ? '🎉 Your preview environment is ready to test!'
                        : '⏳ If the link doesn\'t work immediately, wait 30-60 seconds for global DNS propagation.',
                    '',
                    '💥 PR opened → Env spawned. PR closed → Beast vanishes.',
                    '',
                    '<sub>🔍 Monitor tunnel health at `/admin/tunnels/health/' + prNumber + '`</sub>'
                ].join('\n');
                
                // Post comment with retry logic
                try { 
                    await postPRComment(ephemeralToken, repoFullName, prNumber, body); 
                    logger.info({ pr: prNumber, verified: verificationResult.verified }, '💬 Posted PR comment with tunnel status');
                } catch (err: unknown) { 
                    logger.warn({ err, pr: prNumber }, 'Failed to post PR comment'); 
                }
            } else {
                logger.info({ repoFullName }, 'No repo information or GITHUB_TOKEN; skipping PR comment');
            }
        } catch (err: unknown) {
            logger.warn({ err, pr: prNumber }, 'Failed to start ngrok tunnel; falling back to localhost');
        }

        const stdout = JSON.stringify({
            message: 'Container started',
            containerId: buildResult.containerId,
            hostPort: buildResult.hostPort,
            imageName: buildResult.imageName,
            previewUrl: publicUrl
        }, null, 2);
        
        logger.info({ 
            pr: prNumber, 
            containerId: buildResult.containerId.substring(0, 12),
            hostPort: buildResult.hostPort 
        }, '✅ Integrated build completed successfully');
        
        return {
            code: 0,
            stdout,
            stderr: '',
            buildResult
        };
        
    } else {
        // Fallback to legacy build script approach
        logger.info({ pr: prNumber }, '🔄 Using legacy build script approach');
        return runLocalScript(['tsx', 'build.ts']);
    }
  } catch (err: unknown) {
    logger.error({ pr: prNumber, error: err instanceof Error ? (err.stack || err.message) : String(err) }, '💥 buildForPR error');
    return {
      code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: Date.now()
    } as BuildForPRResult;
  }
}

/**
 * Destroy a container for a PR using the integrated destroy logic.
 */
export async function destroyForPR(containerId: string, prNumber?: number): Promise<DestroyForPRResult> {
    logger.info({ pr: prNumber, containerId }, 'worker: starting integrated destroy process');
    
    try {
        let destroyResult: DestroyResult;
        
        if (containerId && containerId !== 'undefined') {
            // Destroy specific container
            destroyResult = await destroyContainer(containerId, prNumber, {
                destroyImage: true,
                containerName: prNumber ? `preview-${prNumber}` : undefined
            });
        } else if (prNumber) {
            // Destroy by PR number if no specific container ID
            const results = await destroyByPRNumber(prNumber);
            destroyResult = results[0] || {
                success: false,
                containerId: '',
                containerDestroyed: false,
                imageDestroyed: false,
                errors: ['No containers found for PR']
            };
        } else {
            throw new Error('Either containerId or prNumber must be provided');
        }
        
        const stdout = JSON.stringify({
            message: destroyResult.success ? 'Container destroyed successfully' : 'Container destroy failed',
            containerId: destroyResult.containerId,
            containerDestroyed: destroyResult.containerDestroyed,
            imageDestroyed: destroyResult.imageDestroyed,
            errors: destroyResult.errors
        }, null, 2);
        
        if (destroyResult.success) {
            logger.info({ 
                pr: prNumber, 
                containerId: destroyResult.containerId ? destroyResult.containerId.substring(0, 12) : 'N/A',
                containerDestroyed: destroyResult.containerDestroyed,
                imageDestroyed: destroyResult.imageDestroyed
            }, '✅ Integrated destroy completed successfully');
            
            // Attempt to stop any cloudflared tunnel tied to this PR
            try { 
                if (prNumber) {
                    await stopTunnelForPR(prNumber);
                    // Stop health monitoring for this PR's tunnel
                    const healthStatus = tunnelHealthMonitor.getAllHealthStatus();
                    const prTunnels = healthStatus.filter(h => h.url.includes(`pr-${prNumber}`) || h.url.includes(`envzilla-pr-${prNumber}`));
                    prTunnels.forEach(tunnel => {
                        tunnelHealthMonitor.stopMonitoring(tunnel.url);
                        logger.info({ pr: prNumber, url: tunnel.url }, '🔍 Stopped tunnel health monitoring');
                    });
                }
            } catch (err: unknown) { 
                logger.warn({ err, pr: prNumber }, 'Failed to stop tunnel or health monitoring for PR'); 
            }
        }
        
        return {
            code: destroyResult.success ? 0 : 1,
            stdout,
            stderr: destroyResult.errors.join('\n'),
            destroyResult
        };
        
    } catch (error: unknown) {
        logger.error({ pr: prNumber, containerId, error: error instanceof Error ? error.message : String(error) }, '❌ Destroy process failed');
        
        // Fallback to legacy destroy script approach
        logger.info({ pr: prNumber, containerId }, '🔄 Falling back to legacy destroy script');
        return runLocalScript(['tsx', 'destroy.ts', containerId]);
    }
}

export default { buildForPR, destroyForPR };

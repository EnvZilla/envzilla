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
            try { child.kill('SIGKILL'); } catch {}
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
const docker = new Docker(dockerOptions);

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

    // Use naming convention to track containers
    const containerName = `preview-${prNumber}`;

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
        
        // Format output to match expected format
        // Start an external tunnel for the container port so it is reachable from GitHub
        let publicUrl = `http://localhost:${buildResult.hostPort}`;
        try {
            const name = `envzilla-pr-${prNumber}`;
            const tunnel = await startHttpTunnel(buildResult.hostPort, name, undefined, prNumber);
            publicUrl = tunnel.publicUrl;

            // Wait for the preview URL to become responsive before posting a PR comment.
            // This avoids writing a comment too early while the app or tunnel is still coming up.
            async function waitForUrl(url: string, attempts = 6, delayMs = 1000, timeoutMs = 3000) {
                for (let i = 0; i < attempts; i++) {
                    try {
                        const controller = new AbortController();
                        const id = setTimeout(() => controller.abort(), timeoutMs);
                        const res = await (globalThis as any).fetch(url, { method: 'GET', signal: controller.signal });
                        clearTimeout(id);
                        if (res && res.ok) return;
                    } catch (e) {
                        // ignore and retry
                    }
                    await new Promise((r) => setTimeout(r, delayMs));
                }
                throw new Error(`Timed out waiting for preview URL to respond: ${url}`);
            }

            try {
                await waitForUrl(publicUrl);
                logger.info({ pr: prNumber, publicUrl }, 'Preview URL is responsive');
            } catch (e: any) {
                logger.warn({ pr: prNumber, publicUrl, err: e?.message }, 'Preview URL did not become responsive in time — will still post comment but note it may be unavailable');
            }

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
                } catch (e: any) {
                    logger.warn({ pr: prNumber, installationId, err: e?.message }, 'Failed to create installation access token');
                }
            }

            if (repoFullName && ephemeralToken) {
                // Build a bilingual, light-hearted message and mention the PR author when available
                const safeUrl = (publicUrl || '').toString().trim();
                const header = author ? `@${author} 👋` : '👀 Envzilla is peeking at your preview environment — Envzilla ortamını dikizliyor 👀';
                const body = [
                    header,
                    '',
                    `Preview: ${safeUrl}`,
                    `Container: ${buildResult.containerId}`,
                    `Port: ${buildResult.hostPort}`
                ].join('\n');
                // best-effort post; do not fail the build if comment fails
                try { await postPRComment(ephemeralToken, repoFullName, prNumber, body); } catch (err: any) { logger.warn({ err, pr: prNumber }, 'Failed to post PR comment'); }
            } else {
                logger.info({ repoFullName }, 'No repo information or GITHUB_TOKEN; skipping PR comment');
            }
        } catch (err: any) {
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
  } catch (err: any) {
    logger.error({ pr: prNumber, error: err.stack || err.message }, '💥 buildForPR error');
    return {
      code: 1,
      stdout: '',
      stderr: err.message || String(err),
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
            // Attempt to stop any ngrok tunnel tied to this PR
            try { if (prNumber) await stopTunnelForPR(prNumber); } catch (err: any) { logger.warn({ err, pr: prNumber }, 'Failed to stop ngrok tunnel for PR'); }
        }
        
        return {
            code: destroyResult.success ? 0 : 1,
            stdout,
            stderr: destroyResult.errors.join('\n'),
            destroyResult
        };
        
    } catch (error: any) {
        logger.error({ pr: prNumber, containerId, error: error.message }, '❌ Destroy process failed');
        
        // Fallback to legacy destroy script approach
        logger.info({ pr: prNumber, containerId }, '🔄 Falling back to legacy destroy script');
        return runLocalScript(['tsx', 'destroy.ts', containerId]);
    }
}

export default { buildForPR, destroyForPR };

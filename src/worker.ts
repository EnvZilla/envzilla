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
import { startHttpTunnel, stopTunnel } from './lib/ngrokManager.js';
import { postPRComment } from './lib/githubClient.js';
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
    repoURL?: string
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
        // Start an ngrok tunnel for the container port so it is reachable externally
        let publicUrl = `http://localhost:${buildResult.hostPort}`;
        try {
            const name = `envzilla-pr-${prNumber}`;
            const tunnel = await startHttpTunnel(buildResult.hostPort, name);
            publicUrl = tunnel.publicUrl;

            // If we have repository info in env, post a comment to the PR with the link
            // Expect REPO_FULL_NAME like owner/repo
            const repoFullName = process.env.REPO_FULL_NAME || repoURL?.replace(/^https:\/\/(github\.com\/)?/, '').replace(/\.git$/, '');
            // Use per-job ephemeral token if available (in CI/GitHub App flow this will be provided per job)
            const ephemeralToken = process.env.EPHEMERAL_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
            if (repoFullName && ephemeralToken) {
                const body = `Preview environment available: ${publicUrl}\n\nContainer: ${buildResult.containerId}\nPort: ${buildResult.hostPort}`;
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

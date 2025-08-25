import { spawn } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger.js';

/**
 * Configuration for the Docker build and run process.
 */
const DOCKER_CONFIG = {
    // Port the container listens on (assumed from sample-app).
    containerPort: 3000,
    // Default timeout for operations.
    buildTimeoutMs: 10 * 60 * 1000, // 10 minutes
    runTimeoutMs: 60 * 1000, // 1 minute
    // Container health check timeout (configurable via env)
    healthCheckTimeoutMs: Number(process.env.CONTAINER_HEALTH_TIMEOUT_MS) || 30_000, // 30 seconds
};

/**
 * Configuration for preview URL health checks.
 */
const HEALTH_CHECK_CONFIG = {
    // URL response timeout (configurable via env)
    urlTimeoutMs: Number(process.env.PREVIEW_URL_TIMEOUT_MS) || 50_000, // 50 seconds total
    attempts: Number(process.env.PREVIEW_URL_ATTEMPTS) || 10,
    delayMs: Number(process.env.PREVIEW_URL_DELAY_MS) || 2000, // 2 seconds between attempts
    requestTimeoutMs: Number(process.env.PREVIEW_URL_REQUEST_TIMEOUT_MS) || 5000, // 5 seconds per request
};

/**
 * Configuration for the port searching logic.
 */
const PORT_CONFIG = {
    min: 5001,
    max: 5999,
    attempts: 200,
    concurrency: 50,
    perCheckTimeoutMs: 250,
};

export interface BuildResult {
    containerId: string;
    hostPort: number;
    imageName: string;
}

/**
 * Run a command using spawn and collect stdout/stderr.
 */
function runCommand(cmd: string, args: string[], opts?: { 
    timeoutMs?: number; 
    stream?: boolean; 
    cwd?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000;
    const stream = Boolean(opts?.stream);
    const cwd = opts?.cwd || process.cwd();

    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { 
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd
        });

        let stdout = '';
        let stderr = '';
        let finished = false;

        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                child.kill('SIGKILL');
                reject(new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`));
            }
        }, timeoutMs);

        child.stdout?.on('data', (b) => {
            const s = b.toString();
            stdout += s;
            if (stream) process.stdout.write(s);
        });

        child.stderr?.on('data', (b) => {
            const s = b.toString();
            stderr += s;
            if (stream) process.stderr.write(s);
        });

        child.on('error', (err) => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                reject(new Error(`${err.message}${stderr ? '\n' + stderr.trim().slice(0, 1024) : ''}`));
            }
        });

        child.on('close', (code) => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                resolve({ stdout, stderr, exitCode: code ?? 0 });
            }
        });
    });
}

/**
 * Clone a GitHub repository to a temporary directory
 */
export async function clonePRRepo(branch: string, repoURL: string, targetDir?: string): Promise<string> {
    const cloneDir = targetDir || path.join(process.cwd(), 'temp', `pr-${Date.now()}`);
    
    logger.info({ branch, repoURL, cloneDir }, '📥 Cloning repository...');

    // Ensure the parent directory exists
    await fs.promises.mkdir(path.dirname(cloneDir), { recursive: true });

    try {
        // Clone the specific branch
        const { exitCode, stderr } = await runCommand('git', [
            'clone',
            '--depth', '1',
            '--branch', branch,
            repoURL,
            cloneDir
        ], { timeoutMs: 5 * 60 * 1000 }); // 5 minute timeout for clone

        if (exitCode !== 0) {
            throw new Error(`Git clone failed: ${stderr}`);
        }

        logger.info({ cloneDir }, '✅ Repository cloned successfully');
        return cloneDir;
    } catch (error) {
        // Clean up on failure
        try {
            await fs.promises.rm(cloneDir, { recursive: true, force: true });
        } catch (cleanupError) {
            logger.warn({ cloneDir, error: cleanupError }, 'Failed to cleanup clone directory');
        }
        throw error;
    }
}

/**
 * Build a Docker image from the cloned repository path
 */
export async function buildContainerFromPath(
    repoPath: string, 
    prNumber: number,
    dockerfilePath: string = 'Dockerfile'
): Promise<BuildResult> {
    logger.info({ repoPath, prNumber }, '🏗️ Building Docker image...');

    // Check if Dockerfile exists
    const fullDockerfilePath = path.join(repoPath, dockerfilePath);
    if (!fs.existsSync(fullDockerfilePath)) {
        throw new Error(`Dockerfile not found at: ${fullDockerfilePath}`);
    }

    // Generate unique image name
    const imageName = `preview-pr-${prNumber}:${Date.now()}`;

    try {
        // Build the Docker image
        const { exitCode, stderr } = await runCommand('docker', [
            'build',
            '-f', fullDockerfilePath,
            '-t', imageName,
            repoPath
        ], { 
            timeoutMs: DOCKER_CONFIG.buildTimeoutMs,
            stream: false // Set to true if you want to see build output
        });

        if (exitCode !== 0) {
            throw new Error(`Docker build failed: ${stderr}`);
        }

        logger.info({ imageName }, '✅ Docker image built successfully');

        // Find a free port
        const hostPort = await findFreePort();
        logger.info({ hostPort }, '🔍 Found free host port');

        // Start the container
        const containerId = await runContainer(imageName, hostPort, prNumber);
        
        logger.info({ 
            containerId: containerId.substring(0, 12), 
            hostPort, 
            imageName 
        }, '🚀 Container started successfully');

        return {
            containerId,
            hostPort,
            imageName
        };

    } catch (error) {
        // Clean up the image on failure
        try {
            await runCommand('docker', ['rmi', imageName], { timeoutMs: 30000 });
        } catch (cleanupError) {
            logger.warn({ imageName, error: cleanupError }, 'Failed to cleanup image');
        }
        throw error;
    }
}

/**
 * Wait for a container to become healthy or ready
 */
async function waitForContainerHealth(containerId: string, prNumber: number, maxWaitMs = DOCKER_CONFIG.healthCheckTimeoutMs): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 2000; // Check every 2 seconds
    
    logger.info({ containerId: containerId.substring(0, 12), prNumber }, '⏳ Waiting for container to become healthy...');
    
    while (Date.now() - startTime < maxWaitMs) {
        try {
            // Check container status
            const { stdout: statusOutput, exitCode: statusCode } = await runCommand('docker', [
                'inspect', containerId, '--format', '{{.State.Health.Status}}'
            ], { timeoutMs: 5000 });
            
            if (statusCode === 0) {
                const healthStatus = statusOutput.trim();
                logger.debug({ containerId: containerId.substring(0, 12), healthStatus, prNumber }, 'Container health status check');
                
                if (healthStatus === 'healthy') {
                    logger.info({ containerId: containerId.substring(0, 12), prNumber }, '✅ Container is healthy');
                    return true;
                } else if (healthStatus === 'unhealthy') {
                    logger.warn({ containerId: containerId.substring(0, 12), prNumber }, '❌ Container reported unhealthy status');
                    return false;
                }
                // If health status is "starting" or no healthcheck, continue waiting
            }
            
            // Fallback: check if container is running and port is responsive
            const { stdout: runningOutput, exitCode: runningCode } = await runCommand('docker', [
                'inspect', containerId, '--format', '{{.State.Running}}'
            ], { timeoutMs: 5000 });
            
            if (runningCode === 0 && runningOutput.trim() === 'true') {
                // Container is running, try to connect to the port
                try {
                    const { stdout: portOutput } = await runCommand('docker', [
                        'port', containerId, '3000'
                    ], { timeoutMs: 5000 });
                    
                    if (portOutput.trim()) {
                        logger.info({ containerId: containerId.substring(0, 12), prNumber }, '✅ Container is running and port is accessible');
                        return true;
                    }
                } catch {
                    // Port check failed, continue waiting
                }
            } else {
                logger.warn({ containerId: containerId.substring(0, 12), prNumber }, '❌ Container is not running');
                return false;
            }
            
        } catch (error) {
            logger.debug({ containerId: containerId.substring(0, 12), error: error instanceof Error ? error.message : String(error), prNumber }, 'Error checking container health');
        }
        
        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    logger.warn({ containerId: containerId.substring(0, 12), prNumber, maxWaitMs }, '⏰ Timeout waiting for container to become healthy');
    return false;
}

/**
 * Run a Docker container with the specified image and port mapping
 */
async function runContainer(imageName: string, hostPort: number, prNumber: number): Promise<string> {
    // Validate port
    if (!Number.isInteger(hostPort) || hostPort < PORT_CONFIG.min || hostPort > PORT_CONFIG.max) {
        throw new Error(`Invalid hostPort: ${hostPort}`);
    }

    const containerName = `preview-${prNumber}`;
    const mapping = `${hostPort}:${DOCKER_CONFIG.containerPort}`;

    logger.info({ imageName, hostPort, containerName }, '🏃 Starting container...');

    const { stdout, exitCode, stderr } = await runCommand('docker', [
        'run',
        '-d',
        '--name', containerName,
        '-p', mapping,
        imageName
    ], { timeoutMs: DOCKER_CONFIG.runTimeoutMs });

    if (exitCode !== 0) {
        throw new Error(`Docker run failed: ${stderr}`);
    }

    const containerId = stdout.trim().split('\n')[0] || '';
    if (!containerId) {
        throw new Error('Failed to parse container ID from docker run output');
    }

    // Wait for container to become healthy
    const isHealthy = await waitForContainerHealth(containerId, prNumber);
    if (!isHealthy) {
        logger.warn({ containerId: containerId.substring(0, 12), prNumber }, '⚠️ Container started but health check failed - proceeding anyway');
    }

    return containerId;
}

/**
 * Find a free port by sampling random ports and checking availability.
 */
async function findFreePort(): Promise<number> {
    const tried = new Set<number>();
    const total = PORT_CONFIG.attempts;

    while (tried.size < total) {
        // Build a batch of ports to test concurrently
        const batch: number[] = [];
        while (batch.length < PORT_CONFIG.concurrency && tried.size < total) {
            const port = Math.floor(Math.random() * (PORT_CONFIG.max - PORT_CONFIG.min + 1)) + PORT_CONFIG.min;
            if (!tried.has(port)) {
                tried.add(port);
                batch.push(port);
            }
        }

        // Run checks concurrently and short-circuit on first free port
        const checks = batch.map(async (p) => ({ 
            p, 
            free: await isPortFreeWithTimeout(p, PORT_CONFIG.perCheckTimeoutMs) 
        }));
        
        const results = await Promise.all(checks);
        for (const r of results) {
            if (r.free) return r.p;
        }
    }

    throw new Error(`Could not find a free port in range ${PORT_CONFIG.min}-${PORT_CONFIG.max} after ${PORT_CONFIG.attempts} attempts`);
}

/**
 * Check if a port is free, with a timeout to avoid hanging
 */
function isPortFreeWithTimeout(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        let settled = false;

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                try { server.close(); } catch {
                    // Ignore close errors
                }
                resolve(false);
            }
        }, timeoutMs);

        server.once('error', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(false);
            }
        });

        server.once('listening', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                server.close(() => resolve(true));
            }
        });

        try {
            server.listen(port, '0.0.0.0');
        } catch {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(false);
            }
        }
    });
}

/**
 * Ensure Docker is available and responding
 */
export async function ensureDockerIsAvailable(): Promise<void> {
    try {
        const { exitCode } = await runCommand('docker', ['--version'], { timeoutMs: 5000 });
        if (exitCode !== 0) {
            throw new Error('docker --version returned non-zero exit code');
        }
    } catch {
        const errorMessage = `Docker CLI not found or not responding.
Please ensure Docker Desktop is running and that the 'docker' command is accessible in your shell's PATH.
For WSL2 users, make sure WSL integration is enabled in Docker Desktop settings.
See: https://docs.docker.com/desktop/wsl/`;
        throw new Error(errorMessage);
    }
}

/**
 * Cleanup temporary directory (used after container is built)
 */
export async function cleanupTempDir(dirPath: string): Promise<void> {
    try {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
        logger.info({ dirPath }, '🧹 Cleaned up temporary directory');
    } catch (error) {
        logger.warn({ dirPath, error }, 'Failed to cleanup temporary directory');
    }
}

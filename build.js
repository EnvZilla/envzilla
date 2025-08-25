// TypeScript script to build a Docker image, find a free host port,
// run the container, and print its ID and assigned port.
import { spawn } from 'child_process';
import * as net from 'net';
import logger from './src/utils/logger.js';
/**
 * Configuration for the Docker build and run process.
 * Centralizing these values makes them easier to modify.
 */
const DOCKER_CONFIG = {
    // Image tag to produce. Kept internal to avoid shell injection risks.
    imageTag: 'preview-image:latest',
    // Path to Dockerfile relative to repository root.
    dockerfilePath: 'sample-app/Dockerfile',
    // Build context directory.
    contextPath: 'sample-app',
    // Port the container listens on.
    containerPort: 3000,
};
/**
 * Configuration for the port searching logic.
 */
const PORT_CONFIG = {
    // Host port search range (inclusive).
    min: 5001,
    max: 5999,
    // Total random ports to try before giving up.
    attempts: 200,
    // How many port checks to run concurrently for better performance.
    concurrency: 50,
    // Milliseconds to wait for a port check to complete before assuming failure.
    // Reduced to speed up checks; ports that take longer are unlikely to be free.
    perCheckTimeoutMs: 250,
};
// --- Core Logic ---
/**
 * The main entry point for the script.
 * Orchestrates the steps: ensuring Docker is ready, building the image,
 * finding a port, and running the container.
 */
async function main() {
    try {
        // Quick sanity: ensure Docker is callable in this environment.
        await ensureDockerIsAvailable();
        // Build image (streamed, safe args).
        await buildImage();
        // Find a free host port in the configured range. Uses limited concurrency
        // so this completes quickly without overwhelming the system.
        const hostPort = await findFreePort();
        logger.info({ hostPort }, 'Found free host port');
        // Start container detached and print mapping information.
        const containerId = await runContainer(hostPort);
        logger.info({ containerId, hostPort, containerPort: DOCKER_CONFIG.containerPort }, 'Container started');
    }
    catch (error) {
        logger.error({ err: error }, 'Operation failed');
        process.exitCode = 1;
    }
}
// --- Docker Operations ---
/**
 * Builds the Docker image using the settings from DOCKER_CONFIG.
 */
/**
 * Run a command using spawn and stream stdout/stderr to this process.
 * Uses an argument array to avoid shell interpretation and injection.
 */
function runCommand(cmd, args, opts) {
    const timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000; // default 10 minutes
    const stream = Boolean(opts?.stream);
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
            if (stream)
                process.stdout.write(s);
        });
        child.stderr?.on('data', (b) => {
            const s = b.toString();
            stderr += s;
            if (stream)
                process.stderr.write(s);
        });
        child.on('error', (err) => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                const trimmed = stderr.trim().slice(0, 1024);
                reject(new Error(`${err.message}${trimmed ? '\n' + trimmed : ''}`));
            }
        });
        child.on('close', (code) => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                if (code !== 0) {
                    const trimmed = stderr.trim().slice(0, 2048);
                    reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}\n${trimmed}`));
                    return;
                }
                resolve({ stdout, stderr, exitCode: code ?? 0 });
            }
        });
    });
}
async function buildImage() {
    logger.info(`Building Docker image '${DOCKER_CONFIG.imageTag}'...`);
    // Use argument array to avoid shell interpolation and injection.
    const args = ['build', '-f', DOCKER_CONFIG.dockerfilePath, '-t', DOCKER_CONFIG.imageTag, DOCKER_CONFIG.contextPath];
    const { exitCode } = await runCommand('docker', args, { timeoutMs: 10 * 60 * 1000, stream: false }); // allow up to 10m for builds, do not stream by default
    if (exitCode !== 0) {
        throw new Error('docker build failed (non-zero exit code)');
    }
    logger.info('✅ Image built successfully.');
}
/**
 * Runs the Docker container in detached mode.
 * @param hostPort The host port to map to the container's exposed port.
 * @returns The ID of the started container.
 */
async function runContainer(hostPort) {
    logger.info('Starting container...');
    // Validate port is a number in the allowed range.
    if (!Number.isInteger(hostPort) || hostPort < PORT_CONFIG.min || hostPort > PORT_CONFIG.max) {
        throw new Error('Invalid hostPort provided to runContainer');
    }
    const mapping = `${hostPort}:${DOCKER_CONFIG.containerPort}`;
    const args = ['run', '-d', '-p', mapping, DOCKER_CONFIG.imageTag];
    const { stdout, exitCode } = await runCommand('docker', args, { timeoutMs: 60 * 1000, stream: false });
    if (exitCode !== 0) {
        throw new Error('docker run failed (non-zero exit code)');
    }
    const containerId = stdout.trim().split('\n')[0] || '';
    if (!containerId) {
        throw new Error('Failed to parse container ID from docker run output');
    }
    return containerId;
}
/**
 * Checks if the Docker CLI is available and executable.
 * Throws a detailed error if it is not.
 */
async function ensureDockerIsAvailable() {
    try {
        const { exitCode } = await runCommand('docker', ['--version'], { timeoutMs: 5000 });
        if (exitCode !== 0) {
            throw new Error('docker --version returned non-zero exit code');
        }
    }
    catch {
        const errorMessage = `Docker CLI not found or not responding.
Please ensure Docker Desktop is running and that the 'docker' command is accessible in your shell's PATH.
For WSL2 users, make sure WSL integration is enabled in Docker Desktop settings.
See: https://docs.docker.com/desktop/wsl/`;
        throw new Error(errorMessage);
    }
}
// --- Port Finding Utilities ---
/**
 * Attempts to find a free TCP port within a specified range.
 * It picks ports randomly to reduce the chance of collision with other processes
 * that might be searching sequentially.
 * @returns A promise that resolves with a free port number.
 */
/**
 * Find a free port by sampling random ports and checking availability.
 * Checks are performed in limited-concurrency batches for speed.
 */
async function findFreePort() {
    const tried = new Set();
    const total = PORT_CONFIG.attempts;
    while (tried.size < total) {
        // Build a batch of ports to test concurrently.
        const batch = [];
        while (batch.length < PORT_CONFIG.concurrency && tried.size < total) {
            const port = Math.floor(Math.random() * (PORT_CONFIG.max - PORT_CONFIG.min + 1)) + PORT_CONFIG.min;
            if (!tried.has(port)) {
                tried.add(port);
                batch.push(port);
            }
        }
        // Run checks concurrently and short-circuit on first free port.
        const checks = batch.map(async (p) => ({ p, free: await isPortFreeWithTimeout(p, PORT_CONFIG.perCheckTimeoutMs) }));
        const results = await Promise.all(checks);
        for (const r of results) {
            if (r.free)
                return r.p;
        }
    }
    throw new Error(`Could not find a free port in the range ${PORT_CONFIG.min}-${PORT_CONFIG.max} after ${PORT_CONFIG.attempts} attempts.`);
}
/**
 * Checks if a given port is available to listen on.
 * It works by briefly starting and then stopping a server on that port.
 * @param port The port number to check.
 * @returns A promise that resolves to `true` if the port is free, `false` otherwise.
 */
/**
 * Check if a port is free, with a small timeout to avoid hanging.
 */
function isPortFreeWithTimeout(port, timeoutMs) {
    return new Promise((resolve) => {
        const server = net.createServer();
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                try {
                    server.close();
                }
                catch {
                    // Ignore close errors
                }
                resolve(false);
            }
        }, timeoutMs);
        server.once('error', () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            // EADDRINUSE means port is in use; other errors treated as not free.
            resolve(false);
        });
        server.once('listening', () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            server.close(() => resolve(true));
        });
        try {
            server.listen(port, '0.0.0.0');
        }
        catch {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(false);
            }
        }
    });
}
// --- Script Execution ---
// This ensures `main()` is called only when the file is executed directly.
main();
//# sourceMappingURL=build.js.map
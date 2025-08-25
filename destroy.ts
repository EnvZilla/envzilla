import { spawn } from 'child_process';
import logger from './src/utils/logger.js';

/**
 * Simple helper to run a command and collect stdout/stderr without using a shell.
 */
function runCommand(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number }>{
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {
                // Ignore kill errors
            }
            reject(new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout?.on('data', (b) => { stdout += b.toString(); });
        child.stderr?.on('data', (b) => { stderr += b.toString(); });

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code: code ?? 0 });
        });
    });
}

async function main() {
    const id = process.argv[2];
    if (!id) {
        logger.error('Usage: npx ts-node destroy.ts <container_id>');
        process.exitCode = 2;
        return;
    }

    // Basic validation: container id should be a non-empty string without whitespace
    // Container id: accept full 64-char hex or short (>=3) alphanumeric (docker allows prefixes)
    const isValidId = typeof id === 'string' && /^[a-f0-9]{64}$/.test(id) || /^[A-Za-z0-9]{3,64}$/.test(id);
    if (!isValidId) {
        logger.error({ provided: id }, 'Invalid container id provided');
        process.exitCode = 2;
        return;
    }

    try {
        // Attempt graceful stop first
        const stop = await runCommand('docker', ['stop', id], 30_000);
        if (stop.code === 0) {
            logger.info({ container: id }, 'Stopped container');
        } else {
            // If stop failed, include a short sanitized stderr and attempt forced removal
            const short = (stop.stderr || '').trim().split('\n').slice(-5).join('\n').slice(0, 1000);
            logger.warn({ container: id, detail: short }, 'Failed to stop container');
        }

        // Now remove (force if needed)
        const rm = await runCommand('docker', ['rm', id], 15_000);
        if (rm.code === 0) {
            logger.info({ container: id }, 'Removed container');
            process.exitCode = 0;
            return;
        }

        // Try forced remove as a fallback
        const rmf = await runCommand('docker', ['rm', '-f', id], 15_000);
        if (rmf.code === 0) {
            logger.info({ container: id }, 'Removed container (forced)');
            process.exitCode = 0;
            return;
        }

    const shortErr = ((rm.stderr || '') + '\n' + (rmf.stderr || '')).trim().split('\n').slice(-8).join('\n').slice(0, 2000);
    logger.error({ container: id, detail: shortErr }, 'Failed to remove container');
        process.exitCode = 1;

    } catch (err: unknown) {
    logger.error({ container: id, err }, 'Error while attempting to destroy container');
        process.exitCode = 1;
    }
}

main();

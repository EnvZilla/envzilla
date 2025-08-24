import { spawn } from 'child_process';
import logger from './utils/logger.js';

type RunResult = { code: number; stdout: string; stderr: string };

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

/**
 * Trigger local build script for a PR. Returns the child result.
 */
export async function buildForPR(prNumber: number): Promise<RunResult> {
    logger.info({ pr: prNumber }, 'worker: starting build script for PR');
    return runLocalScript(['tsx', 'build.ts']);
}

/**
 * Trigger local destroy script for a container id.
 */
export async function destroyForPR(containerId: string, prNumber?: number): Promise<RunResult> {
    logger.info({ pr: prNumber, containerId }, 'worker: starting destroy script');
    return runLocalScript(['tsx', 'destroy.ts', containerId]);
}

export default { buildForPR, destroyForPR };

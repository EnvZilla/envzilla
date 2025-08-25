import { spawn } from 'child_process';
import logger from '../src/utils/logger.js';

/**
 * Simple helper to run a command and collect stdout/stderr without using a shell.
 */
function runCommand(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let finished = false;

        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                try { child.kill('SIGKILL'); } catch {
                    // Ignore kill errors
                }
                reject(new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`));
            }
        }, timeoutMs);

        child.stdout?.on('data', (b) => { stdout += b.toString(); });
        child.stderr?.on('data', (b) => { stderr += b.toString(); });

        child.on('error', (err) => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                reject(err);
            }
        });

        child.on('close', (code) => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                resolve({ stdout, stderr, code: code ?? 0 });
            }
        });
    });
}

export interface DestroyResult {
    success: boolean;
    containerId: string;
    containerDestroyed: boolean;
    imageDestroyed: boolean;
    errors: string[];
}

/**
 * Destroy a container and optionally its associated image
 */
export async function destroyContainer(
    containerId: string, 
    prNumber?: number,
    options: {
        destroyImage?: boolean;
        containerName?: string;
    } = {}
): Promise<DestroyResult> {
    const result: DestroyResult = {
        success: false,
        containerId,
        containerDestroyed: false,
        imageDestroyed: false,
        errors: []
    };

    // Basic validation: container id should be a non-empty string
    const isValidId = typeof containerId === 'string' && (
        /^[a-f0-9]{64}$/.test(containerId) || // Full 64-char hex
        /^[A-Za-z0-9]{3,64}$/.test(containerId) // Short alphanumeric (docker allows prefixes)
    );

    if (!isValidId) {
        const error = `Invalid container id provided: ${containerId}`;
        result.errors.push(error);
        logger.error({ containerId, prNumber }, error);
        return result;
    }

    logger.info({ containerId: containerId.substring(0, 12), prNumber }, '🛑 Starting container destroy process');

    try {
        // Step 1: Stop the container gracefully
        const stopResult = await runCommand('docker', ['stop', containerId], 30_000);
        if (stopResult.code === 0) {
            logger.info({ containerId: containerId.substring(0, 12) }, '✅ Container stopped successfully');
        } else {
            const error = `Failed to stop container: ${stopResult.stderr?.trim() || 'Unknown error'}`;
            result.errors.push(error);
            logger.warn({ containerId: containerId.substring(0, 12), error }, '⚠️ Container stop failed, will try forced removal');
        }

        // Step 2: Remove the container
        let removeResult = await runCommand('docker', ['rm', containerId], 15_000);
        if (removeResult.code === 0) {
            result.containerDestroyed = true;
            logger.info({ containerId: containerId.substring(0, 12) }, '✅ Container removed successfully');
        } else {
            // Try forced remove as fallback
            logger.info({ containerId: containerId.substring(0, 12) }, '🔄 Attempting forced container removal');
            const forceRemoveResult = await runCommand('docker', ['rm', '-f', containerId], 15_000);
            
            if (forceRemoveResult.code === 0) {
                result.containerDestroyed = true;
                logger.info({ containerId: containerId.substring(0, 12) }, '✅ Container removed (forced)');
            } else {
                const error = `Failed to remove container: ${removeResult.stderr?.trim()} | Forced: ${forceRemoveResult.stderr?.trim()}`;
                result.errors.push(error);
                logger.error({ containerId: containerId.substring(0, 12), error }, '❌ Container removal failed');
            }
        }

        // Step 3: Optionally destroy the associated image
        if (options.destroyImage && result.containerDestroyed) {
            await destroyAssociatedImages(containerId, prNumber, result);
        }

        // Step 4: Clean up by container name if provided
        if (options.containerName && result.containerDestroyed) {
            await cleanupByContainerName(options.containerName, result);
        }

        result.success = result.containerDestroyed;

    } catch (error: unknown) {
        const errorMsg = `Error during container destroy: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(errorMsg);
        logger.error({ containerId: containerId.substring(0, 12), prNumber, error }, errorMsg);
    }

    // Log final result
    if (result.success) {
        logger.info({ 
            containerId: containerId.substring(0, 12), 
            prNumber,
            containerDestroyed: result.containerDestroyed,
            imageDestroyed: result.imageDestroyed
        }, '✅ Container destroy completed successfully');
    } else {
        logger.error({ 
            containerId: containerId.substring(0, 12), 
            prNumber,
            errors: result.errors
        }, '❌ Container destroy failed');
    }

    return result;
}

/**
 * Destroy images associated with a PR
 */
async function destroyAssociatedImages(containerId: string, prNumber: number | undefined, result: DestroyResult): Promise<void> {
    try {
        // Get the image ID that was used by this container
        const inspectResult = await runCommand('docker', ['inspect', '--format={{.Image}}', containerId], 10_000);
        
        if (inspectResult.code === 0) {
            const imageId = inspectResult.stdout.trim();
            if (imageId) {
                const removeImageResult = await runCommand('docker', ['rmi', imageId], 30_000);
                if (removeImageResult.code === 0) {
                    result.imageDestroyed = true;
                    logger.info({ imageId: imageId.substring(0, 12), prNumber }, '✅ Associated image removed');
                } else {
                    const error = `Failed to remove image ${imageId}: ${removeImageResult.stderr?.trim()}`;
                    result.errors.push(error);
                    logger.warn({ imageId: imageId.substring(0, 12), error }, '⚠️ Image removal failed');
                }
            }
        }

        // Also try to remove PR-specific images by pattern
        if (prNumber) {
            const prImagePattern = `preview-pr-${prNumber}`;
            const listResult = await runCommand('docker', ['images', '--format={{.Repository}}:{{.Tag}}', '--filter=reference=' + prImagePattern + '*'], 10_000);
            
            if (listResult.code === 0 && listResult.stdout.trim()) {
                const images = listResult.stdout.trim().split('\n').filter(img => img.includes(prImagePattern));
                
                for (const image of images) {
                    const removeResult = await runCommand('docker', ['rmi', image], 30_000);
                    if (removeResult.code === 0) {
                        logger.info({ image, prNumber }, '✅ PR-specific image removed');
                    } else {
                        logger.warn({ image, error: removeResult.stderr?.trim() }, '⚠️ Failed to remove PR-specific image');
                    }
                }
            }
        }

    } catch (error: unknown) {
        const errorMsg = `Error destroying associated images: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(errorMsg);
        logger.warn({ containerId: containerId.substring(0, 12), error }, errorMsg);
    }
}

/**
 * Clean up containers by name pattern (in case container ID doesn't work)
 */
async function cleanupByContainerName(containerName: string, result: DestroyResult): Promise<void> {
    try {
        // Try to find and remove containers with the given name
        const psResult = await runCommand('docker', ['ps', '-a', '--filter=name=' + containerName, '--format={{.ID}}'], 10_000);
        
        if (psResult.code === 0 && psResult.stdout.trim()) {
            const containerIds = psResult.stdout.trim().split('\n');
            
            for (const id of containerIds) {
                if (id && id !== result.containerId) {
                    const removeResult = await runCommand('docker', ['rm', '-f', id], 15_000);
                    if (removeResult.code === 0) {
                        logger.info({ containerId: id.substring(0, 12), containerName }, '✅ Additional container removed by name');
                    }
                }
            }
        }
    } catch (error: unknown) {
        logger.warn({ containerName, error }, 'Failed to cleanup by container name');
    }
}

/**
 * Find and destroy containers by PR number
 */
export async function destroyByPRNumber(prNumber: number): Promise<DestroyResult[]> {
    const results: DestroyResult[] = [];
    
    try {
        logger.info({ prNumber }, '🔍 Finding containers for PR...');
        
        // Find containers with the naming pattern preview-{prNumber}
        const containerName = `preview-${prNumber}`;
        const psResult = await runCommand('docker', ['ps', '-a', '--filter=name=' + containerName, '--format={{.ID}}'], 10_000);
        
        if (psResult.code === 0 && psResult.stdout.trim()) {
            const containerIds = psResult.stdout.trim().split('\n').filter(id => id);
            
            logger.info({ prNumber, containerCount: containerIds.length }, '📦 Found containers to destroy');
            
            for (const containerId of containerIds) {
                const result = await destroyContainer(containerId, prNumber, {
                    destroyImage: true,
                    containerName
                });
                results.push(result);
            }
        } else {
            logger.info({ prNumber }, '📭 No containers found for PR');
        }
        
    } catch (error: unknown) {
        logger.error({ prNumber, error }, '❌ Error finding containers by PR number');
        results.push({
            success: false,
            containerId: '',
            containerDestroyed: false,
            imageDestroyed: false,
            errors: [`Error finding containers: ${error instanceof Error ? error.message : String(error)}`]
        });
    }
    
    return results;
}

/**
 * List all preview containers
 */
export async function listPreviewContainers(): Promise<Array<{id: string, name: string, status: string, image: string}>> {
    try {
        const result = await runCommand('docker', [
            'ps', '-a', 
            '--filter=name=preview-',
            '--format={{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}'
        ], 10_000);
        
        if (result.code === 0 && result.stdout.trim()) {
            return result.stdout.trim().split('\n').map(line => {
                const [id, name, status, image] = line.split('\t');
                return { id, name, status, image };
            });
        }
        
        return [];
    } catch (error) {
        logger.error({ error }, 'Failed to list preview containers');
        return [];
    }
}

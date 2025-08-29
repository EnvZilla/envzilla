import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { buildForPR, destroyForPR } from '../worker.js';
import { DeploymentManager } from './deploymentManager.js';

// Redis connection configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD,
  db: Number(process.env.REDIS_DB) || 0,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
};

// Create Redis connection
export const redis = new Redis(redisConfig);

// Job types
export enum JobType {
  BUILD_CONTAINER = 'build-container',
  DESTROY_CONTAINER = 'destroy-container',
  CLEANUP_STALE = 'cleanup-stale'
}

// Job data interfaces
export interface BuildJobData {
  prNumber: number;
  branch?: string;
  repoURL?: string;
  repoFullName?: string;
  author?: string;
  installationId?: number | string;
  webhookPayload?: Record<string, unknown>;
}

export interface DestroyJobData {
  prNumber: number;
  containerId?: string;
  forceDestroy?: boolean;
}

export interface CleanupJobData {
  maxAgeMs: number;
}

export type JobData = BuildJobData | DestroyJobData | CleanupJobData;

// Create job queue
export const jobQueue = new Queue('envzilla-jobs', {
  connection: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 50, // Keep last 50 completed jobs
    removeOnFail: 100,    // Keep last 100 failed jobs
    attempts: 3,          // Retry failed jobs up to 3 times
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
});

// Job processing functions
const jobProcessors = {
  [JobType.BUILD_CONTAINER]: async (job: Job<BuildJobData>) => {
    const { prNumber, branch, repoURL, repoFullName, author, installationId } = job.data;
    
    logger.info({ 
      jobId: job.id, 
      pr: prNumber, 
      branch 
    }, '🏗️ Processing build container job');

    // Update deployment status to building
    await DeploymentManager.updateDeploymentStatus(prNumber, 'building');
    await job.updateProgress(10);

    try {
      const result = await buildForPR(prNumber, branch, repoURL, repoFullName, author, installationId);
      
      if (result.code !== 0) {
        // Update deployment status to failed
        await DeploymentManager.updateDeploymentStatus(prNumber, 'failed', {
          lastError: result.stderr
        });
        throw new Error(`Build failed: ${result.stderr}`);
      }

      // Parse build result to get container information
      let containerId: string | undefined;
      let hostPort: number | undefined;

      try {
        const buildOutput = JSON.parse(result.stdout);
        containerId = buildOutput.containerId;
        hostPort = buildOutput.hostPort;
      } catch {
        // Fallback to regex parsing for legacy output
        const stdout = result.stdout || '';
        const containerIdMatch = stdout.match(/Container started.*containerId:\s*"([a-f0-9]{12,64})"/i);
        const portMatch = stdout.match(/hostPort:\s*(\d+)/i);
        
        containerId = containerIdMatch ? containerIdMatch[1] : undefined;
        hostPort = portMatch ? Number(portMatch[1]) : undefined;
      }

      if (containerId && hostPort) {
        // Update deployment status to running with container info
        await DeploymentManager.updateDeploymentStatus(prNumber, 'running', {
          containerId,
          hostPort,
          buildCompletedAt: Date.now()
        });
      } else {
        await DeploymentManager.updateDeploymentStatus(prNumber, 'failed', {
          lastError: 'Failed to parse container information from build output'
        });
        throw new Error('Failed to parse container information from build output');
      }

      await job.updateProgress(100);
      
      logger.info({ 
        jobId: job.id, 
        pr: prNumber,
        containerId: containerId?.substring(0, 12),
        hostPort
      }, '✅ Build container job completed');

      return result;
    } catch (error: unknown) {
      await DeploymentManager.updateDeploymentStatus(prNumber, 'failed', {
        lastError: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  },

  [JobType.DESTROY_CONTAINER]: async (job: Job<DestroyJobData>) => {
    const { prNumber, containerId } = job.data;
    
    logger.info({ 
      jobId: job.id, 
      pr: prNumber, 
      containerId: containerId?.substring(0, 12) 
    }, '🗑️ Processing destroy container job');

    await job.updateProgress(10);

    try {
      const result = await destroyForPR(containerId || '', prNumber);
      
      if (result.code === 0) {
        // Successfully destroyed - remove from deployment tracking
        await DeploymentManager.deleteDeployment(prNumber!);
      } else {
        // Update deployment status even if destroy had warnings
        await DeploymentManager.updateDeploymentStatus(prNumber!, 'failed', {
          lastError: `Destroy completed with warnings: ${result.stderr}`
        });
        logger.warn({ 
          jobId: job.id, 
          pr: prNumber, 
          error: result.stderr 
        }, '⚠️ Destroy job completed with warnings');
      }

      await job.updateProgress(100);
      
      logger.info({ 
        jobId: job.id, 
        pr: prNumber 
      }, '✅ Destroy container job completed');

      return result;
    } catch (error: unknown) {
      await DeploymentManager.updateDeploymentStatus(prNumber!, 'failed', {
        lastError: `Destroy failed: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }
  },

  [JobType.CLEANUP_STALE]: async (job: Job<CleanupJobData>) => {
    const { maxAgeMs } = job.data;
    
    logger.info({ 
      jobId: job.id, 
      maxAgeMs 
    }, '🧹 Processing cleanup stale deployments job');

    // This will be implemented when we move deployment tracking to Redis
    // For now, return a placeholder result
    await job.updateProgress(100);
    
    logger.info({ 
      jobId: job.id 
    }, '✅ Cleanup stale deployments job completed');

    return { cleanedCount: 0 };
  },
};

// Create and start the worker
export let jobWorker: Worker | null = null;

export function startJobWorker() {
  if (jobWorker) {
    logger.warn('Job worker is already running');
    return jobWorker;
  }

  jobWorker = new Worker('envzilla-jobs', async (job: Job) => {
    const processor = jobProcessors[job.name as JobType];
    if (!processor) {
      throw new Error(`Unknown job type: ${job.name}`);
    }
    
    // Type assertion is safe here since we control the job creation
    return await processor(job as never);
  }, {
    connection: redisConfig,
    concurrency: Number(process.env.JOB_CONCURRENCY) || 3, // Process up to 3 jobs concurrently
  });

  // Event listeners for monitoring
  jobWorker.on('completed', (job) => {
    logger.info({ 
      jobId: job.id, 
      jobName: job.name,
      duration: Date.now() - job.processedOn! 
    }, '✅ Job completed successfully');
  });

  jobWorker.on('failed', (job, err) => {
    logger.error({ 
      jobId: job?.id, 
      jobName: job?.name,
      error: err.message,
      stack: err.stack,
      attempts: job?.attemptsMade 
    }, '❌ Job failed');
  });

  jobWorker.on('stalled', (jobId) => {
    logger.warn({ jobId }, '⚠️ Job stalled');
  });

  jobWorker.on('error', (err) => {
    logger.error({ error: err.message, stack: err.stack }, '💥 Worker error');
  });

  logger.info('🚀 Job worker started successfully');
  return jobWorker;
}

export function stopJobWorker() {
  if (jobWorker) {
    return jobWorker.close();
  }
}

// Job queue helper functions
export async function addBuildJob(data: BuildJobData, options?: Record<string, unknown>) {
  const job = await jobQueue.add(JobType.BUILD_CONTAINER, data, {
    priority: 1, // High priority for builds
    ...options,
  });
  
  logger.info({ 
    jobId: job.id, 
    pr: data.prNumber,
    branch: data.branch 
  }, '📋 Build job added to queue');
  
  return job;
}

export async function addDestroyJob(data: DestroyJobData, options?: Record<string, unknown>) {
  const job = await jobQueue.add(JobType.DESTROY_CONTAINER, data, {
    priority: 2, // Medium priority for destroys
    ...options,
  });
  
  logger.info({ 
    jobId: job.id, 
    pr: data.prNumber,
    containerId: data.containerId?.substring(0, 12) 
  }, '📋 Destroy job added to queue');
  
  return job;
}

export async function addCleanupJob(data: CleanupJobData, options?: Record<string, unknown>) {
  const job = await jobQueue.add(JobType.CLEANUP_STALE, data, {
    priority: 3, // Low priority for cleanup
    ...options,
  });
  
  logger.info({ 
    jobId: job.id,
    maxAgeMs: data.maxAgeMs 
  }, '📋 Cleanup job added to queue');
  
  return job;
}

// Queue monitoring functions
export async function getQueueStats() {
  const waiting = await jobQueue.getWaiting();
  const active = await jobQueue.getActive();
  const completed = await jobQueue.getCompleted();
  const failed = await jobQueue.getFailed();

  return {
    waiting: waiting.length,
    active: active.length,
    completed: completed.length,
    failed: failed.length,
  };
}

export async function getJobStatus(jobId: string) {
  const job = await jobQueue.getJob(jobId);
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    name: job.name,
    progress: job.progress,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    failedReason: job.failedReason,
    data: job.data,
  };
}

// Initialize Redis connection
redis.on('connect', () => {
  logger.info('📦 Connected to Redis');
});

redis.on('error', (err: Error) => {
  logger.error({ error: err.message }, '❌ Redis connection error');
});

export default {
  jobQueue,
  startJobWorker,
  stopJobWorker,
  addBuildJob,
  addDestroyJob,
  addCleanupJob,
  getQueueStats,
  getJobStatus,
  redis,
};

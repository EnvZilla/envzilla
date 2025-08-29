#!/usr/bin/env node

/**
 * Standalone worker process for processing jobs from the Redis queue
 * This can be run separately from the main server for horizontal scaling
 */

import dotenv from 'dotenv';
dotenv.config();

import logger from './utils/logger.js';
import { startJobWorker, stopJobWorker, redis } from './lib/jobQueue.js';
import { DeploymentManager } from './lib/deploymentManager.js';

let isShuttingDown = false;

async function startWorkerProcess() {
  try {
    logger.info('🚀 Starting EnvZilla job worker process...');

    // Check Redis connection
    await redis.ping();
    logger.info('📦 Redis connection verified');

    // Check deployment manager health
    const health = await DeploymentManager.healthCheck();
    if (health.status === 'unhealthy') {
      logger.error({ details: health.details }, '❌ Deployment manager health check failed');
      process.exit(1);
    }
    logger.info({ details: health.details }, '✅ Deployment manager health check passed');

    // Start the job worker
    const _worker = startJobWorker();
    
    logger.info({
      pid: process.pid,
      concurrency: process.env.JOB_CONCURRENCY || 3
    }, '🎯 EnvZilla job worker started successfully');

    // Log worker statistics periodically
    const statsInterval = setInterval(async () => {
      try {
        const { getQueueStats } = await import('./lib/jobQueue.js');
        const queueStats = await getQueueStats();
        const deploymentStats = await DeploymentManager.getDeploymentStats();
        
        logger.info({
          queue: queueStats,
          deployments: deploymentStats
        }, '📊 Worker statistics');
      } catch (error: unknown) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, '❌ Failed to get worker statistics');
      }
    }, 60000); // Every minute

    // Graceful shutdown handlers
    const shutdown = async (signal: string) => {
      if (isShuttingDown) {
        logger.warn('💥 Force shutdown - worker may not finish current jobs');
        process.exit(1);
      }

      isShuttingDown = true;
      logger.info({ signal }, '📴 Graceful shutdown initiated');

      try {
        // Stop statistics reporting
        clearInterval(statsInterval);

        // Stop accepting new jobs and wait for current jobs to finish
        logger.info('⏳ Waiting for current jobs to complete...');
        await stopJobWorker();
        
        // Close Redis connection
        logger.info('📦 Closing Redis connection...');
        await redis.quit();

        logger.info('✅ Graceful shutdown completed');
        process.exit(0);
      } catch (error: unknown) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, '❌ Error during shutdown');
        process.exit(1);
      }
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error({ 
        error: error.message, 
        stack: error.stack 
      }, '💥 Uncaught exception in worker process');
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error({ 
        reason: String(reason), 
        promise: String(promise) 
      }, '💥 Unhandled promise rejection in worker process');
      process.exit(1);
    });

  } catch (error: unknown) {
    logger.error({ 
      error: error instanceof Error ? error.message : String(error), 
      stack: error instanceof Error ? error.stack : undefined
    }, '💥 Failed to start worker process');
    process.exit(1);
  }
}

// Start the worker process
startWorkerProcess();

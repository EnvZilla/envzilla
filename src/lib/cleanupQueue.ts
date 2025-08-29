import logger from '../utils/logger.js';
import { stopTunnelForPR } from './cloudflaredManager.js';
import { destroyByPRNumber } from './destroyContainer.js';

interface CleanupTask {
  id: string;
  prNumber: number;
  type: 'tunnel' | 'container' | 'full';
  timestamp: number;
  retries: number;
  maxRetries: number;
}

class CleanupQueue {
  private queue: CleanupTask[] = [];
  private processing = false;
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 5000;
  private readonly processingIntervalMs = 2000;
  
  constructor() {
    // Start background processing
    setInterval(() => this.processQueue(), this.processingIntervalMs);
    
    // Graceful shutdown handlers
    process.on('SIGTERM', () => this.gracefulShutdown());
    process.on('SIGINT', () => this.gracefulShutdown());
  }
  
  /**
   * Add cleanup task to queue
   */
  addCleanupTask(prNumber: number, type: CleanupTask['type'] = 'full'): void {
    const id = `${type}-pr-${prNumber}-${Date.now()}`;
    const task: CleanupTask = {
      id,
      prNumber,
      type,
      timestamp: Date.now(),
      retries: 0,
      maxRetries: this.maxRetries
    };
    
    // Remove any existing tasks for this PR
    this.queue = this.queue.filter(t => t.prNumber !== prNumber);
    this.queue.push(task);
    
    logger.info({ id, prNumber, type, queueLength: this.queue.length }, '🗂️ Added cleanup task to queue');
  }
  
  /**
   * Process cleanup queue
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    const task = this.queue.shift();
    
    if (!task) {
      this.processing = false;
      return;
    }
    
    try {
      await this.executeCleanupTask(task);
      logger.info({ taskId: task.id, prNumber: task.prNumber }, '✅ Cleanup task completed');
    } catch (error) {
      await this.handleTaskFailure(task, error);
    } finally {
      this.processing = false;
    }
  }
  
  /**
   * Execute cleanup task based on type
   */
  private async executeCleanupTask(task: CleanupTask): Promise<void> {
    const { prNumber, type } = task;
    
    switch (type) {
      case 'tunnel':
        await stopTunnelForPR(prNumber);
        break;
        
      case 'container':
        await destroyByPRNumber(prNumber);
        break;
        
      case 'full':
        // Stop tunnel first, then container
        try {
          await stopTunnelForPR(prNumber);
        } catch (tunnelError) {
          logger.warn({ err: tunnelError, prNumber }, 'Tunnel cleanup failed, continuing with container cleanup');
        }
        
        await destroyByPRNumber(prNumber);
        break;
        
      default:
        throw new Error(`Unknown cleanup task type: ${type}`);
    }
  }
  
  /**
   * Handle task failure with retry logic
   */
  private async handleTaskFailure(task: CleanupTask, error: unknown): Promise<void> {
    task.retries++;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    logger.warn({ 
      taskId: task.id, 
      prNumber: task.prNumber, 
      retries: task.retries, 
      maxRetries: task.maxRetries,
      error: errorMessage 
    }, '⚠️ Cleanup task failed');
    
    if (task.retries < task.maxRetries) {
      // Add delay before retry
      setTimeout(() => {
        this.queue.unshift(task); // Put back at front of queue
        logger.info({ taskId: task.id, prNumber: task.prNumber, retries: task.retries }, '🔄 Retrying cleanup task');
      }, this.retryDelayMs * task.retries); // Exponential backoff
    } else {
      logger.error({ 
        taskId: task.id, 
        prNumber: task.prNumber, 
        finalError: errorMessage 
      }, '❌ Cleanup task failed permanently after max retries');
    }
  }
  
  /**
   * Get queue status
   */
  getQueueStatus(): { length: number; processing: boolean; tasks: Omit<CleanupTask, 'id'>[] } {
    return {
      length: this.queue.length,
      processing: this.processing,
      tasks: this.queue.map(({ ...task }) => task)
    };
  }
  
  /**
   * Force process all remaining tasks during shutdown
   */
  private async gracefulShutdown(): Promise<void> {
    logger.info({ queueLength: this.queue.length }, '🛑 Graceful shutdown: processing remaining cleanup tasks');
    
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        try {
          await this.executeCleanupTask(task);
          logger.info({ taskId: task.id, prNumber: task.prNumber }, '✅ Shutdown cleanup completed');
        } catch (error) {
          logger.error({ taskId: task.id, prNumber: task.prNumber, err: error }, '❌ Shutdown cleanup failed');
        }
      }
    }
    
    logger.info('🏁 Cleanup queue shutdown complete');
  }
}

export const cleanupQueue = new CleanupQueue();

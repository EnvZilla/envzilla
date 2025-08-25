import { redis } from './jobQueue.js';
import logger from '../utils/logger.js';
import { DeploymentInfo } from '../types/webhook.js';

/**
 * Redis-based deployment manager for tracking deployment state
 */
export class DeploymentManager {
  private static readonly PREFIX = 'envzilla:deployments:';
  private static readonly DEPLOYMENT_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

  /**
   * Create or update deployment information
   */
  static async setDeployment(prNumber: number, deployment: DeploymentInfo): Promise<void> {
    const key = this.getKey(prNumber);
    const data = JSON.stringify({
      ...deployment,
      updatedAt: Date.now(),
    });

    try {
      await redis.setex(key, this.DEPLOYMENT_TTL, data);
      logger.debug({ pr: prNumber, status: deployment.status }, '💾 Deployment saved to Redis');
    } catch (error: any) {
      logger.error({ 
        pr: prNumber, 
        error: error.message 
      }, '❌ Failed to save deployment to Redis');
      throw error;
    }
  }

  /**
   * Get deployment information for a specific PR
   */
  static async getDeployment(prNumber: number): Promise<DeploymentInfo | null> {
    const key = this.getKey(prNumber);
    
    try {
      const data = await redis.get(key);
      if (!data) {
        return null;
      }

      const deployment = JSON.parse(data) as DeploymentInfo;
      logger.debug({ pr: prNumber, status: deployment.status }, '📖 Deployment loaded from Redis');
      return deployment;
    } catch (error: any) {
      logger.error({ 
        pr: prNumber, 
        error: error.message 
      }, '❌ Failed to load deployment from Redis');
      return null;
    }
  }

  /**
   * Delete deployment information
   */
  static async deleteDeployment(prNumber: number): Promise<boolean> {
    const key = this.getKey(prNumber);
    
    try {
      const result = await redis.del(key);
      logger.debug({ pr: prNumber }, '🗑️ Deployment deleted from Redis');
      return result > 0;
    } catch (error: any) {
      logger.error({ 
        pr: prNumber, 
        error: error.message 
      }, '❌ Failed to delete deployment from Redis');
      return false;
    }
  }

  /**
   * Get all active deployments
   */
  static async getAllDeployments(): Promise<Map<number, DeploymentInfo>> {
    const deployments = new Map<number, DeploymentInfo>();
    
    try {
      const pattern = `${this.PREFIX}*`;
      const keys = await redis.keys(pattern);
      
      if (keys.length === 0) {
        return deployments;
      }

      const values = await redis.mget(...keys);
      
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const value = values[i];
        
        if (value) {
          try {
            const prNumber = this.extractPRNumber(key);
            const deployment = JSON.parse(value) as DeploymentInfo;
            deployments.set(prNumber, deployment);
          } catch (parseError: any) {
            logger.warn({ 
              key, 
              error: parseError.message 
            }, '⚠️ Failed to parse deployment data');
          }
        }
      }

      logger.debug({ count: deployments.size }, '📊 Loaded all deployments from Redis');
      return deployments;
    } catch (error: any) {
      logger.error({ 
        error: error.message 
      }, '❌ Failed to load all deployments from Redis');
      return deployments;
    }
  }

  /**
   * Update deployment status
   */
  static async updateDeploymentStatus(
    prNumber: number, 
    status: DeploymentInfo['status'], 
    additionalData?: Partial<DeploymentInfo>
  ): Promise<void> {
    const existingDeployment = await this.getDeployment(prNumber);
    
    if (!existingDeployment) {
      logger.warn({ pr: prNumber }, '⚠️ Cannot update status: deployment not found');
      return;
    }

    const updatedDeployment: DeploymentInfo = {
      ...existingDeployment,
      status,
      ...additionalData,
    };

    await this.setDeployment(prNumber, updatedDeployment);
    logger.info({ pr: prNumber, status }, '🔄 Deployment status updated');
  }

  /**
   * Find stale deployments
   */
  static async findStaleDeployments(maxAgeMs: number): Promise<number[]> {
    const deployments = await this.getAllDeployments();
    const now = Date.now();
    const stalePRs: number[] = [];

    for (const [prNumber, deployment] of deployments) {
      if ((now - deployment.createdAt) > maxAgeMs) {
        stalePRs.push(prNumber);
      }
    }

    logger.info({ 
      total: deployments.size, 
      stale: stalePRs.length,
      maxAgeMs 
    }, '🕵️ Found stale deployments');

    return stalePRs;
  }

  /**
   * Cleanup stale deployments
   */
  static async cleanupStaleDeployments(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const stalePRs = await this.findStaleDeployments(maxAgeMs);
    let cleanedCount = 0;

    for (const prNumber of stalePRs) {
      try {
        const deployment = await this.getDeployment(prNumber);
        if (deployment) {
          // Mark as destroying
          await this.updateDeploymentStatus(prNumber, 'destroying');
          
          // Add destroy job to queue
          const { addDestroyJob } = await import('./jobQueue.js');
          await addDestroyJob({
            prNumber,
            containerId: deployment.containerId,
          });

          cleanedCount++;
          logger.info({ pr: prNumber }, '🧹 Stale deployment marked for cleanup');
        }
      } catch (error: any) {
        logger.error({ 
          pr: prNumber, 
          error: error.message 
        }, '❌ Failed to cleanup stale deployment');
      }
    }

    logger.info({ cleanedCount }, '🧹 Stale deployment cleanup completed');
    return cleanedCount;
  }

  /**
   * Get deployment statistics
   */
  static async getDeploymentStats(): Promise<{
    total: number;
    byStatus: Record<string, number>;
  }> {
    const deployments = await this.getAllDeployments();
    const stats = {
      total: deployments.size,
      byStatus: {} as Record<string, number>,
    };

    for (const [, deployment] of deployments) {
      const status = deployment.status || 'unknown';
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    }

    return stats;
  }

  /**
   * Health check for deployment manager
   */
  static async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy'; details: any }> {
    try {
      // Test Redis connection
      await redis.ping();
      
      // Get basic stats
      const stats = await this.getDeploymentStats();
      
      return {
        status: 'healthy',
        details: {
          redis: 'connected',
          deployments: stats,
        },
      };
    } catch (error: any) {
      return {
        status: 'unhealthy',
        details: {
          redis: 'disconnected',
          error: error.message,
        },
      };
    }
  }

  private static getKey(prNumber: number): string {
    return `${this.PREFIX}${prNumber}`;
  }

  private static extractPRNumber(key: string): number {
    return Number(key.replace(this.PREFIX, ''));
  }
}

// Legacy compatibility functions for existing code
export async function getDeploymentInfo(prNumber: number): Promise<DeploymentInfo | undefined> {
  const deployment = await DeploymentManager.getDeployment(prNumber);
  return deployment || undefined;
}

export async function getAllDeployments(): Promise<Map<number, DeploymentInfo>> {
  return await DeploymentManager.getAllDeployments();
}

export async function cleanupStaleDeployments(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  return await DeploymentManager.cleanupStaleDeployments(maxAgeMs);
}

export default DeploymentManager;

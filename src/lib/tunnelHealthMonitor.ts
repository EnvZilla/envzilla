import logger from '../utils/logger.js';

export interface TunnelHealth {
  url: string;
  isHealthy: boolean;
  lastChecked: Date;
  consecutiveFailures: number;
  lastError?: string;
  responseTime?: number;
}

class TunnelHealthMonitor {
  private healthCache = new Map<string, TunnelHealth>();
  private monitoringIntervals = new Map<string, NodeJS.Timeout>();
  
  /**
   * Start monitoring a tunnel's health in the background
   */
  startMonitoring(url: string, prNumber?: number): void {
    // Stop existing monitoring for this URL
    this.stopMonitoring(url);
    
    // Initialize health status
    this.healthCache.set(url, {
      url,
      isHealthy: false,
      lastChecked: new Date(),
      consecutiveFailures: 0
    });
    
    // Start background health checks every 30 seconds
    const intervalId = setInterval(async () => {
      await this.checkHealth(url, prNumber);
    }, 30_000); // 30 seconds
    
    this.monitoringIntervals.set(url, intervalId);
    
    // Do an initial check after a short delay to allow tunnel propagation
    setTimeout(async () => {
      await this.checkHealth(url, prNumber);
    }, 5000); // 5 seconds initial delay
    
    logger.info({ pr: prNumber, url }, '🔍 Started background tunnel health monitoring');
  }
  
  /**
   * Stop monitoring a tunnel
   */
  stopMonitoring(url: string): void {
    const intervalId = this.monitoringIntervals.get(url);
    if (intervalId) {
      clearInterval(intervalId);
      this.monitoringIntervals.delete(url);
    }
    this.healthCache.delete(url);
  }
  
  /**
   * Get current health status of a tunnel
   */
  getHealth(url: string): TunnelHealth | null {
    return this.healthCache.get(url) || null;
  }
  
  /**
   * Check if a tunnel is healthy (has been verified recently)
   */
  isTunnelHealthy(url: string): boolean {
    const health = this.healthCache.get(url);
    if (!health) return false;
    
    // Consider healthy if last successful check was within 2 minutes
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    return health.isHealthy && health.lastChecked > twoMinutesAgo;
  }
  
  /**
   * Perform a health check on a tunnel
   */
  private async checkHealth(url: string, prNumber?: number): Promise<void> {
    const startTime = Date.now();
    const currentHealth = this.healthCache.get(url);
    
    if (!currentHealth) {
      logger.warn({ pr: prNumber, url }, 'Attempted to check health of unmonitored tunnel');
      return;
    }
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000); // 10 second timeout
      
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'EnvZilla-HealthMonitor/1.0' }
      });
      
      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;
      
      if (response.ok) {
        // Health check successful
        const wasUnhealthy = !currentHealth.isHealthy;
        
        this.healthCache.set(url, {
          ...currentHealth,
          isHealthy: true,
          lastChecked: new Date(),
          consecutiveFailures: 0,
          responseTime,
          lastError: undefined
        });
        
        if (wasUnhealthy) {
          logger.info({ pr: prNumber, url, responseTime }, '✅ Tunnel health restored');
        } else {
          logger.debug({ pr: prNumber, url, responseTime }, '✅ Tunnel health check passed');
        }
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
      
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const newFailureCount = currentHealth.consecutiveFailures + 1;
      
      this.healthCache.set(url, {
        ...currentHealth,
        isHealthy: false,
        lastChecked: new Date(),
        consecutiveFailures: newFailureCount,
        lastError: errorMessage,
        responseTime: undefined
      });
      
      // Log based on failure count to avoid spam
      if (newFailureCount === 1) {
        logger.warn({ pr: prNumber, url, error: errorMessage }, '⚠️ Tunnel health check failed');
      } else if (newFailureCount % 5 === 0) {
        logger.warn({ pr: prNumber, url, consecutiveFailures: newFailureCount, error: errorMessage }, '⚠️ Tunnel health check still failing');
      } else {
        logger.debug({ pr: prNumber, url, consecutiveFailures: newFailureCount, error: errorMessage }, '⚠️ Tunnel health check failed');
      }
    }
  }
  
  /**
   * Get health status for all monitored tunnels
   */
  getAllHealthStatus(): TunnelHealth[] {
    return Array.from(this.healthCache.values());
  }
  
  /**
   * Clean up all monitoring
   */
  cleanup(): void {
    this.monitoringIntervals.forEach(intervalId => clearInterval(intervalId));
    this.monitoringIntervals.clear();
    this.healthCache.clear();
  }
}

// Singleton instance
export const tunnelHealthMonitor = new TunnelHealthMonitor();

// Cleanup on process exit
process.on('exit', () => {
  tunnelHealthMonitor.cleanup();
});

process.on('SIGINT', () => {
  tunnelHealthMonitor.cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  tunnelHealthMonitor.cleanup();
  process.exit(0);
});

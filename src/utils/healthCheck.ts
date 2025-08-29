import { spawn } from 'child_process';
import logger from './logger.js';
import { getAllDeployments } from '../middlewares/dispatcherServer.js';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  checks: {
    docker: boolean;
    deployments: {
      total: number;
      running: number;
      failed: number;
      building: number;
      destroying: number;
      stopped: number;
      queued: number;
    };
    system: {
      uptime: number;
      memory: {
        used: number;
        total: number;
        percentage: number;
      };
    };
  };
  errors?: string[];
}

/**
 * Check if Docker is available and responsive
 */
async function checkDockerHealth(): Promise<boolean> {
  try {
    return new Promise((resolve) => {
      const child = spawn('docker', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { 
            child.kill(); 
          } catch {
            // Ignore kill errors if process is already dead
          }
          resolve(false);
        }
      }, 5000);

      child.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(code === 0);
        }
      });

      child.on('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(false);
        }
      });
    });
  } catch {
    return false;
  }
}

/**
 * Get system memory information
 */
function getMemoryInfo() {
  const used = process.memoryUsage();
  const total = used.heapTotal;
  const percentage = (used.heapUsed / total) * 100;

  return {
    used: Math.round(used.heapUsed / 1024 / 1024), // MB
    total: Math.round(total / 1024 / 1024), // MB
    percentage: Math.round(percentage * 100) / 100
  };
}

/**
 * Analyze deployment status
 */
async function analyzeDeployments() {
  const deployments = await getAllDeployments();
  const stats = {
    total: deployments.size,
    running: 0,
    failed: 0,
    building: 0,
    destroying: 0,
    stopped: 0,
    queued: 0
  };

  for (const [, deployment] of deployments) {
    const status = deployment.status;
    if (status in stats) {
      (stats as Record<string, number>)[status]++;
    }
  }

  return stats;
}

/**
 * Perform comprehensive health check
 */
export async function performHealthCheck(): Promise<HealthStatus> {
  const errors: string[] = [];
  const timestamp = Date.now();

  // Check Docker
  const dockerHealthy = await checkDockerHealth();
  if (!dockerHealthy) {
    errors.push('Docker is not available or not responding');
  }

  // Check deployments
  const deploymentStats = await analyzeDeployments();

  // Check system resources
  const memoryInfo = getMemoryInfo();
  if (memoryInfo.percentage > 90) {
    errors.push(`High memory usage: ${memoryInfo.percentage}%`);
  }

  // Determine overall health status
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  
  if (errors.length > 0) {
    status = deploymentStats.failed > deploymentStats.running ? 'unhealthy' : 'degraded';
  }

  return {
    status,
    timestamp,
    checks: {
      docker: dockerHealthy,
      deployments: deploymentStats,
      system: {
        uptime: process.uptime(),
        memory: memoryInfo
      }
    },
    ...(errors.length > 0 && { errors })
  };
}

/**
 * Log health status
 */
export function logHealthStatus(health: HealthStatus) {
  const logLevel = health.status === 'healthy' ? 'info' : 
                   health.status === 'degraded' ? 'warn' : 'error';
  
  logger[logLevel]({
    healthStatus: health.status,
    dockerHealthy: health.checks.docker,
    deployments: health.checks.deployments,
    memoryUsage: health.checks.system.memory.percentage,
    errors: health.errors
  }, `Health check: ${health.status}`);
}

export default {
  performHealthCheck,
  logHealthStatus
};

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import * as worker from '../worker.js';
import { 
  GitHubWebhookPayload, 
  DeploymentInfo, 
  EncryptedData, 
  WebhookProcessingResult,
  WebhookEventContext 
} from '../types/webhook.js';

// In-memory deployment tracking
// In production, this should be moved to a persistent store like Redis
const deployments = new Map<number, DeploymentInfo>();

/**
 * Encrypts sensitive data using AES-256-GCM
 */
function encryptData(data: string, key: string): EncryptedData {
  const algorithm = 'aes-256-gcm';
  const iv = crypto.randomBytes(16);
  
  // Create a 32-byte key from the provided key string
  const keyBuffer = crypto.scryptSync(key, 'salt', 32);
  const cipher = crypto.createCipheriv(algorithm, keyBuffer, iv);
  
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag();
  
  return {
    encrypted,
    iv: iv.toString('hex'),
    tag: tag.toString('hex')
  };
}

/**
 * Decrypts data using AES-256-GCM
 */
function decryptData(encryptedData: string, key: string, iv: string, tag: string): string {
  const algorithm = 'aes-256-gcm';
  
  // Create a 32-byte key from the provided key string (same method as encryption)
  const keyBuffer = crypto.scryptSync(key, 'salt', 32);
  const decipher = crypto.createDecipheriv(algorithm, keyBuffer, Buffer.from(iv, 'hex'));
  
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Processes webhook payload and extracts sensitive information
 */
function processWebhookPayload(payload: GitHubWebhookPayload): {
  processedData: any;
  sensitiveData: string[];
} {
  const sensitiveData: string[] = [];
  const processedData = { ...payload };

  // Extract potentially sensitive information
  if (payload.repository?.clone_url) {
    sensitiveData.push(payload.repository.clone_url);
  }

  if (payload.pull_request?.head?.sha) {
    sensitiveData.push(payload.pull_request.head.sha);
  }

  return { processedData, sensitiveData };
}

/**
 * Main webhook event dispatcher middleware
 */
export async function dispatchWebhookEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const event = req.headers['x-github-event'] as string | undefined;
    const payload = req.body as GitHubWebhookPayload;

    logger.info({ 
      topic: 'webhook-dispatcher', 
      event, 
      action: payload.action,
      pr: payload.pull_request?.number 
    }, '🚀 Processing webhook event');

    // Only handle pull_request events
    if (event !== 'pull_request' || !payload.pull_request) {
      logger.info({ event }, 'Ignoring non-pull-request event');
      return res.status(200).json({ status: 'ignored', reason: 'not-pull-request' });
    }

    const prNumber = payload.pull_request.number;
    const { action } = payload;

    // Process and encrypt sensitive data
    const { processedData, sensitiveData } = processWebhookPayload(payload);
    const encryptionKey = process.env.GITHUB_WEBHOOK_SECRET || 'fallback-key';
    
    // Encrypt sensitive data for secure processing
    const encryptedSensitiveData = sensitiveData.map(data => 
      encryptData(data, encryptionKey)
    );

    logger.info({ 
      pr: prNumber, 
      action, 
      branch: payload.pull_request.head.ref,
      encryptedDataCount: encryptedSensitiveData.length 
    }, '🔐 Processed and encrypted sensitive webhook data');

    // Handle different PR actions
    switch (action) {
      case 'opened':
      case 'reopened':
      case 'synchronize':
        await handleCreateOrUpdate(prNumber, payload, encryptedSensitiveData, encryptionKey);
        break;
      
      case 'closed':
      case 'merged':
        await handleDestroy(prNumber, payload);
        break;
      
      default:
        logger.info({ action, pr: prNumber }, 'Ignoring unsupported PR action');
        return res.status(200).json({ status: 'ignored', action });
    }

    res.status(202).json({ 
      status: 'accepted', 
      pr: prNumber, 
      action,
      message: 'Webhook event processed successfully' 
    });

  } catch (error: any) {
    logger.error({
      error: error.message,
      stack: error.stack,
      payload: req.body,
      headers: req.headers
    }, '❌ Error in webhook dispatcher');
    res.status(500).json({ 
      error: 'Internal server error', 
      message: 'Failed to process webhook event',
      details: error.message,
      stack: error.stack
    });
  }
}

/**
 * Handles PR creation, reopening, or synchronization (new commits)
 */
async function handleCreateOrUpdate(
  prNumber: number, 
  payload: GitHubWebhookPayload, 
  encryptedSensitiveData: EncryptedData[],
  encryptionKey: string
) {
  try {
    // Update deployment status
    const existingDeployment = deployments.get(prNumber);
    deployments.set(prNumber, {
      ...existingDeployment,
      status: 'building',
      createdAt: Date.now(),
      buildStartedAt: Date.now(),
      branch: payload.pull_request?.head.ref,
      commitSha: payload.pull_request?.head.sha,
      title: payload.pull_request?.title,
      author: payload.pull_request?.user.login
    });

    logger.info({ pr: prNumber }, '🏗️ Starting build process for PR');

    // Decrypt sensitive data for processing
    const decryptedData = encryptedSensitiveData.map(data => 
      decryptData(data.encrypted, encryptionKey, data.iv, data.tag)
    );

    logger.info({ 
      pr: prNumber, 
      decryptedDataCount: decryptedData.length 
    }, '🔓 Decrypted sensitive data for build process');

    // Trigger build process asynchronously
    const branch = payload.pull_request?.head.ref;
    const repoURL = payload.pull_request?.head.repo.clone_url;

    // DEBUG: log before invoking worker
    logger.info({ pr: prNumber, branch, repoURL }, '▶️ Invoking worker.buildForPR');

  // Extract repository full name for accurate PR comments (owner/repo)
  const repoFullName = payload.pull_request?.head?.repo?.full_name || payload.repository?.full_name;
  const author = payload.pull_request?.user?.login;
  const installationId = payload.installation?.id || payload.sender?.id || undefined;

  worker.buildForPR(prNumber, branch, repoURL, repoFullName, author, installationId)
      .then(result => {
        logger.info({ pr: prNumber, result }, '🔔 buildForPR finished'); // <-- daha ayrıntılı log
        if (result.code === 0) {
          let containerId: string | undefined;
          let hostPort: number | undefined;

          // Try to parse JSON output from integrated approach
          try {
            const buildOutput = JSON.parse(result.stdout);
            containerId = buildOutput.containerId;
            hostPort = buildOutput.hostPort;
          } catch {
            // Fallback to legacy parsing for build.ts script output
            const stdout = result.stdout || '';
            const containerIdMatch = stdout.match(/Container started.*containerId:\s*"([a-f0-9]{12,64})"/i);
            const portMatch = stdout.match(/hostPort:\s*(\d+)/i);
            
            containerId = containerIdMatch ? containerIdMatch[1] : undefined;
            hostPort = portMatch ? Number(portMatch[1]) : undefined;
          }

          if (containerId && hostPort) {
            deployments.set(prNumber, {
              containerId,
              hostPort,
              status: 'running',
              createdAt: Date.now(),
              buildStartedAt: deployments.get(prNumber)?.buildStartedAt || Date.now(),
              buildCompletedAt: Date.now(),
              branch: payload.pull_request?.head.ref,
              commitSha: payload.pull_request?.head.sha,
              title: payload.pull_request?.title,
              author: payload.pull_request?.user.login
            });

            logger.info({ 
              pr: prNumber, 
              containerId, 
              hostPort 
            }, '✅ Build completed successfully - deployment is running');
          } else {
            throw new Error('Failed to parse container information from build output');
          }
        } else {
          throw new Error(`Build script failed with exit code ${result.code}`);
        }
      })
      .catch(error => {
        logger.error({ pr: prNumber, error: error.stack || error.message }, '❌ Build process failed');
      });

  } catch (error: any) {
    logger.error({ pr: prNumber, error: error.message }, '❌ Error in create/update handler');
    deployments.set(prNumber, {
      ...deployments.get(prNumber),
      status: 'failed',
      lastError: error.message
    } as DeploymentInfo);
  }
}

/**
 * Handles PR closure or merging
 */
async function handleDestroy(prNumber: number, payload: GitHubWebhookPayload) {
  try {
    const deployment = deployments.get(prNumber);
    
    if (!deployment || !deployment.containerId) {
      logger.warn({ pr: prNumber }, '⚠️ No deployment found to destroy');
      return;
    }

    // Update deployment status
    deployments.set(prNumber, {
      ...deployment,
      status: 'destroying'
    });

    logger.info({ 
      pr: prNumber, 
      containerId: deployment.containerId 
    }, '🗑️ Starting destroy process for PR');

    // Trigger destroy process asynchronously
    worker.destroyForPR(deployment.containerId, prNumber)
      .then(result => {
        if (result.code === 0) {
          deployments.delete(prNumber);
          logger.info({ 
            pr: prNumber, 
            containerId: deployment.containerId 
          }, '✅ Deployment destroyed successfully');
        } else {
          throw new Error(`Destroy script failed with exit code ${result.code}`);
        }
      })
      .catch(error => {
        logger.error({ 
          pr: prNumber, 
          containerId: deployment.containerId, 
          error: error.message 
        }, '❌ Destroy process failed');
      });

  } catch (error: any) {
    logger.error({ pr: prNumber, error: error.message }, '❌ Error in destroy handler');
  }
}

/**
 * Get deployment information for a specific PR
 */
export function getDeploymentInfo(prNumber: number): DeploymentInfo | undefined {
  return deployments.get(prNumber);
}

/**
 * Get all active deployments
 */
export function getAllDeployments(): Map<number, DeploymentInfo> {
  return new Map(deployments);
}

/**
 * Clean up failed or stale deployments
 */
export function cleanupStaleDeployments(maxAgeMs: number = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  const stalePRs: number[] = [];

  for (const [prNumber, deployment] of deployments) {
    if ((now - deployment.createdAt) > maxAgeMs) {
      stalePRs.push(prNumber);
    }
  }

  stalePRs.forEach(prNumber => {
    const deployment = deployments.get(prNumber);
    if (deployment?.containerId) {
      logger.info({ pr: prNumber }, '🧹 Cleaning up stale deployment');
      worker.destroyForPR(deployment.containerId, prNumber)
        .then(() => deployments.delete(prNumber))
        .catch(error => logger.error({ pr: prNumber, error }, 'Failed to cleanup stale deployment'));
    } else {
      deployments.delete(prNumber);
    }
  });

  return stalePRs.length;
}

export default {
  dispatchWebhookEvent,
  getDeploymentInfo,
  getAllDeployments,
  cleanupStaleDeployments
};

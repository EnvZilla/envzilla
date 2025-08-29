import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { addBuildJob, addDestroyJob } from '../lib/jobQueue.js';
import { DeploymentManager } from '../lib/deploymentManager.js';
import { 
  GitHubWebhookPayload, 
  DeploymentInfo, 
  EncryptedData
} from '../types/webhook.js';

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
  processedData: GitHubWebhookPayload;
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
export async function dispatchWebhookEvent(req: Request, res: Response, _next: NextFunction) {
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
    const { sensitiveData } = processWebhookPayload(payload);
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

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error({
      error: errorMessage,
      stack: errorStack,
      payload: req.body,
      headers: req.headers
    }, '❌ Error in webhook dispatcher');
    res.status(500).json({ 
      error: 'Internal server error', 
      message: 'Failed to process webhook event',
      details: errorMessage,
      stack: errorStack
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
    // Update deployment status in Redis
    const existingDeployment = await DeploymentManager.getDeployment(prNumber);
    const newDeployment: DeploymentInfo = {
      ...existingDeployment,
      status: 'queued',
      createdAt: existingDeployment?.createdAt || Date.now(),
      buildStartedAt: Date.now(),
      branch: payload.pull_request?.head.ref,
      commitSha: payload.pull_request?.head.sha,
      title: payload.pull_request?.title,
      author: payload.pull_request?.user.login
    };

    await DeploymentManager.setDeployment(prNumber, newDeployment);

    logger.info({ pr: prNumber }, '📋 Queuing build job for PR');

    // Decrypt sensitive data for processing
    const decryptedData = encryptedSensitiveData.map(data => 
      decryptData(data.encrypted, encryptionKey, data.iv, data.tag)
    );

    logger.info({ 
      pr: prNumber, 
      decryptedDataCount: decryptedData.length 
    }, '🔓 Decrypted sensitive data for build process');

    // Prepare job data
    const branch = payload.pull_request?.head.ref;
    const repoURL = payload.pull_request?.head.repo.clone_url;
    const repoFullName = payload.pull_request?.head?.repo?.full_name || payload.repository?.full_name;
    const author = payload.pull_request?.user?.login;
    const installationId = payload.installation?.id || payload.sender?.id || undefined;

    // Add build job to queue
    const job = await addBuildJob({
      prNumber,
      branch,
      repoURL,
      repoFullName,
      author,
      installationId,
      webhookPayload: payload
    });

    // Update deployment status to building
    await DeploymentManager.updateDeploymentStatus(prNumber, 'building');

    logger.info({ 
      pr: prNumber, 
      jobId: job.id,
      branch, 
      repoURL 
    }, '✅ Build job added to queue successfully');

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ pr: prNumber, error: errorMessage }, '❌ Error in create/update handler');
    
    // Update deployment status to failed
    try {
      await DeploymentManager.updateDeploymentStatus(prNumber, 'failed', {
        lastError: errorMessage
      });
    } catch (updateError: unknown) {
      logger.error({ pr: prNumber, error: updateError }, '❌ Failed to update deployment status');
    }
  }
}

/**
 * Handles PR closure or merging
 */
async function handleDestroy(prNumber: number, _payload: GitHubWebhookPayload) {
  try {
    const deployment = await DeploymentManager.getDeployment(prNumber);
    
    if (!deployment || !deployment.containerId) {
      logger.warn({ pr: prNumber }, '⚠️ No deployment found to destroy');
      return;
    }

    // Update deployment status to destroying
    await DeploymentManager.updateDeploymentStatus(prNumber, 'destroying');

    logger.info({ 
      pr: prNumber, 
      containerId: deployment.containerId 
    }, '� Queuing destroy job for PR');

    // Add destroy job to queue
    const job = await addDestroyJob({
      prNumber,
      containerId: deployment.containerId,
    });

    logger.info({ 
      pr: prNumber, 
      jobId: job.id,
      containerId: deployment.containerId?.substring(0, 12) 
    }, '✅ Destroy job added to queue successfully');

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ pr: prNumber, error: errorMessage }, '❌ Error in destroy handler');
  }
}

/**
 * Get deployment information for a specific PR
 * Legacy compatibility function - now uses Redis-based DeploymentManager
 */
export async function getDeploymentInfo(prNumber: number): Promise<DeploymentInfo | undefined> {
  return await DeploymentManager.getDeployment(prNumber) || undefined;
}

/**
 * Get all active deployments
 * Legacy compatibility function - now uses Redis-based DeploymentManager
 */
export async function getAllDeployments(): Promise<Map<number, DeploymentInfo>> {
  return await DeploymentManager.getAllDeployments();
}

/**
 * Clean up failed or stale deployments
 * Legacy compatibility function - now uses Redis-based DeploymentManager and job queue
 */
export async function cleanupStaleDeployments(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  return await DeploymentManager.cleanupStaleDeployments(maxAgeMs);
}

export default {
  dispatchWebhookEvent,
  getDeploymentInfo,
  getAllDeployments,
  cleanupStaleDeployments
};

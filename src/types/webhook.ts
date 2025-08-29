// filepath: c:\Users\asd\Documents\Github\envzilla\src\types/webhook.ts

export interface GitHubWebhookPayload {
  action: string;
  pull_request?: {
    number: number;
    head: {
      ref: string;
      sha: string;
      repo: {
        clone_url: string;
        full_name: string;
      };
    };
    base: {
      ref: string;
      repo: {
        clone_url: string;
        full_name: string;
      };
    };
    title: string;
    body?: string;
    html_url: string;
    state: 'open' | 'closed';
    merged: boolean;
    user: {
      login: string;
      avatar_url: string;
    };
  };
  repository?: {
    id: number;
    name: string;
    full_name: string;
    clone_url: string;
    ssh_url: string;
    owner: {
      login: string;
      type: string;
    };
  };
  sender?: {
    login: string;
    id: number;
    avatar_url: string;
    type: string;
  };
  installation?: {
    id: number;
  };
  [key: string]: unknown;
}

export interface DeploymentInfo {
  containerId?: string;
  hostPort?: number;
  createdAt: number;
  status: 'queued' | 'building' | 'running' | 'destroying' | 'failed' | 'stopped';
  branch?: string;
  commitSha?: string;
  title?: string;
  author?: string;
  lastError?: string;
  buildStartedAt?: number;
  buildCompletedAt?: number;
}

export interface EncryptedData {
  encrypted: string;
  iv: string;
  tag: string;
}

export interface WebhookProcessingResult {
  success: boolean;
  action: string;
  prNumber: number;
  message: string;
  data?: unknown;
  error?: string;
}

export interface BuildResult {
  code: number;
  stdout: string;
  stderr: string;
  containerId?: string;
  hostPort?: number;
  startedAt: number;
  completedAt: number;
}

export interface DestroyResult {
  code: number;
  stdout: string;
  stderr: string;
  destroyedAt: number;
}

export type WebhookEventType = 'pull_request' | 'push' | 'release' | 'deployment';
export type PullRequestAction = 
  | 'opened' 
  | 'closed' 
  | 'reopened' 
  | 'synchronize' 
  | 'edited' 
  | 'labeled' 
  | 'unlabeled' 
  | 'ready_for_review'
  | 'review_requested';

export interface WebhookEventContext {
  eventType: WebhookEventType;
  action: PullRequestAction;
  prNumber: number;
  branch: string;
  commitSha: string;
  repository: string;
  author: string;
  timestamp: number;
}

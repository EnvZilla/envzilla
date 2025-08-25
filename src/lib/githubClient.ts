import { Octokit } from '@octokit/rest';
import logger from '../utils/logger.js';

const token = process.env.GITHUB_TOKEN;
let octokit: Octokit | null = null;

if (token) {
  octokit = new Octokit({ auth: token });
} else {
  logger.warn({}, 'GITHUB_TOKEN not set; GitHub operations will be disabled');
}

export async function postPRComment(repoFullName: string, prNumber: number, body: string): Promise<void> {
  if (!octokit) throw new Error('Octokit not initialized; set GITHUB_TOKEN');

  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) throw new Error('Invalid repo full name, expected owner/repo');

  logger.info({ owner, repo, prNumber }, '💬 Posting comment to PR');

  await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });

  logger.info({ owner, repo, prNumber }, '✅ Posted PR comment');
}

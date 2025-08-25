import { Octokit } from '@octokit/rest';
import logger from '../utils/logger.js';

// Bu fonksiyon, worker'ın içinde, her iş için özel olarak üretilmiş token ile çağrılacak
export async function postPRComment(
  token: string, // HER SEFERİNDE YENİ, GEÇİCİ TOKEN BURAYA GELECEK
  repoFullName: string,
  prNumber: number,
  body: string
): Promise<void> {
  if (!token) throw new Error('Missing GitHub token');

  // Octokit, artık her seferinde o işe özel token ile oluşturuluyor
  const octokit = new Octokit({ auth: token });
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) throw new Error('Invalid repo full name, expected owner/repo');

  logger.info({ owner, repo, prNumber }, '💬 Posting comment to PR');
  // Use the modern REST namespace
  await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body }).catch((err) => {
    logger.warn({ owner, repo, prNumber, err }, 'octokit.rest.issues.createComment failed');
    throw err;
  });
  logger.info({ owner, repo, prNumber }, '✅ Posted PR comment');
}

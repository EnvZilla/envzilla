import fs from 'fs';
import crypto from 'crypto';

function base64Url(input: Buffer | string) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return b.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createJwt(appId: string, privateKeyPem: string) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  // GitHub requires exp no more than 10 minutes in the future
  const payload = { iat: now - 5, exp: now + 600, iss: Number(appId) };

  const encoded = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(encoded);
  signer.end();
  const signature = signer.sign(privateKeyPem);

  return `${encoded}.${base64Url(signature)}`;
}

export async function getInstallationAccessToken(installationId: number | string): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const pkPath = process.env.GITHUB_PRIVATE_KEY_PATH;
  const pkEnv = process.env.GITHUB_PRIVATE_KEY;

  if (!appId) throw new Error('Missing GITHUB_APP_ID in environment');

  let privateKeyPem: string | undefined = undefined;
  if (pkEnv) privateKeyPem = pkEnv;
  else if (pkPath && fs.existsSync(pkPath)) privateKeyPem = fs.readFileSync(pkPath, 'utf8');

  if (!privateKeyPem) throw new Error('Missing GitHub App private key (GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH)');

  const jwt = createJwt(appId, privateKeyPem);

  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': 'envzilla'
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create installation token: ${res.status} ${res.statusText} - ${text}`);
  }

  const data = await res.json();
  if (!data || !data.token) throw new Error('No token in GitHub response');
  return data.token as string;
}

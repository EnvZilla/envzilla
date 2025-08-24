import express, { Express, Request, Response, NextFunction } from 'express';
// Load environment variables from .env as early as possible so process.env values
// (for example TRUST_PROXY) are available when Express initializes and when
// middleware like express-rate-limit inspects req.ip / X-Forwarded-For.
import dotenv from 'dotenv';
dotenv.config();
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import logger from './utils/logger.js';
import { verifySignature } from './middlewares/verifySignature.js';
import { spawn } from 'child_process';

const app: Express = express();
const PORT: number = Number(process.env.PORT) || 3000;

// In-memory mapping from pull request number -> deployment info.
// This is intentionally simple for now; a real implementation should
// persist this mapping in a durable store so it survives restarts.
const deployments = new Map<number, { containerId?: string; hostPort?: number; createdAt: number }>();

// Helper to run a local TypeScript script via `npx tsx` and collect logs.
function runLocalScript(args: string[], cwd = process.cwd(), timeoutMs = 10 * 60 * 1000): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn('npx', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			try { child.kill('SIGKILL'); } catch {}
			reject(new Error(`Script ${args.join(' ')} timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout?.on('data', (b) => { const s = b.toString(); stdout += s; logger.info({ script: args.join(' '), chunk: s.trim() }, 'script stdout'); });
		child.stderr?.on('data', (b) => { const s = b.toString(); stderr += s; logger.warn({ script: args.join(' '), chunk: s.trim() }, 'script stderr'); });

		child.on('error', (err) => { clearTimeout(timer); reject(err); });
		child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }); });
	});
}

// Determine whether to trust proxy headers (needed for correct client IP detection
// when running behind a reverse proxy / load balancer). This ensures express-rate-limit
// can use X-Forwarded-For safely. Set TRUST_PROXY=true in environments like Heroku.
const trustProxy = process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production';
if (trustProxy) {
	// Trust the first proxy (typical for single-load-balancer setups)
	app.set('trust proxy', 1);
} else {
	app.set('trust proxy', false);
}

// Security: hide framework fingerprint
app.disable('x-powered-by');

// Helmet adds many security headers. CSP is application-specific so keep it off by default
app.use(helmet({ contentSecurityPolicy: false }));
// CORS: restrict origins via environment variable; default to localhost dev origin
const allowedOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000'];
app.use(
	cors({
		origin: allowedOrigins,
		methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		allowedHeaders: ['Content-Type', 'Authorization'],
		credentials: true,
	})
);

// Capture raw body for webhook signature verification. This must run before
// the JSON body parser so we can compute the HMAC over the exact bytes GitHub sent.
app.use((req, _res, next) => {
	const chunks: Uint8Array[] = [];
	req.on('data', (chunk: Uint8Array) => chunks.push(chunk));
	req.on('end', () => {
		try {
			const raw = Buffer.concat(chunks);
			// Attach raw body where middleware can find it for signature verification
			(req as any).rawBody = raw;
		} catch (e) {
			// ignore
		}
	});
	// continue — express.json will still run after this middleware
	next();
});

// Body parsing with size limit to mitigate large payload attacks
app.use(express.json({ limit: '1mb' }));

// Basic rate limiter to slow down brute force / scraping
const limiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: process.env.RATE_LIMIT_MAX ? Number(process.env.RATE_LIMIT_MAX) : 100, // limit each IP
	standardHeaders: true,
	legacyHeaders: false,
});
app.use(limiter);

app.get('/', (req: Request, res: Response) => {
	res.json({ status: 'ok', message: 'EnvZilla API server' });
});

// GitHub webhook endpoint — verify signature and process payload
app.post(
	'/webhooks/github',
	verifySignature,
	async (req: Request, res: Response) => {
		const event = req.headers['x-github-event'] as string | undefined;
		const { action, pull_request } = req.body as any;

		logger.info({ topic: 'webhook', provider: 'github', event, action }, '📦 Verified GitHub Webhook Payload Received');

		// Only process pull_request events
		if (event !== 'pull_request' || !pull_request) {
			res.status(200).send('Ignored');
			return;
		}

		const prNumber: number = Number(pull_request.number);

		try {
			if (action === 'opened' || action === 'reopened' || action === 'synchronize') {
				// Trigger build.ts which will build and run the container.
				// We run it via npx tsx so it uses the local TypeScript scripts.
				logger.info({ pr: prNumber }, 'Triggering build for PR');
				// Spawn the script; don't block long-running build in the request — respond 202 and stream logs asynchronously.
				runLocalScript(['tsx', 'build.ts']).then(result => {
					if (result.code === 0) {
						// Try to parse container id and port from stdout (build.ts prints info)
						const out = result.stdout || '';
						// crude parse: find line like 'Found free host port' or 'Container started' — adjust to your build.ts outputs
						const mId = out.trim().split('\n').reverse().find(l => l.match(/^[a-f0-9]{12,64}$/i));
						const portMatch = out.match(/Found free host port\s*:?\s*(\d+)/i);
						const hostPort = portMatch ? Number(portMatch[1]) : undefined;
						const containerId = mId || undefined;
						deployments.set(prNumber, { containerId, hostPort, createdAt: Date.now() });
						logger.info({ pr: prNumber, containerId, hostPort }, 'Build finished and deployment recorded');
					} else {
						logger.error({ pr: prNumber, code: result.code }, 'Build script failed');
					}
				}).catch(err => logger.error({ pr: prNumber, err }, 'Error running build script'));

				res.status(202).json({ status: 'building' });
				return;
			}

			if (action === 'closed' || action === 'merged') {
				// Trigger destroy for the PR's container if we have one recorded.
				const info = deployments.get(prNumber);
				if (!info || !info.containerId) {
					logger.warn({ pr: prNumber }, 'No deployment recorded for PR to destroy');
					res.status(200).json({ status: 'no-deployment' });
					return;
				}

				const containerId = info.containerId;
				logger.info({ pr: prNumber, containerId }, 'Triggering destroy for PR');

				runLocalScript(['tsx', 'destroy.ts', containerId]).then(result => {
					if (result.code === 0) {
						deployments.delete(prNumber);
						logger.info({ pr: prNumber, containerId }, 'Destroyed deployment for PR');
					} else {
						logger.error({ pr: prNumber, containerId, code: result.code }, 'Destroy script failed');
					}
				}).catch(err => logger.error({ pr: prNumber, err }, 'Error running destroy script'));

				res.status(202).json({ status: 'destroying' });
				return;
			}

			// Other PR actions: just acknowledge
			res.status(200).json({ status: 'ignored-action', action });
			return;
		} catch (err: any) {
			logger.error({ err, pr: prNumber }, 'Error handling webhook');
			res.status(500).json({ error: err?.message || 'Internal error' });
			return;
		}
	}
);

// 404 handler
app.use((req: Request, res: Response) => {
	res.status(404).json({ error: 'Not Found' });
});

// Centralized error handler — don't leak stack in production
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
	logger.error({ err }, 'Unhandled error');
	const status = err?.status || 500;
	const message = process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err?.message || 'Internal Server Error';
	res.status(status).json({ error: message });
});

app.listen(PORT, () => {
	logger.info({ port: PORT }, `EnvZilla sample app roaring on port http://localhost:${PORT} — press CTRL+C to calm the beast`);
});

export default app;


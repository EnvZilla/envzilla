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
import { dispatchWebhookEvent, getDeploymentInfo, getAllDeployments, cleanupStaleDeployments } from './middlewares/dispatcherServer.js';
import { performHealthCheck, logHealthStatus } from './utils/healthCheck.js';
import { spawn } from 'child_process';
import * as worker from './worker.js';

const app: Express = express();
const PORT: number = Number(process.env.PORT) || 3000;

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
		// Include GitHub webhook headers so preflight requests succeed when
		// running in environments that enforce CORS for service-to-service calls.
		allowedHeaders: ['Content-Type', 'Authorization', 'X-Hub-Signature-256', 'X-Hub-Signature', 'X-GitHub-Event'],
		credentials: true,
	})
);

// Body parsing with size limit to mitigate large payload attacks. Use the
// `verify` option to capture the raw request body buffer for HMAC
// verification without consuming the stream twice.
app.use(express.json({
	limit: '1mb',
	verify: (req: any, _res, buf: Buffer) => {
		// Save raw buffer for signature verification middleware
		req.rawBody = buf;
	},
}));

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

// Health check endpoint
app.get('/health', async (req: Request, res: Response) => {
	try {
		const health = await performHealthCheck();
		const statusCode = health.status === 'healthy' ? 200 : 
						   health.status === 'degraded' ? 206 : 503;
		
		res.status(statusCode).json(health);
	} catch (error: any) {
		logger.error({ error: error.message }, 'Health check failed');
		res.status(503).json({
			status: 'unhealthy',
			timestamp: Date.now(),
			error: 'Health check failed'
		});
	}
});

// Get deployment information for a specific PR
app.get('/deployments/:prNumber', (req: Request, res: Response) => {
	const prNumber = Number(req.params.prNumber);
	if (isNaN(prNumber)) {
		return res.status(400).json({ error: 'Invalid PR number' });
	}

	const deployment = getDeploymentInfo(prNumber);
	if (!deployment) {
		return res.status(404).json({ error: 'Deployment not found' });
	}

	res.json({
		pr: prNumber,
		status: deployment.status,
		containerId: deployment.containerId,
		hostPort: deployment.hostPort,
		createdAt: new Date(deployment.createdAt).toISOString(),
		branch: deployment.branch,
		commitSha: deployment.commitSha
	});
});

// Get all active deployments
app.get('/deployments', (req: Request, res: Response) => {
	const deployments = getAllDeployments();
	const deploymentList = Array.from(deployments.entries()).map(([prNumber, deployment]) => ({
		pr: prNumber,
		status: deployment.status,
		containerId: deployment.containerId,
		hostPort: deployment.hostPort,
		createdAt: new Date(deployment.createdAt).toISOString(),
		branch: deployment.branch,
		commitSha: deployment.commitSha
	}));

	res.json({
		count: deploymentList.length,
		deployments: deploymentList
	});
});

// Manual cleanup endpoint for stale deployments
app.post('/admin/cleanup', (req: Request, res: Response) => {
	const maxAgeHours = Number(req.query.maxAge) || 24;
	const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
	
	const cleanedCount = cleanupStaleDeployments(maxAgeMs);
	
	res.json({
		message: `Cleanup completed`,
		cleanedDeployments: cleanedCount,
		maxAgeHours
	});
});

// Main GitHub webhook endpoint - now uses the comprehensive event dispatcher
app.post(
	'/webhooks/github',
feat/verify-signature
	verifySignature,
	dispatchWebhookEvent
	// Allow slightly larger payloads for webhooks while keeping global limit small
	express.json({ limit: '100kb' }),
	(req: Request, res: Response) => {
		logger.info({ topic: 'webhook', provider: 'github' }, '📦 Received GitHub Webhook Payload');
		// Also print the full payload to the terminal for debugging
		// eslint-disable-next-line no-console
		if (process.env.NODE_ENV !== 'production') {
			console.dir(req.body, { depth: null });
		}
		res.status(200).send('Webhook received');
	}
develop
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
	
	// Start background cleanup job - runs every 6 hours
	const cleanupInterval = setInterval(() => {
		logger.info('🧹 Running scheduled cleanup of stale deployments');
		try {
			const cleanedCount = cleanupStaleDeployments();
			if (cleanedCount > 0) {
				logger.info({ cleanedCount }, 'Scheduled cleanup completed');
			}
		} catch (error: any) {
			logger.error({ error: error.message }, 'Error during scheduled cleanup');
		}
	}, 6 * 60 * 60 * 1000); // 6 hours

	// Start periodic health checks - runs every 5 minutes
	const healthCheckInterval = setInterval(async () => {
		try {
			const health = await performHealthCheck();
			logHealthStatus(health);
		} catch (error: any) {
			logger.error({ error: error.message }, 'Error during health check');
		}
	}, 5 * 60 * 1000); // 5 minutes

	// Graceful shutdown
	const shutdown = () => {
		logger.info('Shutting down gracefully');
		clearInterval(cleanupInterval);
		clearInterval(healthCheckInterval);
		process.exit(0);
	};

	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
});

export default app;


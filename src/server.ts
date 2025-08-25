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
import { getQueueStats, getJobStatus } from './lib/jobQueue.js';
import { DeploymentManager } from './lib/deploymentManager.js';
import { performHealthCheck, logHealthStatus } from './utils/healthCheck.js';

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
	verify: (req: Request & { rawBody?: Buffer }, _res, buf: Buffer) => {
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
	} catch (error: unknown) {
		logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Health check failed');
		res.status(503).json({
			status: 'unhealthy',
			timestamp: Date.now(),
			error: 'Health check failed'
		});
	}
});

// Get deployment information for a specific PR
app.get('/deployments/:prNumber', async (req: Request, res: Response) => {
	const prNumber = Number(req.params.prNumber);
	if (isNaN(prNumber)) {
		return res.status(400).json({ error: 'Invalid PR number' });
	}

	try {
		const deployment = await getDeploymentInfo(prNumber);
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
	} catch (error: unknown) {
		logger.error({ pr: prNumber, error: error instanceof Error ? error.message : String(error) }, 'Failed to get deployment info');
		res.status(500).json({ error: 'Internal server error' });
	}
});

// Get all active deployments
app.get('/deployments', async (req: Request, res: Response) => {
	try {
		const deployments = await getAllDeployments();
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
	} catch (error: unknown) {
		logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to get all deployments');
		res.status(500).json({ error: 'Internal server error' });
	}
});

// Manual cleanup endpoint for stale deployments
app.post('/admin/cleanup', async (req: Request, res: Response) => {
	const maxAgeHours = Number(req.query.maxAge) || 24;
	const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
	
	try {
		const cleanedCount = await cleanupStaleDeployments(maxAgeMs);
		
		res.json({
			message: `Cleanup completed`,
			cleanedDeployments: cleanedCount,
			maxAgeHours
		});
	} catch (error: unknown) {
		logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to cleanup stale deployments');
		res.status(500).json({ error: 'Internal server error' });
	}
});

// Job queue monitoring endpoints
app.get('/admin/queue/stats', async (req: Request, res: Response) => {
	try {
		const queueStats = await getQueueStats();
		const deploymentStats = await DeploymentManager.getDeploymentStats();
		
		res.json({
			queue: queueStats,
			deployments: deploymentStats,
			timestamp: Date.now()
		});
	} catch (error: unknown) {
		logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to get queue stats');
		res.status(500).json({ error: 'Internal server error' });
	}
});

// Get specific job status
app.get('/admin/jobs/:jobId', async (req: Request, res: Response) => {
	const jobId = req.params.jobId;
	
	try {
		const jobStatus = await getJobStatus(jobId);
		if (!jobStatus) {
			return res.status(404).json({ error: 'Job not found' });
		}
		
		res.json(jobStatus);
	} catch (error: unknown) {
		logger.error({ jobId, error: error instanceof Error ? error.message : String(error) }, 'Failed to get job status');
		res.status(500).json({ error: 'Internal server error' });
	}
});

// Main GitHub webhook endpoint - now uses the comprehensive event dispatcher
app.post(
	'/webhooks/github',
	// Allow slightly larger payloads for webhooks while keeping global limit small
	express.json({ limit: '100kb' }),
	verifySignature,
	dispatchWebhookEvent,
	(req: Request, res: Response) => {
		logger.info({ topic: 'webhook', provider: 'github' }, '📦 Received GitHub Webhook Payload');
		// Also print the full payload to the terminal for debugging
		if (process.env.NODE_ENV !== 'production') {
			logger.debug({ payload: req.body }, '🔍 Full webhook payload');
		}
		res.status(200).send('Webhook received');
	}
);

// 404 handler
app.use((req: Request, res: Response) => {
	res.status(404).json({ error: 'Not Found' });
});

// Centralized error handler — don't leak stack in production
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
	logger.error({ err }, 'Unhandled error');
	const status = err?.status || 500;
	const message = process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err?.message || 'Internal Server Error';
	res.status(status).json({ error: message });
});

app.listen(PORT, () => {
	logger.info({ port: PORT }, `EnvZilla sample app roaring on port http://localhost:${PORT} — press CTRL+C to calm the beast`);
	
	// Start background cleanup job - runs every 6 hours
	const cleanupInterval = setInterval(async () => {
		logger.info('🧹 Running scheduled cleanup of stale deployments');
		try {
			const cleanedCount = await cleanupStaleDeployments();
			if (cleanedCount > 0) {
				logger.info({ cleanedCount }, 'Scheduled cleanup completed');
			}
		} catch (error: unknown) {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Error during scheduled cleanup');
		}
	}, 6 * 60 * 60 * 1000); // 6 hours

	// Start periodic health checks - runs every 5 minutes
	const healthCheckInterval = setInterval(async () => {
		try {
			const health = await performHealthCheck();
			logHealthStatus(health);
		} catch (error: unknown) {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Error during health check');
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


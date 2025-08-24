import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import logger from './utils/logger.js';

const app: Express = express();
const PORT: number = Number(process.env.PORT) || 3000;

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

// Body parsing with size limit to mitigate large payload attacks
app.use(express.json({ limit: '10kb' }));

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

// GitHub webhook endpoint — log payload for now
app.post(
	'/webhooks/github',
	// Allow slightly larger payloads for webhooks while keeping global limit small
	express.json({ limit: '100kb' }),
	(req: Request, res: Response) => {
		logger.info({ topic: 'webhook', provider: 'github' }, '📦 Received GitHub Webhook Payload');
		// Also print the full payload to the terminal for debugging
		// eslint-disable-next-line no-console
		console.dir(req.body, { depth: null });
		res.status(200).send('Webhook received');
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


/**
 * EnvZilla - Main Entry Point
 * 
 * This is the main entry point for the EnvZilla application.
 * It starts the Express server with comprehensive webhook handling,
 * encryption, and deployment management capabilities.
 */

import { app, HOST, PORT } from './server.js';
import logger from './utils/logger.js';
import { cleanupStaleDeployments } from './middlewares/dispatcherServer.js';
import { performHealthCheck, logHealthStatus } from './utils/healthCheck.js';

// Start the server
app.listen(PORT, HOST, () => {
	logger.info({ port: PORT, host: HOST }, `EnvZilla sample app roaring on http://${HOST}:${PORT} — press CTRL+C to calm the beast`);
	
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
}).on('error', (error: NodeJS.ErrnoException) => {
	logger.error({ error: error.message, port: PORT, host: HOST }, '❌ Failed to start server');
	process.exit(1);
});

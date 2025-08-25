# EnvZilla: Unleash Monstrously Powerful Preview Environments 👹

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE.md)
[![Node.js >=20](https://img.shields.io/badge/Node.js-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**EnvZilla** is an open-source GitOps monster that awakens to create and destroy ephemeral preview environments for your GitHub pull requests. It unleashes an isolated Docker container for every `opened` PR and tears it down when the PR is `closed`, posting real-time battle updates directly to the pull request conversation.

This project is engineered to be a powerful, secure, and scalable beast, using webhooks and secure token-based operations.

## 📑 Table of Contents

- [How The Beast Works](#️-how-the-beast-works)
- [Key Features](#-key-features)
- [Architecture](#️-architecture)
- [Prerequisites](#-prerequisites)
- [Getting Started](#-getting-started-the-taming-manual)
- [Configuration](#-configuration)
- [Usage](#️-usage)
- [Troubleshooting](#️-troubleshooting)
- [Contributing](#-contributing)
- [Contact & Support](#-contact--support)

## 🏗️ How The Beast Works

When a pull request is born, EnvZilla awakens!

1. **Webhook Trigger**: A GitHub webhook event pokes the beast.
2. **Validation**: The server validates the webhook signature using your secret.
3. **Build Process**: The system clones the branch and builds a Docker container.
4. **The Roar**: When complete, a link to the preview environment is provided.

When the PR is closed, the beast returns to put the environment back to sleep. 😴

## ✨ Key Features

* **Secure Webhook Verification**: Only accepts authenticated webhook requests.
* **Automated Container Lifecycle**: Automatically builds, starts, stops, and destroys Docker containers in sync with PR events.
* **Isolated Environments**: Each preview runs in its own container for maximum security and isolation.
* **Resource Management**: Smart allocation prevents environment sprawl from consuming your server.
* **Real-Time Status Updates**: Monitor deployment status via API endpoints.
* **Health Monitoring**: Built-in health checks ensure system stability.

## 🏛️ Architecture

EnvZilla uses a modern, scalable architecture with Redis-based job queues for high-performance preview environment management:

### Core Components

1. **API Server (`src/server.ts`)**: Handles webhook events, signature verification, and API endpoints
2. **Job Queue System (`src/lib/jobQueue.ts`)**: Redis + BullMQ for scalable job processing
3. **Worker Process (`src/jobWorker.ts`)**: Processes build/destroy jobs from the queue
4. **Deployment Manager (`src/lib/deploymentManager.ts`)**: Redis-based deployment state tracking

### Job Queue Architecture

```
GitHub Webhook → Server → Job Queue (Redis + BullMQ) → Worker Process(es)
                    ↓
               Deployment Tracking (Redis)
```

**Key Benefits:**
- **Horizontal Scalability**: Run multiple worker processes
- **Job Persistence**: Jobs survive server restarts  
- **Non-blocking**: Webhook responses return immediately
- **Automatic Retry**: Failed jobs retry with exponential backoff
- **Real-time Monitoring**: Queue statistics and job status tracking

For detailed information about the job queue system, see [Job Queue Documentation](./docs/JOB_QUEUE.md).

<p align="center">
  <img src="/public/architecture-diagram.png" alt="EnvZilla Architecture Diagram" width="600" />
</p>

This architecture provides scalability and security by separating the concerns of request handling and resource-intensive operations.

## 📋 Prerequisites

Before you can tame this beast, make sure you have:

* **Docker** installed on your machine
* **Redis** server for job queue and deployment tracking
* **Node.js 20+** for local development
* A **GitHub repository** with webhook permissions configured

## 🚀 Getting Started (The Taming Manual)

1. **Clone this repository**:
   ```bash
   git clone https://github.com/EnvZilla/envzilla.git
   cd envzilla
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start Redis** (using Docker):
   ```bash
   docker run -d --name redis -p 6379:6379 redis:7-alpine
   ```

4. **Set up your environment**:
   * Copy the example env file: `cp .env.example .env`
   * Edit `.env` with your configuration:
     ```bash
     GITHUB_WEBHOOK_SECRET=your_webhook_secret
     REDIS_HOST=localhost
     REDIS_PORT=6379
     ```

5. **Start the application** (choose one method):
   
   **Method 1: Using Docker Compose (Recommended)**
   ```bash
   docker-compose up -d
   ```
   
   **Method 2: Manual Development**
   ```bash
   # Terminal 1: Start server
   npm run dev:server
   
   # Terminal 2: Start worker
   npm run dev:worker
   ```
   
   **Method 3: Production Build**
   ```bash
   npm run build
   npm run start:server  # Terminal 1
   npm run start:worker  # Terminal 2
   ```

5. **Configure your GitHub repository webhook**:
   * Go to your repository → Settings → Webhooks → Add webhook
   * Set Payload URL to your server address
   * Set Content type to `application/json`
   * Set Secret to the same value as `GITHUB_WEBHOOK_SECRET` in your `.env`
   * Select "Let me select individual events" and choose "Pull requests"

6. **Test your webhook**:
   ```bash
   # Run the test script to verify connectivity
   node test-webhook.js
   ```

## ⚙️ Configuration

EnvZilla can be tamed through environment variables:

### Server Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Port for the API server | `3000` |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `GITHUB_WEBHOOK_SECRET` | Secret for webhook verification | *Required* |
| `RATE_LIMIT_MAX` | Maximum API requests per window | `100` |
| `CORS_ORIGIN` | Allowed CORS origins | `http://localhost:3000` |
| `TRUST_PROXY` | Whether to trust proxy headers | `true` |

### Redis Configuration  
| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_HOST` | Redis server hostname | `localhost` |
| `REDIS_PORT` | Redis server port | `6379` |
| `REDIS_PASSWORD` | Redis authentication password | *(none)* |
| `REDIS_DB` | Redis database number | `0` |

### Health Check Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `CONTAINER_HEALTH_TIMEOUT_MS` | Max time to wait for container health | `30000` (30s) |
| `PREVIEW_URL_TIMEOUT_MS` | Total timeout for preview URL checks | `50000` (50s) |
| `PREVIEW_URL_ATTEMPTS` | Number of attempts to check preview URL | `10` |
| `PREVIEW_URL_DELAY_MS` | Delay between preview URL attempts | `2000` (2s) |
| `PREVIEW_URL_REQUEST_TIMEOUT_MS` | Timeout per preview URL request | `5000` (5s) |

### Job Queue Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `JOB_CONCURRENCY` | Concurrent jobs per worker | `3` |

## 🕹️ Usage

1. Go to the repository where you configured the webhook
2. **Open a new Pull Request**
3. EnvZilla will process the PR and create a preview environment
4. **Monitor the status** via the `/deployments/:prNumber` endpoint
5. **Close the Pull Request**
6. EnvZilla will clean up the environment

### API Endpoints

#### Deployment Management
- **`GET /health`**: Check system health (includes Redis connectivity)
- **`GET /deployments/:prNumber`**: Get status of a specific deployment
- **`GET /deployments`**: List all active deployments  
- **`POST /admin/cleanup`**: Manually trigger cleanup of stale deployments

#### Job Queue Monitoring  
- **`GET /admin/queue/stats`**: Get queue statistics and deployment counts
- **`GET /admin/jobs/:jobId`**: Get status of a specific job

#### Webhook Endpoint
- **`POST /webhooks/github`**: Webhook endpoint for GitHub events

## ⚠️ Troubleshooting

### Common Issues

| Problem | Solution |
|---------|----------|
| Webhook not triggering | Check your webhook configuration and secret |
| Container build fails | Ensure Docker is running and has enough resources |
| Server won't start | Check that all required environment variables are set |
| Signature verification fails | Verify that webhook secret matches in both GitHub and .env |
| **Redis connection error** | **Ensure Redis server is running on configured host/port** |
| **Jobs stuck in queue** | **Check if worker process is running and can access Redis** |
| **Deployments not updating** | **Verify Redis connectivity and check worker logs** |

### Monitoring

Check system status and job queue health:
```bash
# System health (includes Redis connectivity)
curl http://localhost:3000/health

# Queue statistics  
curl http://localhost:3000/admin/queue/stats
```

## 🌟 Contributing

We love contributions from our community! Whether it's:

- 🐛 Bug reports and fixes
- ✨ New features
- 📚 Documentation improvements
- 💬 Feedback and suggestions

See our [Contributing Guide](./CONTRIBUTING.md) for more details on how to get involved.

## 📞 Contact & Support

- **GitHub Issues**: For bug reports and feature requests
- **Security**: See our [Security Guide](./SECURITY.md) for reporting vulnerabilities

---

<p align="center">
  Made with 💖 by the EnvZilla team
</p>
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

EnvZilla consists of two primary components working together to create and manage preview environments:

1. **API Layer (`server.js`)**: Handles webhook events, signature verification, and API endpoints
2. **Worker Layer**: Performs container management, git operations, and deployment tasks

<p align="center">
  <img src="/public/architecture-diagram.png" alt="EnvZilla Architecture Diagram" width="600" />
</p>

This architecture provides scalability and security by separating the concerns of request handling and resource-intensive operations.

## 📋 Prerequisites

Before you can tame this beast, make sure you have:

* **Docker** installed on your machine
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

3. **Set up your environment**:
   * Copy the example env file: `cp .env.example .env`
   * Edit `.env` with at minimum your GitHub webhook secret:
     ```
     GITHUB_WEBHOOK_SECRET=your_webhook_secret
     ```

4. **Start the server** (choose one method):
   ```bash
   # Method 1: Build and start
   npm run build
   npm start
   
   # Method 2: Direct execution with tsx
   npx tsx src/server.ts
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

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Port for the API server | `3000` |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `GITHUB_WEBHOOK_SECRET` | Secret for webhook verification | *Required* |
| `RATE_LIMIT_MAX` | Maximum API requests per window | `100` |
| `CORS_ORIGIN` | Allowed CORS origins | `http://localhost:3000` |
| `TRUST_PROXY` | Whether to trust proxy headers | `true` |

## 🕹️ Usage

1. Go to the repository where you configured the webhook
2. **Open a new Pull Request**
3. EnvZilla will process the PR and create a preview environment
4. **Monitor the status** via the `/deployments/:prNumber` endpoint
5. **Close the Pull Request**
6. EnvZilla will clean up the environment

### API Endpoints

- **`GET /health`**: Check system health
- **`GET /deployments/:prNumber`**: Get status of a specific deployment
- **`GET /deployments`**: List all active deployments
- **`POST /webhooks/github`**: Webhook endpoint for GitHub events

## ⚠️ Troubleshooting

### Common Issues

| Problem | Solution |
|---------|----------|
| Webhook not triggering | Check your webhook configuration and secret |
| Container build fails | Ensure Docker is running and has enough resources |
| Server won't start | Check that all required environment variables are set |
| Signature verification fails | Verify that webhook secret matches in both GitHub and .env |

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
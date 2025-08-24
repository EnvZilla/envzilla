# EnvZilla: Unleash Monstrously Powerful Preview Environments 👹

**EnvZilla** is an open-source GitOps monster that awakens to create and destroy ephemeral preview environments for your GitHub pull requests. It unleashes an isolated Docker container for every `opened` PR and tears it down when the PR is `closed`, posting real-time battle updates directly to the pull request conversation.

This project is engineered to be a powerful, secure, and scalable beast, using a GitHub App, a Redis-based job queue, and secure token-based operations.

-----

## 🏗️ How The Beast Works

When a pull request is born, EnvZilla awakens!

1.  **Webhook Trigger**: A GitHub webhook event pokes the beast.
2.  **Job Queued**: The API layer validates the event and adds a `create-preview` or `destroy-preview` job to a Redis-powered BullMQ queue.
3.  **Worker Awakens**: A background worker grabs the job. It authenticates as a GitHub App, clones the branch, and forges a Docker container in the fires of your server.
4.  **The Roar**: The worker roars back, posting a comment on the pull request with a link to the live preview.

When the PR is closed, the beast returns to put the environment back to sleep. 😴

## ✨ Key Features

* **GitHub App Authentication**: Secure, modern authentication. No fragile personal access tokens.
* **Asynchronous Job Processing**: A Redis & BullMQ queue makes the API monstrously fast and resilient.
* **Automated Container Lifecycle**: Automatically builds, starts, stops, and destroys Docker containers in sync with PR events.
* **Real-Time PR Comments**: Keeps your team updated by posting status comments directly on pull requests.

## 🏛️ Architecture

The system is split into two primary components for scalability and raw power:

1.  **API Layer (`server.js`)**: A stateless, lightweight Express.js server that only catches, verifies, and queues incoming webhooks.
2.  **Worker Layer (`worker.js`)**: A background beast that consumes jobs and does all the heavy lifting: authenticating, cloning, building, and roaring back to GitHub.

## 🛠️ Technology Stack

* **Backend**: Node.js, Express.js
* **Containerization**: Docker, Dockerode
* **Job Queue**: Redis, BullMQ
* **GitHub Integration**: Octokit, GitHub Apps
* **Deployment**: Docker Compose

## 🚀 Getting Started (The Taming Manual)

1.  **Create a GitHub App**:
    * Give it `Read & Write` on Pull requests and `Read-only` on Contents.
    * Subscribe to the `Pull request` event.
    * Generate a private key and note the App ID and a webhook secret.

2.  **Configure Your Lair**:
    * Clone this repo and create a `.env` file.
    * Add your `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, and point `GITHUB_PRIVATE_KEY_PATH` to your `.pem` file.

3.  **Unleash the Beast**:
    * Use `ngrok` to expose your local port 3000 and update your GitHub App's webhook URL.
    * Run the entire stack with a single command:
        ```bash
        docker-compose up --build -d
        ```

## 🕹️ Usage

1.  Go to the repository where you installed the GitHub App.
2.  **Open a new Pull Request.**
3.  EnvZilla will post a comment:
    > ✅ Preview environment unleashed: http://localhost:PORT
4.  **Close the Pull Request.**
5.  The bot will post a final comment:
    > 🗑️ Preview environment has been put to sleep.

## 🤝 Community & Policies

* **Contributing**: We welcome all monster tamers! Please read our **[Contributing Guide](./CONTRIBUTING.md)** to get started.
* **Code of Conduct**: All participants are expected to follow our **[Code of Conduct](./CODE_OF_CONDUCT.md)**.
* **Security**: For a breakdown of risks and responsible disclosure, see our **[Security Guide](./SECURITY.md)**.
* **License & Terms**: This project is licensed under the MIT License. By using it, you agree to the **[Terms of Use](./TERMS.md)**.
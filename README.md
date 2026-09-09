# LazyDev Server (self-hosted)

LazyDev is an AI-native autonomous CI engineering assistant that monitors GitHub issues, generates validated code fixes, and pushes fix branches safely.

This is the **self-hosted** build of the backend: you run the entire stack yourself. There is no hosted/SaaS mode in this repo — multi-tenant GitHub OAuth, the isolated MCP port, and the hosted control plane have been stripped out.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Create and configure your GitHub App](#2-create-and-configure-your-github-app)
3. [Environment setup](#3-environment-setup)
4. [LLM & embedding providers (Backend & Client options)](#4-llm--embedding-providers-backend--client-options)
5. [Run the full stack (Docker) & optional webhook tunnel](#5-run-the-full-stack-docker--optional-webhook-tunnel)
6. [Local development](#6-local-development)
7. [MCP server (Hermes / OpenClaw / Claude Desktop)](#7-mcp-server-hermes--openclaw--claude-desktop)
8. [Observability](#8-observability)
9. [Connecting the frontend client dashboard](#9-connecting-the-frontend-client-dashboard)
10. [Development standards](#10-development-standards)
11. [Features](#11-features)
12. [License](#12-license)

---

## 1. Prerequisites

- **Cloud server / VM**: Linux (Ubuntu/Debian recommended) for production, or macOS/Linux for local development.
- **Node.js** v20+ (only needed for local dev; the Docker image bundles Node).
- **Docker & Docker Compose**.
- **GitHub App credentials** — App ID, Private Key (`.pem`), Webhook Secret (created by you; see §2).
- **LLM API key** — OpenAI / Google Gemini / Anthropic / DeepSeek / OpenRouter, **or** a running **Ollama** instance (free local fallback).
- **Discord webhook URL** (optional, for notifications).

---

## 2. Create and configure your GitHub App

LazyDev interacts with GitHub through a GitHub App registered under your account or organization. Since this is a self-hosted installation, you create and manage your own GitHub App for complete privacy and control over your repositories.

### Step-by-step setup

1. Go to GitHub: **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.
2. **Name**: Choose a unique name (e.g. `lazydev-<your-team>`).
3. **Homepage URL**: Set to your repository or company domain (e.g. `https://github.com/<your-org>/lazydev-server`).
4. **Webhook URL**: Set to `https://<your-public-url>/webhooks/github` (see [§5](#optional-webhook-endpoint--tunnel-configuration-ngrok--tailscale) for setting up a public domain or running an ngrok tunnel).
5. **Webhook secret**: Enter a strong secret string (you will put this into `.env` as `GITHUB_WEBHOOK_SECRET`).
6. Under **Repository permissions**, grant:

   | Permission | Level | Why |
   |---|---|---|
   | Metadata | Read | Mandatory for all GitHub Apps. |
   | Contents | Read & write | Clone repository code and push fix branches. |
   | Pull requests | Read & write | Open and update pull requests with validated fixes. |
   | Issues | **Read & write** | Read issues; *write* is required by the MCP `implement_new_feature` tool to create tracking issues. |

7. Under **Subscribe to events**, select:
   - **Issues**
   - **Issue comment**
   - **Check run**
8. Click **Create GitHub App**.
9. In the newly created app's settings:
   - Copy the **App ID** (save this for `GITHUB_APP_ID` in `.env`).
   - Scroll to **Private keys** and click **Generate a private key**. A `.pem` file will download. Move this file into your `lazydev-server` directory (e.g. `github-private-key.pem`).
10. In the left sidebar, click **Install App**, choose your account or organization, and select **Only select repositories** (the repos you want LazyDev to monitor) or all repositories.

> [!IMPORTANT]
> If you update repository permissions later, GitHub emails the installation owner an approval request. The app retains its **old** permissions until approved, so operations requiring new permissions will fail until accepted.

---

## 3. Environment setup

Clone this repository and copy the example environment file:

```bash
git clone https://github.com/FutureMindsDev/lazydev-server.git
cd lazydev-server
cp .env.example .env
```

Edit `.env`. The file is grouped into clearly labelled sections (GitHub App, LLM provider, Embedding, Serena, MCP server, Sandbox, Infrastructure) and each variable is tagged `[DOCKER]`, `[DEV]`, or `BOTH`. The minimum you must fill in:

```env
# GitHub App (from §2)
GITHUB_APP_ID=123456
GITHUB_WEBHOOK_SECRET=your_webhook_secret_here
GITHUB_PRIVATE_KEY_PATH=github-private-key.pem

# LLM provider (pick one — see §4)
OPENAI_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
```

Everything else has sensible defaults for a Docker deployment.

> **Do I need the DB / Redis / server / repo-cache / sandbox configs in `.env`?**  
> **No**, if you are running the full stack via `docker compose up`. The `docker-compose.yml` already sets `DB_HOST=postgres`, `REDIS_HOST=redis`, `QDRANT_URL=http://qdrant:6333`, `WORKTREE_BASE_PATH=/app/worktrees`, etc. Those variables are listed in `.env.example` only so you can override them for **local development** (`npm run start:dev`) or external infrastructure.

---

## 4. LLM & embedding providers (Backend & Client options)

LazyDev supports a wide range of LLM and embedding providers with smart auto-detection. You can configure credentials using either of two methods:

- **Option 1 — Configure keys via the backend (`.env`)**: Ideal for headless server deployments, Docker configurations, and automated CI/CD.
- **Option 2 — Configure keys via the client dashboard (`lazydev-client`)**: Dynamic UI configuration stored securely in PostgreSQL without restarting containers or editing files.

---

### Option 1 — Configure keys via the backend (`.env`)

#### Shared provider configuration

LazyDev auto-detects the provider from `OPENAI_BASE_URL` and routes to the right client: **direct Gemini, DeepSeek, and Anthropic go through their provider-native LangChain clients** (which handle their payload-specific requirements natively — e.g. Gemini 3 `thought_signature` round-trips), while **OpenAI, OpenRouter, Ollama, and any other OpenAI-compatible gateway** (LiteLLM, vLLM) go through `@langchain/openai`'s Chat Completions client.

Set `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `LLM_MODEL`:

| Provider | `OPENAI_BASE_URL` | Example `LLM_MODEL` | Client |
|---|---|---|---|
| **OpenAI** (native) | *(leave blank)* | `gpt-4o-mini` | ChatOpenAI |
| **Google Gemini** (direct) | `https://generativelanguage.googleapis.com` | `gemini-3.7-flash` | ChatGoogleGenerativeAI (native) |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `anthropic/claude-5-sonnet` | ChatOpenAI (OpenAI-compat) |
| **DeepSeek** (direct) | `https://api.deepseek.com` | `deepseek-chat` | ChatDeepSeek (native) |
| **Anthropic** (direct) | `https://api.anthropic.com` | `claude-sonnet-4-5` | ChatAnthropic (native Messages API) |
| **NVIDIA NIM** | `https://integrate.api.nvidia.com/v1` | `meta/llama-3.1-405b-instruct` | ChatOpenAI (OpenAI-compat) |
| **Z.AI / GLM** | `https://api.z.ai/api/paas/v4` | `glm-4.6` | ChatOpenAI (OpenAI-compat) |
| **MiniMax** | `https://api.minimaxi.com/v1` | `MiniMax-M2` | ChatOpenAI (OpenAI-compat, `stripThinkTokens` guard) |
| **Xiaomi MiMo** | `https://api.xiaomi.com/v1` | `mimo-7b` | ChatOpenAI (OpenAI-compat) |
| **Kimi (Moonshot)** | `https://api.moonshot.cn/v1` | `kimi-k2` | ChatOpenAI (OpenAI-compat) |
| **Grok (xAI)** | `https://api.x.ai/v1` | `grok-4` | ChatOpenAI (OpenAI-compat) |
| **Ollama** (local, free) | *(leave `OPENAI_API_KEY` blank)* | `llama3` (set `OLLAMA_LLM_MODEL=llama3`) | ChatOpenAI (Ollama's OpenAI-compat endpoint) |

> **MiniMax / interleaved-thinking models**: some models return `<think>…</think>` reasoning blocks inside `response.content`. LazyDev strips these automatically (`stripThinkTokens` guard) before downstream text processing.

#### Per-agent provider & model overrides (optional)

Every agent shares `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `LLM_MODEL` by default. You can override any agent to use a **different provider** (its own API key + base URL) **and/or** a different model:

```env
# PlannerAgent — strong reasoning model on the shared provider
PLANNER_MODEL=gpt-4o

# PatchGeneratorAgent — strong coding model on the shared provider
PATCH_GENERATOR_MODEL=gpt-4o

# OnboardingAgent — cheap DeepSeek (full provider + model override)
ONBOARDING_MODEL=deepseek-chat
ONBOARDING_API_KEY=sk-deepseek-...
ONBOARDING_BASE_URL=https://api.deepseek.com

# ValidationAgent — fast & economical model on the shared provider
VALIDATION_MODEL=gpt-4o-mini

# GitAgent — git commands only, no LLM needed
```

Every agent supports the `<AGENT>_MODEL`, `<AGENT>_API_KEY`, `<AGENT>_BASE_URL` trio for `PLANNER`, `PATCH_GENERATOR`, `VALIDATION`, `GIT`, and `ONBOARDING`. Leaving any line commented falls back to the shared defaults.

#### Embedding provider (RAG vector search)

`EMBEDDING_PROVIDER` selects the embedding backend (`google` | `openai` | `ollama`; auto-detected if unset). `EMBEDDING_MODEL` is the model name:

| Provider | Models |
|---|---|
| Google | `gemini-embedding-2` (default), `text-embedding-004`, `text-multilingual-embedding-002` |
| OpenAI | `text-embedding-3-small`, `text-embedding-3-large` |
| Ollama | `nomic-embed-text`, `mxbai-embed-large` |

By default, the embedding service reuses `OPENAI_API_KEY` / `OPENAI_BASE_URL` (or `GEMINI_API_KEY`). If your embedding provider differs from your LLM provider, set decoupled overrides:

```env
EMBEDDING_API_KEY=sk-...
EMBEDDING_BASE_URL=https://api.openai.com/v1
```

---

### Option 2 — Configure keys via the client dashboard (`lazydev-client`)

Instead of managing API keys inside `.env` files, you can configure and update your LLM providers directly from the web UI using the companion frontend repository [`lazydev-client`](https://github.com/FutureMindsDev/lazydev-client).

#### How to configure via the dashboard

1. Start `lazydev-client` (see [§9](#9-connecting-the-frontend-client-dashboard)) and open `http://localhost:3000`.
2. Navigate to **Settings** → **LLM Provider**.
3. You have two flexible ways to manage keys inside the UI:
   - **Default BYOK Provider**: Choose your provider (OpenAI, Gemini, Anthropic, DeepSeek, OpenRouter, Ollama, etc.), enter your API key, and select or type the default model name.
   - **Per-Agent Provider Role Mapping**: Add multiple named provider configs and assign specific agent roles (**Planner**, **Patch Generator**, **Validation**, **Onboarding**) to different providers and models. For instance, you can route the *Planner* and *Patch Generator* to Claude Sonnet 3.5 while routing *Onboarding* to a lightweight DeepSeek or Gemini Flash model.

#### Security & At-Rest Encryption

- The client saves credentials securely to the backend via `PUT /api/dashboard/settings/llm` and `POST /api/dashboard/settings/providers`.
- Secrets are encrypted at rest with **AES-256-GCM** in PostgreSQL (`llm_config` and `llm_provider_config` tables).
- To enable production encryption, set `LLM_CONFIG_ENCRYPTION_KEY` (32-byte hex, generated with `openssl rand -hex 32`) in `.env`. If left unset in dev mode, a deterministic dev key is used.
- API keys are write-only — the UI masks them and only ever displays the last 4 characters.

#### Precedence & Resolution Order

1. **Per-agent `.env` overrides** (`PLANNER_MODEL`, etc.) take the highest priority.
2. **Dashboard / DB configurations** take effect next.
3. If no dashboard configuration is found, the system cleanly falls back to the shared **backend `.env` variables** (`OPENAI_API_KEY`, `LLM_MODEL`). Deleting the client BYOK config immediately reverts to `.env` resolution on the next run.

---

## 5. Run the full stack (Docker) & optional webhook tunnel

Launch the entire LazyDev infrastructure with Docker Compose:

```bash
docker compose up -d --build
```

> Use `--build` the **first time** and whenever you change source code or the `Dockerfile`. For config-only changes (`.env`, `docker-compose.yml`), restart without rebuilding:
> ```bash
> docker compose up -d
> ```

### Docker socket & permissions

The app container requires access to `/var/run/docker.sock` so the `SandboxAgent` can spin up sibling containers for isolated code execution and validation.

> [!WARNING]
> Mounting `/var/run/docker.sock` gives the container control over the host Docker daemon. This is strictly required for the `SandboxAgent`. The container runs as `root` (`user: root` in `docker-compose.yml`) to ensure socket access. Ensure your host machine is adequately secured.

### Cross-platform sandbox (Mac, Linux, Windows)

LazyDev uses a **named Docker volume** (`worktrees`) to share workspace files between the app container and sandbox sibling containers. This works identically across platforms without host path binding issues.

### Optional: Webhook endpoint & tunnel configuration (ngrok / Tailscale)

LazyDev requires a public HTTP endpoint (`POST /webhooks/github`) to receive event webhooks (`issues.opened`, `issue_comment.created`, etc.) from GitHub. Each request's HMAC-SHA256 signature is verified against your `GITHUB_WEBHOOK_SECRET` before dispatching jobs to BullMQ.

Depending on your environment, choose how to expose your webhook endpoint:

#### Option A — ngrok in Docker (recommended for local development)

`docker-compose.yml` includes a pre-configured `ngrok` container service so you do not need to install ngrok on your host.

1. Sign up at [ngrok.com](https://ngrok.com) and get an authtoken.
2. Add your token to `.env`:
   ```env
   NGROK_AUTHTOKEN=your_ngrok_authtoken_here
   # NGROK_DOMAIN=your-reserved-domain.ngrok-free.app  # Optional (paid plan)
   ```
3. Open `docker-compose.yml` and **uncomment the `ngrok:` service block** (located under the `# Option 1: ngrok` header).
4. Start the tunnel container using the tunnel profile:
   ```bash
   docker compose --profile tunnel up -d
   ```
5. View the public URL printed in the ngrok container logs:
   ```bash
   docker compose logs ngrok
   ```
   (Look for the line containing `url=https://<random-id>.ngrok-free.app`).
6. Set your GitHub App's **Webhook URL** (in your app's General settings) to:
   ```
   https://<random-id>.ngrok-free.app/webhooks/github
   ```
7. *Tip*: You can view live incoming webhook payloads using ngrok's web inspection dashboard at `http://localhost:4040`.

#### Option B — Tailscale Funnel (private tailnet)

1. Get an auth key from [Tailscale Admin](https://login.tailscale.com/admin/settings/keys).
2. Set `TAILSCALE_AUTH_KEY=...` in `.env`.
3. Uncomment the `tailscale:` service block in `docker-compose.yml`.
4. Start with: `docker compose --profile tunnel up -d`.
5. Enable HTTPS + Funnel in the Tailscale admin console and set your Webhook URL to:
   `https://<machine>.<tailnet>.ts.net/webhooks/github`.

#### Option C — Reverse proxy with SSL (recommended for production)

For production on a cloud VM, place a reverse proxy (Caddy, Nginx, or Traefik) with a valid SSL certificate in front of port 3200 and set the Webhook URL to:
`https://lazydev.your-domain.com/webhooks/github`.

#### Option D — Direct public IP

`http://<your-server-ip>:3200/webhooks/github` (GitHub supports plain HTTP, but payloads travel unencrypted).

---

## 6. Local development

Run infrastructure in Docker, but run the NestJS app directly on your host machine for hot reloading:

```bash
docker compose up -d postgres redis qdrant
npm install
npm run start:dev
```

For local development, set the infrastructure connection variables in `.env` to `localhost` (`DB_HOST=localhost`, `REDIS_HOST=localhost`).

---

## 7. MCP server (Hermes / OpenClaw / Claude Desktop)

LazyDev exposes itself as an **MCP server** over Streamable HTTP, allowing MCP-capable platforms (Hermes, OpenClaw, Claude Desktop) to trigger and supervise fixes directly from chat. Tools are discovered automatically during the MCP protocol handshake.

### Tools exposed

| Tool | Purpose |
|---|---|
| `trigger_issue_fix(repository, issue_number, priority?)` | Fix an existing GitHub issue. `priority: "urgent"` jumps the queue. |
| `implement_new_feature(repository, feature_description)` | Write net-new code from a prompt. Creates a tracking issue (labelled `enhancement`, `lazydev`). |
| `get_pipeline_status(task_id)` | Check whether a run is queued, running, failed, or succeeded. |
| `provide_human_feedback(task_id, feedback)` | Send corrections. Active tasks apply feedback on the next validation retry. |

Write tools return a `task_id` immediately — jobs run asynchronously on the BullMQ queue.

### Deployment mode

The MCP surface is served on the main API port at `POST http://<host>:3200/mcp` (shared with the REST API and GitHub webhooks).

Set `MCP_SERVER_ENABLED=false` to turn the MCP surface off completely.

> [!WARNING]
> Since this endpoint shares port 3200, set `MCP_AUTH_TOKEN` in `.env` to require `Authorization: Bearer <token>`. Without it, anyone with network access to port 3200 can trigger pipeline jobs.

### Client configuration

Add LazyDev to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "lazydev": {
      "url": "http://localhost:3200/mcp",
      "transport": "streamable-http",
      "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
    }
  }
}
```

Verify with the smoke script:

```bash
npx ts-node test/test-mcp-server.ts                       # default
MCP_AUTH_TOKEN=s3cret npx ts-node test/test-mcp-server.ts  # with auth
```

---

## 8. Observability

The app exposes `/metrics` (Prometheus format) via `@willsoto/nestjs-prometheus`. `docker-compose.yml` provides optional Prometheus and Grafana containers.

| Dashboard | URL | Default login |
|---|---|---|
| NestJS API | http://localhost:3200 | — |
| pgAdmin (optional) | http://localhost:5050 | `admin@lazydev.com` / `admin` |
| RedisInsight (optional) | http://localhost:8001 | — |
| Grafana (optional) | http://localhost:3100 | `admin` / `admin` |
| Prometheus (optional) | http://localhost:9090 | — |

---

## 9. Connecting the frontend client dashboard

The dashboard UI lives in the [`lazydev-client`](https://github.com/FutureMindsDev/lazydev-client) repository — a Next.js 16 application that interfaces with this backend's `/api/dashboard/*` endpoints.

### Backend configuration

Verify the following CORS and auth settings in `lazydev-server/.env`:

```env
DEPLOYMENT_MODE=selfhosted
DASHBOARD_AUTH=none

# CORS: list all origins the frontend is served from
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
FRONTEND_URL=http://localhost:3000
```

Start the backend:

```bash
docker compose up -d --build      # API running on http://localhost:3200
```

### Frontend setup

Clone [`lazydev-client`](https://github.com/FutureMindsDev/lazydev-client) next to this repo:

```bash
git clone https://github.com/FutureMindsDev/lazydev-client.git
cd lazydev-client
pnpm install
cp .env.example .env.local
```

Edit `.env.local`:

```env
# Point at the LazyDev backend API
NEXT_PUBLIC_API_URL=http://localhost:3200

# Connect to real backend
NEXT_PUBLIC_ENABLE_MOCKS=false
```

Start the dashboard:

```bash
pnpm dev      # http://localhost:3000
```

Open `http://localhost:3000` to view real-time pipeline runs, queue states, repository indexing, and dynamic LLM provider settings. See the client repo's [`BACKEND_API_SPEC.md`](https://github.com/FutureMindsDev/lazydev-client/blob/main/BACKEND_API_SPEC.md) for full API contracts.

---

## 10. Development standards

- **Linting**: `npm run lint`
- **Formatting**: `npm run format`
- **Tests**: `npm run test`
- **Commits**: Conventional Commits enforced via Husky.

---

## 11. Features

- **GitHub App Authentication**: JWT + Installation Token auth.
- **Secure Webhooks**: HMAC-SHA256 signature verification with delivery-ID deduplication.
- **Asynchronous Ingestion**: BullMQ + Redis queue with exponential backoff retries.
- **Distributed Locking**: Redis Redlock prevents concurrent execution anomalies per repo and branch.
- **Multi-Agent Orchestration**: LangGraph AI pipeline — Onboarding → Planner → PatchGenerator → ValidationAgent → GitAgent.
- **Dynamic Provider Configuration**: Configure LLM providers via backend `.env` or client dashboard UI with AES-256-GCM encryption.
- **Per-Agent Model Selection**: Assign custom providers and models to individual agents.
- **Sandbox Validation**: Fixes verified with `npm run build` inside isolated Docker containers.
- **Cross-Platform Sandbox**: Named Docker volume for worktrees ensures cross-platform reliability.
- **Self-Healing Loop**: Automatically retries patch generation incorporating validation feedback.
- **MCP Server (Hermes / OpenClaw)**: Exposes orchestration tools over Streamable HTTP.
- **Notifications**: Discord webhook integration for pipeline status alerts.

---

## 12. License

MIT — see [`LICENSE`](./LICENSE).

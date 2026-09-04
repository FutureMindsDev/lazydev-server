# LazyDev — Lazy Issue Resolver (self-hosted)

LazyDev is an AI-native autonomous CI engineering assistant that monitors GitHub issues, generates validated code fixes, and pushes fix branches safely.

This is the **self-hosted** build of the backend: you run the entire stack
yourself. There is no hosted/SaaS mode in this repo — multi-tenant GitHub OAuth,
the isolated MCP port, and the hosted control plane have been stripped out.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Install the LazyDev GitHub App](#2-install-the-lazydev-github-app)
3. [Environment setup](#3-environment-setup)
4. [LLM & embedding providers](#4-llm--embedding-providers)
5. [Run the full stack (Docker)](#5-run-the-full-stack-docker)
6. [Local development](#6-local-development)
7. [Webhook tunnel (ngrok / tailscale inside Docker)](#7-webhook-tunnel-ngrok--tailscale-inside-docker)
8. [MCP server (Hermes / OpenClaw / Claude Desktop)](#8-mcp-server-hermes--openclaw--claude-desktop)
9. [Observability](#9-observability)
10. [Connecting the frontend dashboard](#10-connecting-the-frontend-dashboard)
11. [Development standards](#11-development-standards)
12. [Features](#12-features)
13. [License](#13-license)

---

## 1. Prerequisites

- **Cloud server / VM**: Linux (Ubuntu/Debian recommended) for production, or macOS/Linux for local development.
- **Node.js** v20+ (only needed for local dev; Docker image bundles Node).
- **Docker & Docker Compose**.
- **GitHub App credentials** — App ID, Private Key (`.pem`), Webhook Secret. (See §2.)
- **LLM API key** — OpenAI / Google Gemini / OpenRouter / DeepSeek, **or** a running **Ollama** instance (free local fallback).
- **Discord webhook URL** (optional, for notifications).

---

## 2. Install the LazyDev GitHub App

LazyDev talks to GitHub through a GitHub App. You have two options:

### Option 1 — Use the official LazyDev app (easiest)

1. Open **<https://github.com/apps/lazydev-issue-resolver>**.
2. Click **Install**.
3. Select the account or organization to install it on.
4. Choose **Only select repositories** and pick the repos you want LazyDev to monitor.
5. Click **Install**.

You still need the app's **App ID**, **Private Key**, and **Webhook Secret** to put in `.env`:

- **App ID**: GitHub → Settings → Developer settings → GitHub Apps → *lazydev-issue-resolver* → General.
- **Private Key**: same page → **Generate a private key** (downloads a `.pem`).
- **Webhook Secret**: same page → set a strong secret string in the Webhook section.

### Option 2 — Self-host your own GitHub App

If you want full control (or the official app's install quota is full), create your own:

1. GitHub → Settings → Developer settings → **GitHub Apps** → **New GitHub App**.
2. Set **Homepage URL** to your deployment, **Webhook URL** to `https://<your-public-url>/webhooks/github`, and a **Webhook secret**.
3. Under **Repository permissions**, grant:

   | Permission | Level | Why |
   |---|---|---|
   | Metadata | Read | Mandatory for all apps. |
   | Contents | Read & write | Clone the repo and push the fix branch. |
   | Pull requests | Read & write | Open the PR. |
   | Issues | **Read & write** | Read issues; *write* is required by the MCP `implement_new_feature` tool to create its tracking issue. |

4. Subscribe to events: **Issues**, **Issue comment**, **Check run**.
5. Generate a private key (`.pem`).
6. Install the app on the repos you want monitored.

> [!IMPORTANT]
> After changing permissions, GitHub emails the installation owner an approval request. The app keeps its **old** permissions until you accept, so `implement_new_feature` will keep failing until then. It reports this explicitly rather than failing cryptically.

---

## 3. Environment setup

```bash
git clone https://github.com/FutureMindsDev/lazy-issue-resolver.git
cd lazy-issue-resolver
cp .env.example .env
```

Edit `.env`. The file is grouped into clearly labelled sections (GitHub App, LLM provider, Embedding, Serena, MCP server, Sandbox, Infrastructure) and each variable is tagged `[DOCKER]`, `[DEV]`, or `BOTH`. The minimum you must fill in:

```env
# GitHub App
GITHUB_APP_ID=
GITHUB_WEBHOOK_SECRET=
GITHUB_PRIVATE_KEY_PATH=github-private-key.pem

# LLM provider (pick one — see §4)
OPENAI_API_KEY=
LLM_MODEL=gpt-4o-mini
```

Everything else has sensible defaults for a Docker deployment.

> **Do I need the DB / Redis / server / repo-cache / sandbox configs in `.env`?**
> **No**, if you are running the full stack via `docker compose up`. The `docker-compose.yml` already sets `DB_HOST=postgres`, `REDIS_HOST=redis`, `QDRANT_URL=http://qdrant:6333`, `WORKTREE_BASE_PATH=/app/worktrees`, etc. Those variables are listed in `.env.example` §8 only so you can override them for **local development** (`npm run start:dev`) or external infra.

---

## 4. LLM & embedding providers

LazyDev auto-detects the provider from `OPENAI_BASE_URL` and routes to the right client: **direct Gemini, DeepSeek, and Anthropic go through their provider-native LangChain clients** (which handle their payload-specific requirements natively — e.g. Gemini 3 `thought_signature` round-trips), while **OpenAI, OpenRouter, Ollama, and any other OpenAI-compatible gateway** (LiteLLM, vLLM) go through `@langchain/openai`'s Chat Completions client. Pick one by setting `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `LLM_MODEL`:

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

> The old Gemini OpenAI-compat URL (`…/v1beta/openai`) still works — the suffix is ignored and the native endpoint is used. Anthropic was previously only reachable via OpenRouter; it is now supported directly.
>
> **MiniMax / interleaved-thinking models**: some models (e.g. MiniMax M2) return `<think>…</think>` reasoning blocks inside `response.content`. LazyDev strips these automatically (`stripThinkTokens` guard) before downstream text processing, so the rest of the pipeline sees only the final answer.

### Per-agent provider & model overrides (optional)

Every agent shares `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `LLM_MODEL` by default. You can override any agent to use a **different provider** (its own API key + base URL) **and/or** a different model. Each of the three fields is independent — leave any one unset and it inherits the shared default:

```env
# PlannerAgent — strong model on the shared provider (model-only override)
PLANNER_MODEL=gpt-4o

# PatchGeneratorAgent — strong model on the shared provider
PATCH_GENERATOR_MODEL=gpt-4o

# OnboardingAgent — cheap DeepSeek (full provider + model override)
ONBOARDING_MODEL=deepseek-chat
ONBOARDING_API_KEY=sk-deepseek-...
ONBOARDING_BASE_URL=https://api.deepseek.com

# ValidationAgent — cheap model on the shared provider
VALIDATION_MODEL=gpt-4o-mini

# GitAgent — no LLM, leave blank
GIT_MODEL=
```

Every agent has the same trio of variables — `<AGENT>_MODEL`, `<AGENT>_API_KEY`, `<AGENT>_BASE_URL` — for `PLANNER`, `PATCH_GENERATOR`, `VALIDATION`, `GIT`, and `ONBOARDING`. Leave any line commented / blank to fall back to the shared `LLM_MODEL` / `OPENAI_API_KEY` / `OPENAI_BASE_URL`.

### Embedding provider (RAG vector search)

`EMBEDDING_PROVIDER` selects the embedding backend (`google` | `openai` | `ollama`; auto-detected if unset). `EMBEDDING_MODEL` is the model name:

| Provider | Models |
|---|---|
| Google | `gemini-embedding-2` (default), `text-embedding-004`, `text-multilingual-embedding-002` |
| OpenAI | `text-embedding-3-small`, `text-embedding-3-large` |
| Ollama | `nomic-embed-text`, `mxbai-embed-large` |

> **Ollama on Mac/Linux:** Run Ollama on your host. The Docker container reaches it via `host.docker.internal:11434` (already set in `docker-compose.yml`).

#### Decoupled embedding credentials

By default the embedding service reuses `OPENAI_API_KEY` / `OPENAI_BASE_URL` (or `GEMINI_API_KEY` for the Google provider). If your embedding provider is **different** from your LLM provider, set the dedicated overrides:

```env
EMBEDDING_API_KEY=sk-...
EMBEDDING_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible endpoint
```

Leave both blank to keep the legacy behaviour (inherit from the LLM provider).

### Bring your own key (BYOK) via the dashboard

Instead of (or in addition to) editing `.env`, you can configure the LLM
provider from the **dashboard → Settings → LLM provider** page. The
dashboard writes an encrypted row to the `llm_config` table; the pipeline
reads it at run start and falls back to env vars when no row exists.

- Set `LLM_CONFIG_ENCRYPTION_KEY` (32-byte hex, e.g.
  `openssl rand -hex 32`) to enable at-rest encryption of stored API keys.
  If unset in dev, a deterministic dev-only key is used (never in prod).
- The dashboard shows only the **last 4 chars** of a saved key — the full
  key is write-only.
- Deleting the BYOK config reverts to env-var resolution on the next run.
- Per-agent env overrides (`PLANNER_MODEL`, etc.) still take precedence
  over the BYOK config; BYOK replaces the *shared* `OPENAI_*` / `LLM_MODEL`
  layer.

> [!TIP]
> BYOK is also how you set a provider without editing `.env` — the same
> settings UI writes a global config row. You just need to set the
> encryption key.

---

## 5. Run the full stack (Docker)

```bash
docker compose up -d --build
```

> Use `--build` the **first time** and whenever you change source code or the `Dockerfile`. For config-only changes (`.env`, `docker-compose.yml`) you can restart without rebuilding:
> ```bash
> docker compose up -d
> ```

### Docker socket & permissions

The app container requires access to `/var/run/docker.sock` so the `SandboxAgent` can spin up sibling containers for code validation.

> [!WARNING]
> Mounting `/var/run/docker.sock` gives the container full control over the host Docker daemon. This is strictly required for the `SandboxAgent`. The container runs as `root` (`user: root` in `docker-compose.yml`) to ensure socket access. Ensure your host machine is adequately secured.

### Cross-platform sandbox (Mac, Linux, Windows)

LazyDev uses a **named Docker volume** (`worktrees`) to share workspace files between the app container and sandbox sibling containers. This works identically on all platforms — no manual configuration required.

---

## 6. Local development

Run the infrastructure in Docker, but the app locally for hot-reload:

```bash
docker compose up -d postgres redis qdrant
npm install
npm run start:dev
```

For local dev, set the `[DEV]` infrastructure vars in `.env` (`DB_HOST=localhost`, `REDIS_HOST=localhost`).

---

## 7. Webhook tunnel (ngrok / tailscale inside Docker)

GitHub needs a **public URL** to deliver webhooks. If you don't have a public IP / reverse proxy, `docker-compose.yml` ships two optional tunnel services gated behind the `tunnel` profile so you don't need to install ngrok/tailscale on your host:

### Option 1 — ngrok (easiest)

1. Sign up at <https://ngrok.com> and get an authtoken.
2. Add `NGROK_AUTHTOKEN=...` to `.env`.
3. Start the tunnel profile: `docker compose --profile tunnel up -d`.
4. Check the public URL: `docker compose logs ngrok` (look for `url=https://<random>.ngrok-free.app`).
5. Set the GitHub App's Webhook URL to `https://<random>.ngrok-free.app/webhooks/github`.

### Option 2 — Tailscale Funnel (no third-party endpoint)

1. Get an auth key from <https://login.tailscale.com/admin/settings/keys>.
2. Add `TAILSCALE_AUTH_KEY=...` to `.env`.
3. Uncomment the `tailscale:` service block in `docker-compose.yml` (it is commented out by default; only ngrok is enabled in the `tunnel` profile).
4. Start with: `docker compose --profile tunnel up -d`.
5. Enable HTTPS + Funnel for the machine in the Tailscale admin UI.
6. Set the GitHub App's Webhook URL to `https://<machine>.<tailnet>.ts.net/webhooks/github`.

### Option 3 — Reverse proxy with SSL (production)

For a real domain, put a reverse proxy (Caddy / nginx / Traefik) in front and point the Webhook URL at `https://lazydev.your-domain.com/webhooks/github`.

### Option 4 — Plain IP (quick & dirty)

`http://<your-server-ip>:3200/webhooks/github` — GitHub allows plain HTTP, but payloads travel unencrypted.

---

## 8. MCP server (Hermes / OpenClaw / Claude Desktop)

LazyDev exposes itself as an **MCP server**, so any MCP-capable platform (Hermes, OpenClaw, Claude Desktop, …) can drive the pipeline from chat. Tools are discovered automatically via the MCP handshake — no per-platform integration code.

### Tools exposed

| Tool | Purpose |
|---|---|
| `trigger_issue_fix(repository, issue_number, priority?)` | Fix an existing GitHub issue. `priority: "urgent"` jumps the queue. |
| `implement_new_feature(repository, feature_description)` | Write net-new code from a prompt. Creates a tracking issue (labelled `enhancement`, `lazydev`) so the PR is traceable. |
| `get_pipeline_status(task_id)` | Check whether a run is queued, running, failed, or succeeded. |
| `provide_human_feedback(task_id, feedback)` | Send a correction. Running tasks pick it up on their next validation retry; already-failed tasks are re-run with it applied. |

The write tools return a `task_id` immediately — pipelines run asynchronously on the BullMQ queue.

### What the agent produces

| | Fix | Feature |
|---|---|---|
| Branch | `lazydev/fix-<n>-<slug>` | `lazydev/feat-<n>-<slug>` |
| Commit | `fix: resolve issue #<n>` | `feat: implement issue #<n>` |
| PR title | `Fix: <issue title>` | `<issue title>` (already reads "Feature: …") |

### Interaction with automatic issue fixing

The webhook auto-queues issues on `opened`/`reopened`, so newly created issues are already handled — `trigger_issue_fix` is mainly for **backlog issues the webhook never saw**, or for re-running something. If you point it at an issue that is already queued or running, it returns the existing `task_id` instead of starting a duplicate pipeline.

Work runs one job at a time in FIFO order; `priority: "urgent"` moves a job ahead of everything already waiting, but never interrupts a job that is already running.

### Deployment mode

The MCP surface is served on the main API port at `POST http://<host>:3200/mcp`
(shared with the REST API and GitHub webhooks). This is the only mode supported
by the self-hosted build — there is no isolated-port / SaaS mode here.

Set `MCP_SERVER_ENABLED=false` to turn the MCP surface off completely.

The server is **stateless**: every request is self-contained, so there are no sessions to manage and no sticky-routing requirement behind a load balancer. All MCP traffic uses `POST`; `GET` and `DELETE` return `405 Method Not Allowed`.

> [!WARNING]
> The endpoint shares the public API port. Set `MCP_AUTH_TOKEN` so clients must send `Authorization: Bearer <token>`; without it, anyone who can reach port 3200 can spend your AI compute.

### Client configuration

```json
{
  "mcpServers": {
    "lazydev": {
      "url": "http://your-server:3200/mcp",
      "transport": "streamable-http",
      "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
    }
  }
}
```

Verify a running server with the smoke script:

```bash
npx ts-node test/test-mcp-server.ts                       # default
MCP_AUTH_TOKEN=s3cret npx ts-node test/test-mcp-server.ts  # with auth
```

Design notes and rationale: `docs/sprint-plan/lazydev_mcp_server_plan.md`.

---

## 9. Observability

The app exposes `/metrics` (Prometheus format) via `@willsoto/nestjs-prometheus`. The `docker-compose.yml` ships Prometheus + Grafana containers, but they are **commented out by default** because they are not wired to the app out of the box (no scrape config, no provisioned datasource).

To enable:

1. Create a `prometheus.yml` with a scrape job targeting `app:3200` and mount it into the prometheus container.
2. Uncomment the `prometheus` and `grafana` service blocks in `docker-compose.yml`.
3. Add Prometheus as a Data Source in Grafana (`http://prometheus:9090`) and import standard Node.js dashboards.

| Dashboard | URL | Default login |
|---|---|---|
| NestJS API | http://localhost:3200 | — |
| pgAdmin (optional) | http://localhost:5050 | `admin@lazydev.com` / `admin` |
| RedisInsight (optional) | http://localhost:8001 | — |
| Grafana (optional) | http://localhost:3100 | `admin` / `admin` |
| Prometheus (optional) | http://localhost:9090 | — |

---

## 10. Connecting the frontend dashboard

The dashboard UI lives in a **separate repo** —
[`lazydev-frontend`](https://github.com/FutureMindsDev/lazydev-frontend) — a
Next.js app that calls this backend's `/api/dashboard/*` and `/api/auth/*`
endpoints. It ships with MSW mocks so it runs standalone, but to point it at a
real backend you flip one flag.

### Backend side

These are already the defaults in `.env.example`, but worth confirming:

```env
# Single-tenant, no auth — the only mode this build supports.
DEPLOYMENT_MODE=selfhosted
DASHBOARD_AUTH=none

# CORS: must include the origin(s) the frontend is served from.
# Browsers treat localhost and 127.0.0.1 as DIFFERENT origins, so list both
# if you access the UI via 127.0.0.1.
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000

# The URL the backend redirects to after auth flows (the frontend's URL).
FRONTEND_URL=http://localhost:3000
```

If you want a static bearer token on the dashboard API instead of open access,
set `DASHBOARD_AUTH=token` and `DASHBOARD_AUTH_TOKEN=<your-secret>` — the
frontend will need to send that token (see the frontend repo's README for
details).

Start the backend:

```bash
docker compose up -d --build      # API on http://localhost:3200
```

### Frontend side

Clone the frontend repo next to this one (or anywhere you like) and configure
it to hit the backend:

```bash
git clone https://github.com/FutureMindsDev/lazydev-frontend.git
cd lazydev-frontend
pnpm install
cp .env.example .env.local
```

Edit `.env.local`:

```env
# Point at this backend's API port.
NEXT_PUBLIC_API_URL=http://localhost:3200

# Disable MSW mocks so the UI talks to the real backend.
NEXT_PUBLIC_ENABLE_MOCKS=false
```

> `NEXT_PUBLIC_*` vars are inlined at build time — restart `pnpm dev` after
> changing `.env.local`.

Run it:

```bash
pnpm dev      # http://localhost:3000
```

Open <http://localhost:3000> — the Overview, Runs, Run Detail, Queues,
Repositories, and Settings pages now read live data from this backend.

### CORS gotchas

- If you serve the frontend from a different host/port (e.g. behind a reverse
  proxy on port 3001, or via 127.0.0.1), add that origin to `CORS_ORIGINS` on
  the backend and restart, otherwise the browser will block the requests.
- If the frontend is in Docker too, point `NEXT_PUBLIC_API_URL` at the
  host/port the browser can reach (not the Docker-internal service name),
  since `NEXT_PUBLIC_*` is evaluated client-side.

### Full API contract

See the frontend repo's [`BACKEND_API_SPEC.md`](https://github.com/FutureMindsDev/lazydev-frontend/blob/main/BACKEND_API_SPEC.md)
for the exact endpoints and DTO shapes the dashboard expects.

---

## 11. Development standards

- **Linting**: `npm run lint`
- **Formatting**: `npm run format`
- **Tests**: `npm run test`
- **Commits**: Conventional Commits enforced via Husky.

---

## 12. Features

- **GitHub App Authentication**: JWT + Installation Token auth.
- **Secure Webhooks**: HMAC-SHA256 signature verification with delivery-ID deduplication.
- **Asynchronous Ingestion**: BullMQ + Redis queue with exponential backoff retries.
- **Distributed Locking**: Redis Redlock prevents concurrent execution anomalies per repo and branch.
- **Multi-Agent Orchestration**: LangGraph AI pipeline — Onboarding → Planner (research + planning tool loop) → PatchGenerator (tool loop with read-before-edit gates) → ValidationAgent → GitAgent.
- **Per-Agent Model Selection**: Each agent can use a different LLM via `*_MODEL` env overrides.
- **LLM Logging**: Full LLM responses logged per agent for real-time pipeline observability.
- **Sandbox Validation**: Generated fixes validated by running `npm run build` inside an isolated sibling Docker container.
- **Cross-Platform Sandbox**: Named Docker volume for worktrees ensures the sandbox works on Mac, Linux, and Windows without manual configuration.
- **Self-Healing Loop**: Automatically retries patch generation with validation feedback on failure.
- **MCP Server (Hermes / OpenClaw)**: Exposes 4 orchestration tools over Streamable HTTP with optional bearer auth, so chat platforms can trigger fixes, request new features, poll status, and inject human feedback.
- **Notifications**: Discord integration for pipeline alerts.
- **Security & Stability**: Helmet, Throttler rate limiting, BullMQ retries.

---

## 13. License

MIT — see [`LICENSE`](./LICENSE).

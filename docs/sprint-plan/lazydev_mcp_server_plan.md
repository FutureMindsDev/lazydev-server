# LazyDev MCP Server Implementation Plan

> **Last Updated:** 2026-08-15
> **Status:** ✅ **Implemented & live-verified** — all 8 checkpoints complete; 88 unit + 8 e2e tests passing; both deployment modes exercised against a running docker-compose stack (see §6 "Live verification").
> **Scope:** `docs/sprint-plan/additional_features.md` §3 (OpenClaw & Hermes MCP Server Integration) and §5 (How to Build the LazyDev MCP Server), with architecture context from `docs/architecture/serena_architecture_plan.md`.

Expose `lazy-issue-resolver` as an MCP **Server** (Streamable HTTP) so OpenClaw/Hermes can trigger issue fixes, implement net-new features, poll pipeline status, and inject human feedback.

---

## 0. Current-State Findings (verified against the codebase)

| Fact | Evidence |
|---|---|
| App is NestJS + Express, listens on `PORT ?? 3000` | `src/main.ts` |
| Jobs enqueued to BullMQ queue `issue-processing` with stable, idempotent jobIds | `src/ingestion/ingestion.service.ts` |
| `IssueProcessor` (concurrency 1) builds worktree → RAG ingest → `orchestrationService.runPipeline()` | `src/ingestion/issue.processor.ts` |
| Pipeline is an in-process LangGraph; final state persisted to `AuditLog` (Postgres) | `src/orchestration/orchestration.service.ts`, `audit-log.service.ts` |
| `AgentState` already has a `validationFeedback` channel (used by the validator→patcher retry loop) | `src/orchestration/graph.state.ts` |
| MCP SDK `@modelcontextprotocol/sdk@1.29.0` already installed (includes server classes); `zod@4.4.3` present only as a **transitive** dep | `package.json`, `node_modules` |
| Existing MCP *client* pattern (Serena): `StreamableHTTPClientTransport` → `http://lazydev-serena:3333/mcp` | `src/intelligence/serena-mcp.service.ts` |
| Dashboard already reads BullMQ job counts + audit metrics | `src/dashboard/dashboard.controller.ts` |
| `NotificationsService` hardcodes Discord only | `src/notifications/notifications.service.ts` |
| Per-installation authenticated Octokit available | `src/github/github.service.ts` (`getInstallationOctokit`) |

### ⚠️ Corrections to `additional_features.md` §5 pseudocode

1. **SDK API drift** — `StreamableHTTPServerTransport` in SDK 1.x does **not** accept `{ endpoint }` and has no `handlePostMessage` / `handleSse`. The real API is `new StreamableHTTPServerTransport({ sessionIdGenerator })` plus `transport.handleRequest(req, res, req.body)`. This plan uses the verified API; §5 of `additional_features.md` will be corrected as part of CP8.
2. **Session management** — Streamable HTTP servers are either *stateless* (`sessionIdGenerator: undefined`) or *stateful* (per-session transports keyed by the `mcp-session-id` header). Our four tools are plain request/response with no server-initiated streaming, so **stateless** is the correct choice.
3. **`implement_new_feature` payload** — `IssueProcessor` requires both `issueNumber` and `installationId`; a raw description is not enough. We resolve `installationId` from the repo via the GitHub App API and create a real GitHub issue to obtain a genuine issue number.

### Reference implementations reviewed

- **`rekog-labs/MCP-Nest`** (`@rekog/mcp-nest`) — the de-facto NestJS MCP server package: decorator-based tools, stateless/stateful Streamable HTTP, mounts on the Nest HTTP adapter. Pros: guards/interceptors apply natively. Cons: extra dependency and its own microservice-strategy bootstrap.
- **Official MCP TypeScript SDK examples** (`examples/server/simpleStatelessStreamableHttp.ts`) — plain Express handler with `McpServer` + `StreamableHTTPServerTransport`; ~80 LOC, no new dependencies, and maps directly onto the hybrid port toggle in §5 Step 4.
- **GitHub's `github-mcp-server` and Sentry's MCP server** — both back long-running tools with a task queue, returning a task id plus a separate status-poll tool. This validates the `task_id` + `get_pipeline_status` design.

**Chosen approach:** raw `@modelcontextprotocol/sdk`, mirroring the existing `serena-mcp.service.ts` style.

---

## 1. Architecture

```
Hermes/OpenClaw ──MCP (Streamable HTTP, stateless)──▶ LazyDev McpServerService
      │                                                   │
      │   trigger_issue_fix / implement_new_feature       ├─▶ McpTaskService ─▶ BullMQ 'issue-processing'
      │   get_pipeline_status                             ├─▶ BullMQ Job.getState() + AuditLog fallback
      │   provide_human_feedback                          └─▶ Redis key `mcp:feedback:<task_id>`
      ▼
  task_id (= BullMQ jobId, format `mcp-<uuid>`)
```

- **Transport:** Streamable HTTP at `/mcp` (POST; `GET`/`DELETE` return 405 in stateless mode).
- **Hybrid port toggle** (§5 Step 4): no `MCP_SERVER_PORT` → served on the main API port (port 3000); `MCP_SERVER_PORT=3334` → standalone listener for network isolation, and the main-port route deliberately 404s.
- **Auth:** optional `MCP_AUTH_TOKEN` → require `Authorization: Bearer <token>`; skipped when unset (network-level security only).
- **Kill switch:** `MCP_SERVER_ENABLED=false` disables the MCP surface entirely.
- **Independence from the Serena MCP client:** a separate module; `serena-mcp.service.ts` is untouched.

### Deviations from the original design (discovered during implementation)

| Planned | Shipped | Why |
|---|---|---|
| One shared `McpServer` + transport created at bootstrap | A fresh `McpServer` + transport **per request** | SDK 1.29 throws `Stateless transport cannot be reused across requests` (message-id collisions between clients). Construction is pure object wiring, so the cost is negligible. |
| Register the route on the Express instance via `HttpAdapterHost` | A NestJS controller (`mcp.controller.ts`) | Routes added to the adapter after `app.init()` are shadowed by Nest's catch-all 404. Going through the router also means global middleware/guards/filters apply. |
| "GET/DELETE return 405 — the SDK handles it" | **We** reject non-POST with 405 before reaching the transport | Not true in stateless mode: `validateSession()` returns early, so `handleGetRequest` opens a standalone SSE stream that can never emit (no session to push to) and only closes on client disconnect. Every stray GET — browser, health check, scanner — leaked a socket plus a server/transport. Caught by live `curl`, not by unit tests. |
| Redis feedback store inside `McpTaskService` | Extracted to `HumanFeedbackModule` | `McpServerModule` imports `OrchestrationModule` (for `AuditLogService`); the graph also needs to *read* feedback, which would have created a circular module dependency. |
| Merge feedback inside the validator→patcher conditional edge | Dedicated `human_feedback` graph node on the retry path | LangGraph conditional edges select the next node but cannot return state updates. |

## 2. Files

```
src/mcp-server/
├── mcp-server.module.ts          # BullModule(issue-processing), GithubModule, OrchestrationModule, HumanFeedbackModule
├── mcp-server.service.ts         # per-request MCP server/transport, hybrid port toggle, bearer auth
├── mcp.controller.ts             # @All('mcp') — serves MCP on the main API port (Option A)
├── mcp.constants.ts              # MCP_ENDPOINT, MCP_ISSUE_MARKER (no module deps — safe for webhooks to import)
├── mcp-task.service.ts           # task_id generation, enqueue, status lookup, re-queue
└── tools/
    ├── tool-utils.ts             # repo parsing, prompt-injection sanitization, result envelopes
    ├── trigger-issue-fix.tool.ts
    ├── implement-feature.tool.ts
    ├── get-pipeline-status.tool.ts
    └── provide-feedback.tool.ts

src/feedback/
├── human-feedback.module.ts      # neutral module — writer (MCP) and reader (graph) both depend on it
└── human-feedback.service.ts     # Redis store: store / read / consume, 24h TTL

Tests
├── src/mcp-server/mcp-server.service.spec.ts   # transport, port modes, auth (10)
├── src/mcp-server/mcp-task.service.spec.ts     # enqueue / status / re-queue (15)
├── src/mcp-server/tools/tools.spec.ts          # all 4 tools via a real in-memory MCP client (26)
├── src/mcp-server/tools/tool-utils.spec.ts     # repo parsing + injection guard (25)
├── src/orchestration/orchestration.service.spec.ts  # feedback through the compiled graph (5)
├── test/mcp-server.e2e-spec.ts                 # real MCP client over HTTP (8)
└── test/test-mcp-server.ts                     # manual smoke script against a running stack
```

## 3. Tool Contracts (zod schemas)

| Tool | Input | Behavior | Output |
|---|---|---|---|
| `trigger_issue_fix` | `repository: string` (`"owner/repo"`), `issue_number: number`, `priority?: 'normal' \| 'urgent'` | Validate repo format; **return any in-flight task for the same issue instead of duplicating it**; resolve `installationId`; fetch issue title/body; enqueue `process-issue` with jobId `mcp-<uuid>`, `kind: 'fix'`, and BullMQ `priority: 1` when urgent | `{ task_id, message }` |
| `implement_new_feature` | `repository: string`, `feature_description: string` | Sanitize the description (prompt-injection guard per §2 of `additional_features.md`); **create a real GitHub issue** labelled `enhancement`+`lazydev` (`title: "Feature: <first line>"`, body = description + `<!-- lazydev:mcp -->` marker; retries unlabelled on 422); enqueue with the real issue number and `kind: 'feature'` | `{ task_id, issue_url, message }` |
| `get_pipeline_status` | `task_id: string` | `queue.getJob(task_id)` → `getState()` (`waiting`/`active`/`completed`/`failed`) plus `failedReason`/progress; fall back to `AuditLog` for evicted jobs | status text |
| `provide_human_feedback` | `task_id: string`, `feedback: string` | Store at `mcp:feedback:<task_id>` in Redis (24 h TTL) for the validator→patcher retry loop to merge into `validationFeedback`. If the task has already **failed**, re-enqueue it with the feedback appended to the issue body and return the new `task_id` | ack text (or new `task_id` on re-queue) |

All tool handlers convert errors into MCP `isError: true` text results — they never throw raw.

## 4. Pipeline Touch Points (as shipped)

1. **`src/ingestion/issue.processor.ts`** — passes BullMQ `job.id` into `runPipeline(payload)` as `taskId` so feedback lookups can correlate.
2. **`src/orchestration/graph.state.ts`** — unchanged; feedback is folded into the existing `validationFeedback` channel.
3. **`src/orchestration/orchestration.service.ts`** — new `human_feedback` node on the retry path (`validator → human_feedback → patcher`) that consumes `mcp:feedback:<taskId>` and appends it to `validationFeedback`. Store errors are logged and swallowed so the retry loop never stalls.
4. **`src/orchestration/audit-log.service.ts`** + **`entities/audit-log.entity.ts`** — nullable `taskId` column and `findByTaskId()`, powering status lookups after the BullMQ job is evicted.
5. **`src/github/github.service.ts`** — new `getRepoInstallationId(owner, repo)`; MCP tools receive only `"owner/repo"` and have no webhook payload to read `installation.id` from.
6. **`src/app.module.ts`** — registers `McpServerModule`.
7. **`src/webhooks/webhooks.service.ts`** — skips `issues.opened` events whose body contains `<!-- lazydev:mcp -->`, since `implement_new_feature` already enqueued that job.
8. **`src/main.ts`** — unchanged (the controller handles routing).
9. ~~Notifications decoupling~~ — **deferred** to a follow-up task (see Decisions §8.5).

## 5. Config & Deployment

- **`.env.example`**: add `MCP_SERVER_PORT=` and `MCP_AUTH_TOKEN=` (both commented out by default).
- **`docker-compose.yml`**: commented-out `3334:3334` port mapping and `MCP_SERVER_PORT` env var, per §5 Step 6.
- **`package.json`**: promote `zod` to a direct dependency (currently transitive only). No other new dependencies.
- **`README.md`**: document the Hermes/OpenClaw client config snippet.

## 6. Implementation Checkpoints

All checkpoints complete. Verification commands:

```bash
npm run build                                     # ✅ clean
npx jest                                          # ✅ 86 passed, 9 suites
npx jest --config ./test/jest-e2e.json test/mcp-server.e2e-spec.ts   # ✅ 8 passed
npx eslint src/mcp-server src/feedback            # ✅ clean
```

- [x] **CP1 — Scaffolding & module wiring**
  - `zod` promoted to a direct dependency (`^4.4.3`, already resolved in the tree — no new code pulled in); `mcp-server.module.ts` created and registered in `AppModule`.
  - ✅ `npm run build` clean; module resolves under `Test.createTestingModule`.
- [x] **CP2 — MCP server core + hybrid transport** — 10 tests
  - Per-request `McpServer` + stateless `StreamableHTTPServerTransport`, hybrid port toggle, optional bearer auth, `MCP_SERVER_ENABLED` kill switch.
  - ✅ `initialize` handshake returns `lazydev-agent`; `tools/list` returns all 4 tools; 401 on missing/wrong/malformed token; Option B serves on its own (free, dynamically allocated) port **and** 404s on the main port; disabled mode serves nothing.
- [x] **CP3 — `McpTaskService`** — 15 tests
  - `mcp-<uuid>` task ids used as BullMQ job ids, 24h retention, status via `getJob` + `getState`, AuditLog fallback, re-queue with feedback.
  - ✅ Covers all five queue states, failure reasons, audit-log fallback (SUCCESS→completed, FAILED→failed), unknown ids, and expired-job re-queue returning `null`.
- [x] **CP4 — `trigger_issue_fix` + `implement_new_feature`** — part of 26 tool tests
  - ✅ Happy paths; malformed repo rejected before any GitHub call; app-not-installed and missing `Issues: write` produce actionable messages; pull requests refused; injection strings in issue bodies redacted; title derivation and truncation.
- [x] **CP5 — `get_pipeline_status` + `provide_human_feedback`** — part of 26 tool tests
  - ✅ Plain-language status for every state; failure reason surfaced with a nudge toward `provide_human_feedback`; failed tasks re-queued with a new `task_id`; completed/unknown tasks handled gracefully; feedback text sanitized.
- [x] **CP6 — Pipeline feedback integration** — 5 tests
  - `taskId` threaded `IssueProcessor` → `runPipeline`; `human_feedback` node consumes Redis feedback on the retry path.
  - ✅ Feedback reaches the patcher on retry **and preserves** the automated validation output; no-op without feedback or without a `taskId`; a failing feedback store does not stall the loop; nothing is consumed when validation passes first time.
- [x] **CP7 — End-to-end test + smoke script** — 8 tests
  - ✅ Real `Client` + `StreamableHTTPClientTransport` over HTTP: handshake, tool discovery with schemas, all 4 tool calls, tool errors returned as `isError` results (not transport failures), and two concurrent independent clients.
  - `test/test-mcp-server.ts` added for manual verification against a running stack.
- [x] **CP8 — Config, docs, compose**
  - `.env.example` (`MCP_SERVER_ENABLED`, `MCP_SERVER_PORT`, `MCP_AUTH_TOKEN`), `docker-compose.yml` (commented `3334:3334` + env), README "Connecting Hermes / OpenClaw", and corrections noted in `additional_features.md` §5.
  - ✅ `npm run build && npx eslint` clean.

### Live verification (2026-08-16, against docker-compose Postgres + Redis + Qdrant)

- [x] **App boots** — `MCP Server served on the main API port at /mcp`, `Mapped {/mcp, ALL} route`, `HumanFeedbackModule dependencies initialized`, no DI cycles.
- [x] **Option A** — `POST /mcp` `initialize` → 200 `lazydev-agent`; `tools/list` → all 4 tools with full schemas; `GET /` and `/api/dashboard/metrics` unaffected.
- [x] **Option B** (`MCP_SERVER_PORT=3334`, `MCP_AUTH_TOKEN` set) — 200 on `:3334/mcp` with the correct token; **401** without a token and with a wrong token; **404** on the main API port (isolation holds); main API still serves normally.
- [x] **405 regression fix** — `GET`/`DELETE /mcp` now return 405 + `Allow: POST` in ~5 ms (previously hung indefinitely).
- [x] **Smoke script** — passes against both Option A and Option B (+auth); fails cleanly with `Unauthorized` when the token is omitted.
- [x] **Schema migration** — TypeORM `synchronize` added `audit_logs.taskId` as a nullable `character varying`; existing rows unaffected, no manual migration required.
- [x] **Real infrastructure paths** — `get_pipeline_status` on an unknown id exercised the live BullMQ lookup *and* the Postgres audit-log fallback, returning the graceful "unknown task_id" message.

> [!NOTE]
> Serena MCP and Ollama were not running during verification; both failed gracefully and non-fatally (`ENOTFOUND lazydev-serena`, embedding smoke-test warning) without affecting the MCP server.

> [!NOTE]
> **Default API port changed 3000 → 3200.** The Hermes WhatsApp bridge (`~/.hermes/hermes-agent/scripts/whatsapp-bridge/bridge.js --port 3000`) listens on `127.0.0.1:3000`, and Hermes users are exactly this project's audience, so the collision would have been common. Changed in `src/main.ts`, `.env`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `README.md` and the smoke script default. `PORT` still overrides. Historical sprint records (`test/sprint-1.md`, `test/sprint-2.md`) intentionally left as-is.

### Still untested

- A real end-to-end pipeline run triggered through MCP (`TRIGGER_REPO=… TRIGGER_ISSUE=… npx ts-node test/test-mcp-server.ts`) — needs a repo with the GitHub App installed and consumes LLM tokens.
- `implement_new_feature` against a live repo — will create a real GitHub issue and requires the `Issues: write` permission.
- Human feedback applied to a genuinely stalled pipeline (the graph path is unit-tested, but not observed against a live LLM run).

## 6b. Post-review follow-ups (2026-08-17)

Raised by the user after the first implementation landed; all three implemented with tests.

- [x] **Duplicate-run guard.** Asking the agent to fix an issue the `issues.opened` webhook had already queued started a **second** full pipeline run: the two jobs carry different job ids so BullMQ cannot dedupe, and the issue lock only prevents *concurrent* runs (the worker is single-concurrency, so the duplicate simply ran afterwards) — burning tokens and force-pushing over the first run's branch. `trigger_issue_fix` now returns the in-flight `task_id` instead.
- [x] **Fix-vs-feature naming.** Reusing the fix pipeline for features produced branch `lazydev/fix-501-feature-…`, commit `fix: resolve issue #501` (**violating the repo's commitlint conventional-commit rule** — a feature must be `feat:`) and PR title `Fix: Feature: …`. Introduced `WorkKind` (`src/common/work-kind.ts`), threaded it through the job payload into `GitAgent`, and renamed `buildFixBranchName` → `buildBranchName(issueNumber, title, kind)` which also strips a leading `Feature:`/`Fix:` from the slug.
- [x] **Issue labels + queue priority.** Feature issues are labelled `enhancement` + `lazydev` (falling back to unlabelled on 422). `trigger_issue_fix` accepts `priority: 'urgent'` → BullMQ `priority: 1`, reordering the queue without interrupting a running job.

## 7. Risks & Considerations

- **In-process pipeline vs. feedback** — LangGraph runs synchronously inside the worker, so injected feedback can only influence *future* graph steps (validator retries) or a re-queued run. True "resume a stalled pipeline" requires LangGraph checkpointing (out of scope; roadmap item).
- **Job eviction** — `removeOnComplete: { age: 3600 }` means status for older tasks must fall back to `AuditLog`. `AuditLog` has no task id today, so we add a nullable `taskId` column (non-breaking under `synchronize: true`).
- **Worker concurrency of 1** — MCP-triggered jobs queue behind webhook jobs, so the status tool will legitimately report `waiting` for a while. Document this behavior.
- **Security** — in Option A the endpoint shares the public API port, so setting `MCP_AUTH_TOKEN` is strongly recommended even there. All free text (`feature_description`, feedback, issue bodies) passes through `sanitizeUserText()`, which redacts role markers, special-token delimiters and jailbreak phrasings before it reaches an LLM prompt. This is defence in depth, not a guarantee — the agent's ephemeral worktree and restricted file scope remain the real boundary.
- **GitHub App permissions** — creating issues requires `issues: write`; a 403/404 is translated into an explicit "needs the Issues: write permission" message rather than a raw API error.
- **`taskId` on re-queue** — `provide_human_feedback` on a failed task creates a *new* `task_id`. Clients must poll the returned id, not the original.

## 8. Decisions (confirmed 2026-08-13)

1. **Framework:** raw `@modelcontextprotocol/sdk` (only new direct dependency: `zod`).
2. **Auth:** optional `MCP_AUTH_TOKEN` bearer auth; open when unset.
3. **`implement_new_feature`:** creates a real GitHub issue via the GitHub App so the resulting PR is traceable.
4. **`provide_human_feedback`:** retry-loop injection **plus** re-queue of already-failed tasks with the feedback appended.
5. **Notifications decoupling** (Discord / OpenClaw / Hermes fan-out): deferred to a follow-up task.

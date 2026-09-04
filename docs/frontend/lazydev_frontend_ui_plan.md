# LazyDev Frontend — Detailed UI Plan

> Status: Proposal / Planning
> Scope: A web dashboard (control plane UI) for the Lazy Issue Resolver NestJS backend.
> Backend of record: `src/` at the time of writing (NestJS 11, BullMQ, TypeORM/Postgres, Redis, LangGraph orchestration, Prometheus/Grafana via docker-compose).

---

## 1. What the backend already exposes (constraints on the UI)

The frontend must be designed around what exists today and what is cheap to add:

| Capability | Where it lives | Notes |
| --- | --- | --- |
| Queue metrics (`GET /api/dashboard/metrics`) | `src/dashboard/dashboard.controller.ts` | Returns BullMQ `issue-processing` job counts + audit-log totals (`total/success/failed`) + status/timestamp. **The only real dashboard endpoint today.** |
| GitHub webhook ingestion | `POST /webhooks/github` (`src/webhooks/webhooks.controller.ts`) | Issues land here → enqueued to BullMQ. No manual "trigger fix" API yet — the UI needs one. |
| Audit log entity | `src/orchestration/entities/audit-log.entity.ts` | Per-run record: `taskId`, `issueNumber`, `issueTitle`, `status` (SUCCESS/FAILED), `validationAttempts`, `finalValidationFeedback`, `generatedPatch`, `createdAt`. Perfect feed for a run history table + run detail view. |
| Multi-agent pipeline | `src/orchestration/orchestration.service.ts` (LangGraph) | Nodes: `onboarding → analyzer → researcher → planner → patcher → validator → git`. State shape in `graph.state.ts`: `researchContext`, `implementationPlan`, `generatedPatch`, `unappliedChanges`, `validationFeedback`, `isValid`, `validationAttempts`. |
| Human-in-the-loop feedback | `src/feedback/human-feedback.service.ts` | Redis key `mcp:feedback:<taskId>` with 24h TTL; consumed once by the graph mid-run. Currently written only via the MCP tool `provide_human_feedback`. **The UI's biggest opportunity: a first-class "send feedback" surface.** |
| MCP server | `src/mcp-server/mcp.controller.ts` | Exposes tools incl. feedback; alternative transport for agent control. |
| Observability | Prometheus + Grafana in `docker-compose.yml` | Deep metrics stay in Grafana; the app dashboard should link out, not duplicate. |

**Gaps the plan assumes we will add to the backend** (small, incremental):

1. `GET /api/dashboard/runs?limit&offset&status` — paginated audit-log listing.
2. `GET /api/dashboard/runs/:taskId` — single run with full patch + feedback.
3. `POST /api/dashboard/runs/:taskId/feedback` — writes through `HumanFeedbackService.store()` (same Redis contract as the MCP tool).
4. `POST /api/dashboard/repos/:repo/issues/:number/retry` — re-enqueue a failed issue.
5. `GET /api/dashboard/events` (SSE) or WebSocket — live pipeline stage updates per task.
6. `GET/BulkQueue job detail` — expose BullMQ `Job.getState()`, attempts, failedReason per taskId.

---

## 2. Product goal & personas

LazyDev autonomously fixes GitHub issues. The frontend answers three questions:

1. **"Is it working right now?"** — operator/health view.
2. **"What did it do and why?"** — transparency/audit view (the AI pipeline is a black box otherwise).
3. **"Can I steer it?"** — human-in-the-loop: give feedback on a stuck/failed run, retry, inspect patches before merging the PR.

Personas:
- **Maintainer/dev**: reviews generated patches, sends corrective feedback, retries failures.
- **Operator/SRE**: watches queue depth, success rate, sandbox validation health.

### 2.1 Deployment models (drives everything below)

LazyDev ships in **two distribution modes**, and the UI must serve both from one codebase:

|  | **Mode A — Self-hosted** | **Mode B — Hosted (SaaS)** |
| --- | --- | --- |
| Who runs the backend | The user, inside their own Docker (`docker compose up`) | Us — one central app container + shared infra |
| Who uses the frontend | Same person who owns the server (full trust) | External users who only installed the LazyDev **GitHub App** |
| Trust level | Full access: queues, settings, retry, drain | Limited: see only your own installations' runs, submit feedback; no queue or infra access |
| Auth | Optional (behind VPN/reverse proxy) or simple token | Mandatory GitHub OAuth — identity = GitHub login → installations |
| Multi-tenancy | None (single tenant) | Required — every query scoped by `installation_id` |
| Observability link | Grafana link shown | Hidden entirely (shared infra metrics are not user-facing) |

Design rule: **build for Mode B constraints, relax for Mode A.** If every data fetch is already scoped by installation and every mutation is permission-checked, self-hosted mode is just "the same app with an admin flag turned on." The reverse (building trusted-first, then bolting on tenancy) is how leaks happen.

---

## 3. Information architecture

```
App Shell (sidebar nav)
├── Overview            "/"            — health, KPIs, queue, recent runs
├── Runs                "/runs"        — paginated audit-log table w/ filters
│   └── Run Detail      "/runs/:taskId" — pipeline timeline, patch diff, feedback box
├── Queues              "/queues"      — BullMQ inspector (waiting/active/completed/failed)  [Mode A only]
├── Repositories        "/repos"       — onboarded repos, cache/onboarding status   [phase 2]
├── Settings            "/settings"    — env-driven config display, LLM provider status [Mode A only]
└── Observability ↗                    — external link to Grafana (:3030) / Prometheus (:9090)  [Mode A only]
```

---

## 4. Screens — detailed spec

### 4.1 Overview (`/`)
Purpose: 10-second answer to "is LazyDev healthy?"

Layout (top → bottom):
1. **Status strip** — big pill from `/metrics` `status` field + last-updated timestamp + auto-refresh indicator.
2. **KPI cards** (row of 4):
- Success rate (`success / total`) with mini sparkline.
- Total runs resolved (all-time).
- Failed runs (with delta vs. last 24h).
- Queue depth (`waiting + active` from BullMQ counts), color-coded: green < 5, amber < 20, red ≥ 20.
1. **Pipeline throughput chart** — stacked bar chart of SUCCESS vs FAILED per day (last 14 days).
2. **Recent runs table** — last 10 runs (issue #, title, status badge, validation attempts, time). Row click → run detail. "View all →".
3. **Queue snapshot** — horizontal segmented bar: waiting / active / completed / failed / delayed / paused counts.

### 4.2 Runs list (`/runs`)
Server-paginated table over audit logs:
- **Columns**: Status badge (SUCCESS green / FAILED red) · Issue (#n + title, links to github.com issue) · Validation attempts (e.g. `3/5`, red if maxed) · Has patch (icon) · Created (relative time) · Actions (Retry on FAILED).
- **Filters**: status (all/success/failed), search by issue number/title, date range.
- **Row expansion or click-through** to `/runs/:taskId`.
- Empty state: illustration + "No runs yet — install the GitHub App webhook or trigger a test issue."

### 4.3 Run Detail (`/runs/:taskId`) — the flagship screen

This is where the black box becomes glass. Sections top→bottom:

1. **Header card** — issue title + number (external GitHub link), repo, final status badge, created time, taskId (copyable), validation attempts counter.
2. **Pipeline timeline** (visual core) — vertical stepper mirroring the LangGraph nodes:

```
   ● Onboarding ── ● Analyzer ── ● Researcher ── ● Planner ── ● Patcher ── ● Validator ── ○ Git/PR
                                    └─ loop back to Patcher when isValid === false (attempt n/N shown on edge)
```

Each node is expandable to show its output slice of `AgentState`:
- Analyzer → triage summary
- Researcher → `researchContext` (rendered markdown, collapsible, shows retrieval sources if available)
- Planner → `implementationPlan` markdown checklist
- Patcher → file list + diff preview (jump to full diff below)
- Validator → `validationFeedback` rendered as terminal-style log; pass/fail chip per attempt
- Git → branch name + PR link (or `unappliedChanges` warning banner if set)

*Phase 1 note:* without live SSE this timeline renders from final state + audit fields (attempts count, feedback text). Phase 2 adds per-node events via SSE so stages animate live while a run is active.
1. **Patch viewer** — `generatedPatch` rendered as unified diff with syntax highlighting, copy button, "Open PR ↗" when available. Warning banner if `unappliedChanges` non-empty ("Some hunks could not be applied — review before merging").
2. **Human Feedback panel** (HITL) — textarea + submit → `POST /api/dashboard/runs/:taskId/feedback`. UX rules:
- Show hint: "Feedback is consumed once by the running pipeline within 24h."
- Disabled with explanation if run already SUCCESS (terminal) — but allow anyway if queued for retry.
- After submit: optimistic toast + "pending consumption" indicator (poll until consumed, phase 2).
- Suggested quick-feedback chips: "Wrong file targeted", "Tests are failing due to flaky setup", "Scope too large — only fix point 2", plus free text.
1. **Failure forensics** (FAILED runs) — final validation feedback in a red-tinted log panel + Retry button.

### 4.4 Queues (`/queues`) — Mode A (self-hosted) only
BullMQ inspector-lite:
- Counts grid per queue (`issue-processing` initially) using `getJobCounts()`.
- Job list tabs: Active / Waiting / Delayed / Failed / Completed — each row: jobId, name, attempts, state duration; Failed rows show `failedReason` and stack trace snippet.
- Actions: Retry job, Drain failed (confirm dialog). *(requires small backend proxy endpoints around BullMQ)*
- Note in-page: deep metrics live in Grafana (link).

### 4.5 Repositories (phase 2)
Cards per installed repo: owner/name, default branch, onboarding status (from OnboardingAgent / repository-cache entity: indexed files count, last sync), toggle "auto-fix issues", button "Re-sync index". Links into Qdrant collection stats if exposed. In **Mode B** this doubles as the "manage installations" page — repos discovered via the GitHub App installation, with an "Add repository ↗" deep link to GitHub's installation settings.

### 4.6 Settings (phase 2) — Mode A only
Read-only rendering of safe config: LLM provider in use (OpenAI vs Ollama fallback logic), model names, sandbox network mode, Discord notifications enabled. Explicitly **never** render secrets — show masked placeholders. In Mode B this page is hidden entirely; users configure nothing on our infra.

### 4.7 Global elements
- **Top bar**: global search (issue # / taskId, ⌘K), theme toggle, link icons (GitHub repo, Grafana — Mode A only).
- **Auth**: mode-dependent.
- *Mode A*: optional bearer token / basic gate; often just behind a reverse proxy on the user's own machine.
- *Mode B*: **mandatory GitHub OAuth ("Sign in with GitHub")** at `/login`. After login, fetch the user's LazyDev App installations (`GET /user/installations` via the app token exchange) and scope every subsequent request to those installation IDs. A user with zero installations sees an onboarding screen with a one-click "Install LazyDev" deep link to the GitHub App manifest/public-install URL. Session = httpOnly cookie (or short-lived JWT); no PATs collected from users, ever.
- **Toasts** for all mutations.
- **Error boundary** page with retry.

---

## 5. Key workflows the UI must support end-to-end

1. **Passive monitoring loop**
Overview loads → polls `/metrics` every 15s (or subscribes SSE later) → user spots failed spike → clicks into Runs filtered by FAILED → opens run → reads forensics.
1. **Steering a stuck run (HITL)**
Run Detail → sees validator looping (attempt 3/5) → types/chips feedback → POST → pipeline consumes it on next validator cycle → timeline shows recovery → SUCCESS. If still fails → Retry re-enqueues.
1. **Patch review**
Run Detail → expand planner notes → read diff → open PR on GitHub → merge externally. UI stays read-only about git; it never merges.
1. **Queue ops**
Queues tab → failed job with webhook parse error → inspect reason → retry after fixing config.

---

## 6. Architecture & tech choices

### Recommendation: Next.js 14+ (App Router) + TypeScript + Tailwind CSS + shadcn/ui, served separately, calling the NestJS API over HTTP.

Rationale:
- The team already ships Next.js/Tailwind projects (my-portfolio-2026, khinmemelatt-portfolio); zero new paradigm cost.
- shadcn/ui gives accessible primitives (dialogs, toasts, tables, command palette) without heavy lock-in.
- The NestJS app stays a pure API — no server-side templating, no coupling of build pipelines.

Alternative considered and rejected:
- **Serving React from NestJS (**`ServeStaticModule`**)** — fine for deployment simplicity (single container), viable as an optimization later: build the Next.js app statically (`output: 'export'`) and mount `dist/` via ServeStaticModule. Keep this as a deployment option, not an architecture decision.
- **Grafana-only** — great metrics, wrong tool for per-run drill-down, diffs, and HITL feedback forms.

### Stack details

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | Next.js (App Router, static export capable) | Familiarity; SSR unnecessary — this is an authenticated internal tool, client components + SWR suffice |
| Data fetching | SWR (polling, revalidate-on-focus) | Built-in polling for `/metrics`; trivially swappable to SSE later |
| UI kit | Tailwind v4 + shadcn/ui + lucide-react | Consistent, fast to build, dark-mode-first (fits dev-tool audience) |
| Diff rendering | `react-diff-view` + `refractor` (or `react-syntax-highlighter`) | Proper unified/split diff with hunk headers for `generatedPatch` |
| Charts | Recharts | Sparklines, stacked bars; light enough for dashboards |
| Tables | TanStack Table | Sorting/filtering/pagination over run lists |
| Forms | react-hook-form + zod (zod already a backend dep — shared schemas possible) | Feedback form validation |
| Live updates (phase 2) | Native SSE via `EventSource` | One-way server push fits pipeline events; simpler than ws; Nest `@Sse()` supported |

### Project layout (new `frontend/` dir inside monorepo)

```
frontend/
├── package.json            # separate pnpm workspace or standalone
├── src/
│   ├── app/
│   │   ├── layout.tsx      # shell: sidebar + topbar
│   │   ├── page.tsx        # Overview
│   │   ├── runs/page.tsx
│   │   ├── runs/[taskId]/page.tsx
│   │   ├── queues/page.tsx
│   │   └── settings/page.tsx        (phase 2)
│   ├── components/
│   │   ├── ui/             # shadcn primitives
│   │   ├── kpi-card.tsx
│   │   ├── status-badge.tsx
│   │   ├── pipeline-timeline.tsx     # node stepper + expandable outputs
│   │   ├── patch-viewer.tsx
│   │   ├── feedback-panel.tsx
│   │   └── runs-table.tsx
│   ├── lib/
│   │   ├── api.ts          # typed fetch client, base URL from NEXT_PUBLIC_API_URL
│   │   └── types.ts        # mirrors backend DTOs (see §7)
│   └── hooks/
│       ├── use-metrics.ts  # SWR poll 15s
│       ├── use-runs.ts
│       └── use-run-detail.ts
```

### Backend additions required (NestJS side, \~small)

New `DashboardController` routes (extend existing controller/module). **Every route takes a tenancy context** (see below):
- `GET api/dashboard/runs?installationId&repo&limit&offset&status` / `runs/:taskId` (query `AuditLogRepository`; add `LIMIT/OFFSET`, filter params).
- `POST api/dashboard/runs/:taskId/feedback` → `humanFeedbackService.store(taskId, text)`; validate body with zod pipe; apply `@Throttle` (throttler module already present). In Mode B, rate-limit per user, not just globally.
- `GET api/dashboard/queues/:name/jobs?state=` and `POST .../jobs/:id/retry` — thin proxies over BullMQ Queue API. **Guarded: reject unless Mode A (or caller is admin).**
- Phase 2: `GET api/dashboard/events?taskId=` SSE stream emitting `{node, status, payload}` as agents complete — orchestration service publishes via Redis pub/sub; dashboard module subscribes.

**Tenancy plumbing (required for Mode B):**
1. The webhook service must stamp the GitHub App `installation_id` (and repo full-name) onto each BullMQ job, and the audit log needs an `installationId` column — this is *the* join key between "who is allowed to see this" and "what happened." Verify/fix this before any frontend work.
2. Auth middleware resolves session → user → installation ID list; every runs/metrics/feedback query adds `WHERE installation_id IN (...)`. No exceptions, including the Overview KPIs (they become *my* success rate, not the server's).
3. Mode detection via env (`DEPLOYMENT_MODE=selfhosted|hosted`) toggles route guards and which nav items the frontend renders (frontend learns its mode from a `/api/dashboard/meta` endpoint rather than a build-time flag, so one static build serves both).

CORS: enable for the frontend origin in dev, or proxy through Next rewrites to avoid CORS entirely.

### Deployment (per distribution mode)

- **Mode A — self-hosted**: everything inside the user's Docker.
- Dev: `pnpm dev` in `frontend/` proxying to `localhost:3200`.
- Prod option A: standalone frontend container added to `docker-compose.yml` behind the same reverse proxy (`/` → frontend, `/api` + `/webhooks` → Nest).
- Prod option B (single image): `next build && next export` → copy `out/` into the Nest image, serve via `@nestjs/serve-static`. Zero extra containers.
- **Mode B — hosted**: we run one central stack; users never touch Docker.
- Same `docker-compose.yml` on our server, scaled appropriately (Postgres/Redis/Qdrant shared across all tenants).
- Frontend served from the same origin as the API (`/` → static frontend, `/api` → Nest) to keep OAuth cookie handling same-origin-simple.
- Users onboard purely via the **GitHub App installation flow** — no accounts to provision; identity comes entirely from GitHub OAuth at first login.
- Capacity note for this mode: LLM cost and sandbox concurrency are now ours. The Queues page becomes an **admin-only internal tool** (same UI, guarded route) rather than a user-facing page.
- One codebase, two artifacts: identical frontend build in both modes; behavior differs only via `/api/dashboard/meta`.

---

## 7. Data contracts (TypeScript types the UI expects)

```ts
type RunStatus = 'SUCCESS' | 'FAILED';

interface DashboardMetrics {           // exists today
  queues: Record<string, Record<string, number>>; // BullMQ getJobCounts()
  auditLogs: { total: number; success: number; failed: number };
  status: string;
  timestamp: string;
}

interface AuditLogDto {                // maps audit_logs entity (adds installationId for Mode B tenancy)
  id: string;
  taskId: string;
  issueNumber: number;
  issueTitle: string;
  status: RunStatus;
  validationAttempts: number;
  finalValidationFeedback: string | null;
  generatedPatch: string | null;
  createdAt: string;
}

interface DashboardMeta {              // GET /api/dashboard/meta — tells the UI which mode it's in
  deploymentMode: 'selfhosted' | 'hosted';
  auth: 'none' | 'token' | 'github-oauth';
  currentUser?: { login: string; avatarUrl: string; installations: number[] };
}

interface Paginated<T> { items: T[]; total: number; limit: number; offset: number }

interface FeedbackRequest { feedback: string }   // POST runs/:taskId/feedback

// phase 2 — SSE event
interface PipelineEvent {
  taskId: string;
  node: 'onboarding'|'analyzer'|'researcher'|'planner'|'patcher'|'validator'|'git';
  status: 'started'|'completed'|'failed';
  payload?: string;   // trimmed AgentState slice (markdown/plain text)
}
```

---

## 8. Visual design direction

- **Dark-mode-first** developer console aesthetic (like Vercel/Linear dashboards); light mode supported.
- Status language consistent everywhere: SUCCESS = emerald, FAILED = red, ACTIVE/RUNNING = blue pulse, WAITING = slate, RETRY = amber.
- Monospace for all machine output: diffs, validation logs, taskIds, branch names.
- Pipeline timeline uses connected nodes with animated progress ring on the active stage; loop-back edge (validator→patcher) drawn as dashed arc labeled `attempt n`.
- Density: tables compact (32px rows); generous whitespace on Run Detail reading surfaces.
- Accessibility: keyboard nav on tables (j/k), focus-visible rings, ⌘K palette for jump-to-taskId.

---

## 9. Build phases

**Phase 0 — Tenancy groundwork (prerequisite for Mode B, \~few days)**
Verify/patch webhook → job stamping of `installation_id`; add `installationId` column to audit logs; `DEPLOYMENT_MODE` env + `/api/dashboard/meta` endpoint; GitHub OAuth session flow. *Do this before any UI, or Mode B retrofits become migrations on live user data.*

**Phase 1 — Read-only observability (core value, \~1 week)**
Overview + Runs list + Run Detail (timeline from audit data, patch viewer). All queries already installation-scoped per Phase 0. Queues read-only in Mode A. Polling via SWR.

**Phase 2 — Act on runs (\~1 week)**
HITL feedback panel (backend store endpoint), Retry run/job actions (Mode A / admin), queue job management (Mode A), settings page (Mode A), repositories/installations page (both modes — the Mode B "manage my repos" surface).

**Phase 3 — Live pipeline (polish)**
SSE per-task events, animated live timeline during active runs, indexing management, Grafana embedding for Mode A only.

---

## 10. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| `generatedPatch` can be huge | Virtualized/truncated diff viewer with "load full" |
| TaskId ↔ BullMQ job linkage may be loose | Ensure webhook service stamps `taskId` onto job; document invariant |
| **`installation_id` missing from jobs/audit logs** (breaks all Mode B isolation) | Phase 0 verification task; block hosted launch until every row is attributable to an installation |
| **Cross-tenant data leak via unscoped query** | Single shared query-builder scope keyed off auth middleware; integration test asserting user B cannot fetch user A's taskId |
| Feedback consumed invisibly | Add `GET runs/:taskId/feedback-status` or include "feedback pending" flag in run DTO |
| Hosted mode cost blow-up (LLM + sandbox per tenant) | Per-installation rate limits; queue concurrency caps; admin Queues view for monitoring abuse |
| Dashboard exposed publicly (Mode A) | Auth gate + reverse proxy; never render secrets on Settings |
| Metrics endpoint drift | Shared zod schema package later; hand-mirrored types with runtime guard for now |

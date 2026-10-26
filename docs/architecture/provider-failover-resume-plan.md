# Provider Failover with Resume (Job-Level) — Implementation Plan

> **Status:** PLANNED — not implemented. This document is the design brief for a
> future change. Do not assume any of it exists today.
>
> **Last updated:** 2026-10-26

## 1. Problem

The pipeline currently resolves **one** LLM model per agent role
(`LlmService.getModel(role, installationId)` in
`src/orchestration/llm.service.ts`). There is no runtime provider failover for
agent calls. If the active provider fails mid-run — especially inside the
patcher/planner tool loops — the graph node throws, the pipeline aborts, and:

- BullMQ retries the **entire job** (`attempts: 3`,
  `src/ingestion/ingestion.module.ts:20`).
- The graph is compiled **without a checkpointer**
  (`src/orchestration/orchestration.service.ts:430` → `workflow.compile()`), so
  every retry restarts at `START` and redoes onboarding, RAG, planning, etc.
- There is no way to continue the same run on a different provider.

The only failover today is:
- `DecisionProviderService.decide()` (`src/decision/decision-provider.service.ts`)
  — a fallback chain for **triage / patch-gate decisions only**, not agent LLM
  calls.
- The Ollama "fallback" in `LlmService.buildModel()` — a **build-time** choice
  when no API key exists, not runtime failover.

## 2. Goal

When the active provider fails with a **retryable/provider-outage** error, switch
to a configured **fallback provider** and **resume from the last checkpointed
node** instead of restarting the whole pipeline.

### Non-goals
- Resuming a single in-flight streaming response token-by-token.
- Running providers in parallel / racing them.
- Masking deterministic request-shape bugs (e.g. the DeepSeek
  `reasoning_content` 400) — those must fail fast and be fixed, not retried on
  another provider. See §6 (error classification).
- Changing gate/triage semantics.

## 3. Current architecture (as-is)

Key files:
- `src/ingestion/issue.processor.ts` — lock acquisition, repository cache,
  worktree creation, RAG ingestion, then `orchestration.runPipeline(...)`;
  re-throws so BullMQ retries.
- `src/orchestration/orchestration.service.ts` — builds the LangGraph
  `StateGraph`; nodes: `onboarding → triage → planner ⇄ planner_tools →
  patcher ⇄ patcher_tools → patch_gate → validator → git` (+ `human_feedback`).
- `src/orchestration/graph.state.ts` — state channels, including
  `messages`, `plannerMessages`, `patchMessages`.
- `src/orchestration/llm.service.ts` — provider detection (`detectProviderKind`,
  base-URL based), `buildModel`, `getModel(role, installationId)`.
- `src/orchestration/agents/*.agent.ts` — each agent calls
  `llmService.getModel('<role>', installationId)` and invokes it.
- `src/orchestration/agents/patch-generator.agent.ts` — tool loop; keeps an
  **in-memory** `PatchSession` (`readPaths`, `appliedActions`,
  `blockedActions`) in a `Map` keyed by worktree path.

BullMQ job options (`src/ingestion/ingestion.module.ts`): `attempts: 3`, backoff,
`removeOnFail` retention. Job ids are stable (`gh-delivery-<delivery id>`).

**Important current behaviour:** a BullMQ retry re-enters
`IssueProcessor.process()` from the top. That means locks, repo cache, worktree
creation, and RAG all re-run. `GitService` may delete and recreate a "stale"
worktree branch, which can **discard edits** from the failed attempt. Any
resume design must make these pre-graph steps idempotent (see §8).

## 4. High-level design

```
                 ┌──────────────────────────────────────────────┐
                 │ BullMQ job (id = gh-delivery-...)             │
                 └───────────────┬──────────────────────────────┘
                                 │ process()
                                 ▼
        ┌──────────────────────────────────────────────────────┐
        │ IssueProcessor                                        │
        │  1. acquire locks                                     │
        │  2. ensure repo cache                                 │
        │  3. ensure worktree  (IDEMPOTENT: reuse if resuming)  │
        │  4. ensure RAG index (cached; cheap on re-run)        │
        │  5. runPipeline(state, threadId=jobId)                │
        └──────────────────────────┬───────────────────────────┘
                                   │
                                   ▼
        ┌──────────────────────────────────────────────────────┐
        │ LangGraph (compiled WITH a persistent checkpointer)   │
        │  onboarding → ... → patcher ⇄ patcher_tools → ...     │
        │                                                      │
        │  provider error in a node                            │
        │      │                                               │
        │      ├─ classify error                               │
        │      ├─ if failover-eligible + fallback configured:  │
        │      │     update checkpoint state:                  │
        │      │       providerOverride = fallback             │
        │      │       failoverAttempts += 1                   │
        │      │     throw ProviderFailoverError                │
        │      └─ else: throw as today                         │
        └──────────────────────────┬───────────────────────────┘
                                   │
                                   ▼
        ┌──────────────────────────────────────────────────────┐
        │ BullMQ retry (same job id)                            │
        │  → IssueProcessor resumes (idempotent pre-steps)      │
        │  → graph.invoke(... same thread_id ...)               │
        │  → resumes at the last checkpoint (failed node retry) │
        │  → agents resolve models with providerOverride        │
        └──────────────────────────────────────────────────────┘
```

## 5. Checkpointer

### 5.1 What to use
- **Dev/tests:** `MemorySaver` from `@langchain/langgraph` (no infra, no
  durability across process restarts — useful for unit/integration tests).
- **Production:** a **persistent** saver. Prefer the existing infrastructure:
  Redis (already used by BullMQ/locks) or Postgres (already used by Prisma).
  Candidate packages (verify exact names/versions against the installed
  `@langchain/langgraph` before implementing):
  - `@langchain/langgraph-checkpoint-redis`
  - `@langchain/langgraph-checkpoint-postgres`
  - `@langchain/langgraph-checkpoint-sqlite` (single-node/dev only)
- **Verify as a spike (see §14):** which package/version is compatible with the
  repo's `@langchain/langgraph`, whether it needs its own schema/migrations, and
  its serialization of `BaseMessage` (must preserve `additional_kwargs`,
  including DeepSeek `reasoning_content` and Gemini `thought_signature`).

### 5.2 Thread identity
- Use a **stable** `thread_id` per job: the GitHub delivery id / BullMQ job id
  (e.g. `thread_id = job.id`). Stable across retries is what makes resume work.
- Do **not** include the BullMQ attempt number in `thread_id`, or each retry
  becomes a fresh thread.
- If a job must support multiple independent runs (e.g. human-feedback re-runs),
  use a new thread per logical run and record it in job data.

### 5.3 Compile + invoke
- `workflow.compile({ checkpointer })`.
- `await graph.invoke(input, { configurable: { thread_id } })` on a fresh run.
- On resume, invoke with the **same** `thread_id` and no new graph input (or the
  minimal override, see §7.2). **Verify** the exact resume API for the installed
  LangGraph JS version: whether `invoke(null, config)` / `invoke({}, config)`
  resumes from the last checkpoint, and how a node that threw is re-run.
- Consider `graph.updateState(config, values)` to persist `providerOverride`
  before throwing (see §7).

### 5.4 Cleanup / retention
- Delete the thread's checkpoints after a **terminal** outcome (success, final
  failure, or quarantine) or apply a TTL (Redis/Postgres).
- Checkpoints contain tool outputs, file contents, and possibly secrets — use a
  private store, TTL, and access control. Do not log checkpoint payloads.

## 6. Error classification (critical)

Failover must be **selective**. Put the classifier in one module, e.g.
`src/common/provider-errors.ts`.

**Failover-eligible (retry on another provider):**
- Network/transport: `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, socket hang up.
- Provider availability: HTTP `429`, `500`, `502`, `503`, `504`.
- Provider-specific "overloaded"/"temporarily unavailable" messages.
- Request timeouts / abort errors from the model SDK.

**NOT failover-eligible (fail fast / fix the bug):**
- HTTP `400` request-shape validation — **including the DeepSeek
  `reasoning_content` 400**. Falling over would hide a real bug and burn the
  fallback provider.
- HTTP `401/403` auth/key problems (config error).
- Context-length/too-many-tokens errors (fallback may help only if it has a
  larger window — treat as a separate, explicit policy, not generic failover).
- Invalid tool schema / unsupported parameter.
- Our own thrown domain errors (`Patch generation failed: ...`,
  `No implementation plan ...`).

Expose a small helper, e.g. `classifyProviderError(err) -> { failover: boolean, reason }`,
and unit-test it against SDK error shapes (OpenAI `APIError.status`,
`APIConnectionError`, `APIConnectionTimeoutError`).

## 7. Provider override + re-enqueue

### 7.1 Fallback configuration
Add explicit fallback config (env and/or BYOK), e.g.:
```
LLM_FALLBACK_PROVIDER=openai|anthropic|gemini|deepseek|openrouter|...
LLM_FALLBACK_MODEL=<model>
LLM_FALLBACK_API_KEY=<key>
LLM_FALLBACK_BASE_URL=<url>
```
Or a chain: `LLM_FAILOVER_CHAIN=primary,openai,anthropic` (JSON or CSV).
- Resolution precedence should mirror `getModel`: explicit override → fallback
  config → primary. Document interactions with per-agent overrides.
- Keep it **opt-in** (`ENABLE_PROVIDER_FAILOVER=false` by default) so current
  behaviour is unchanged until enabled.

### 7.2 Plumb the override through state
- Add to `AgentState` (`src/orchestration/graph.state.ts`):
  - `providerOverride?: { provider: string; model?: string; apiKeyRef?: string; baseUrl?: string }`
  - `failoverAttempts?: number`
  - `providersTried?: string[]`
- Every agent passes it to model resolution, e.g.
  `llmService.getModel(role, installationId, state.providerOverride)`.
- `LlmService.getModel` gains an optional override param; cache key includes it.
- Persist the override **in the checkpoint** before throwing so the retry sees
  it. Preferred: `graph.updateState(config, { providerOverride, failoverAttempts })`
  then throw. Verify `updateState` semantics (and `asNode`) for the installed
  version. Fallback: store it in BullMQ job data via `job.updateData(...)` and
  read it at the start of `process()`.

### 7.3 Re-enqueue / retry mechanics
- Throw a typed `ProviderFailoverError` after updating state.
- Let BullMQ's existing `attempts: 3` retry the same job id, **or**
  explicitly re-enqueue if you need more attempts than BullMQ's cap.
- On the retry, `IssueProcessor.process()` must:
  1. detect an existing checkpoint thread for this job id (resume), vs a fresh
     run;
  2. re-acquire locks;
  3. **reuse the existing worktree** (do not delete/recreate — see §8);
  4. skip RAG if already indexed (it is content-hash cached today);
  5. `graph.invoke(<resume>, { configurable: { thread_id } })`.
- Guard against infinite loops: cap `failoverAttempts` (e.g. 2) and record
  `providersTried` so the same provider is not retried twice for the same error.

## 8. Idempotency of pre-graph steps (must-fix)

Resume only works if the environment the graph expects still exists. Today a
retry can destroy it.

1. **Worktree reuse.** `IssueProcessor` → `WorktreeManagerService` /
   `GitService` currently may remove a "stale" worktree branch and recreate the
   worktree, discarding partial edits. Required change:
   - If resuming a checkpoint thread and the worktree path from state/job data
     still exists on disk and is the expected repo, **reuse it**.
   - Only clean up/recreate when there is no resumable thread, or after a
     terminal failure.
   - Persist `worktreePath`/`repoPath` in the graph state (or job data) and treat
     them as the source of truth on resume.
2. **RAG ingestion** is content-hash cached (`RagIngestionService`), so a re-run
   is cheap (`0 indexed, N skipped`). Still, skip it on resume if the collection
   is already ready for the same worktree.
3. **Patch session state.** `PatchGeneratorAgent` keeps `readPaths`,
   `appliedActions`, and `blockedActions` in an **in-memory** `Map`. On a process
   restart these are lost even though the tool results are still in
   `patchMessages`.
   - Persist the session (or at least `appliedActions`/`blockedActions`/
     `readPaths`) in `AgentState` so `generatedPatch`, the "no changes applied"
     guard, and the read-before-edit guard behave correctly after resume.
   - Alternative: reconstruct `readPaths` and applied changes from
     `patchMessages` (tool calls + tool results). Document the chosen approach.
4. **Tool idempotency.** A node that throws is re-run on resume. Ensure file
   tools (`create_text_file`, `replace_symbol_body`, `insert_*`,
   `safe_delete_symbol`, `rename_symbol`) are safe to re-run, or ensure the
   checkpoint is always taken **after** a `*_tools` node returns, so completed
   tool effects are not repeated. `create_text_file` currently fails if the file
   exists — on a re-run after a partial attempt this could hard-fail; prefer
   "create-or-update" semantics in the adapter, or skip if content already
   matches.

## 9. Message compatibility when switching providers

Switching mid-conversation is not just "call another URL". The checkpointed
`AIMessage`s may carry provider-specific fields:

- DeepSeek: `additional_kwargs.reasoning_content`.
- Gemini-via-proxy: `tool_calls[].extra_content.google.thought_signature`.
- Anthropic: native content blocks/signatures.

Requirements:
- **Sanitize per target provider.** Before invoking the fallback, strip fields
  the fallback does not understand (e.g. remove `reasoning_content` when the
  fallback is OpenAI/Anthropic/Gemini-native), or let LangChain's native
  converter ignore them — verify per provider. Do **not** send DeepSeek-only
  fields to unrelated providers.
- **Keep tool_calls and ToolMessages paired.** Tool call ids are arbitrary
  strings on most providers; keep the assistant `tool_calls` and the matching
  `ToolMessage.tool_call_id` together. Native Anthropic conversion is handled by
  `ChatAnthropic`, but verify multi-turn tool history converts cleanly.
- **Re-bind tools** for the fallback model (`bindTools`), and ensure the chosen
  fallback supports tool calling (some reasoning models historically do not).
- **Context window.** Tool histories can be large; if the fallback has a smaller
  window, the switch may fail with a context error. Either pick a comparable
  model or apply the existing trimming strategy before switching.

## 10. Where to wire the failure handling

Two layers, complementary:

1. **Node-level transient retry (optional, same provider).** Small bounded
   retry (e.g. 2 attempts with jitter) for 429/5xx inside a thin wrapper around
   `model.invoke`. Cheap and keeps most blips from reaching the graph boundary.
2. **Job-level failover (this design).** After node-level retries are exhausted
   (or on a non-retryable-outage error), persist `providerOverride` and abort so
   the next BullMQ attempt resumes on the fallback. This is the only layer that
   also survives process crashes.

Do not implement failover as an infinite in-node loop; always bound attempts and
record `providersTried` in state for observability and loop prevention.

## 11. State schema changes (sketch)

```ts
// graph.state.ts
export interface ProviderOverride {
  provider: string;   // label id, e.g. 'openai' | 'anthropic' | 'gemini' | ...
  model?: string;
  baseUrl?: string;
  apiKeyRef?: string; // reference only; never persist raw secrets in checkpoints
}

export interface AgentState {
  // ...existing
  providerOverride?: ProviderOverride;
  failoverAttempts?: number;
  providersTried?: string[];
  // persisted patch-session bits for resume
  appliedActions?: string[];
  blockedActions?: string[];
  readPaths?: string[];
}
```
Add matching channel reducers (replace semantics are fine for these scalars;
arrays may use the existing append/replace convention consistently).

## 12. Observability

- Log lines (structured): `[failover] provider=<p> role=<r> error=<class>
  attempt=<n> next=<fallback> thread=<id> resumeNode=<node>`.
- Metrics: failover attempts, resume successes/failures, checkpoint size,
  provider error rate by class, time-to-resume.
- Audit log: record the failover decision (provider, reason, thread id) so the
  dashboard/job detail shows why a run moved providers.
- Never log request payloads/keys.

## 13. Testing plan

Unit:
- `classifyProviderError` for SDK error shapes (429/5xx/timeouts vs 400/401).
- Provider override resolution + cache-key isolation in `LlmService`.
- State schema/reducers for the new fields.
- Resume decision logic (checkpoint exists + worktree valid → reuse).

Integration (mock providers):
- Primary model server that returns `reasoning_content`/tool calls, then fails
  with `503` on the 2nd tool call; fallback model server that succeeds.
  Assert:
  - graph resumes at `patcher` (no onboarding/planner re-run),
  - previously applied tool effects are **not** duplicated,
  - final `generatedPatch` includes pre-failover actions,
  - PR is created on the fallback provider.
- Crash resume: kill the process after a checkpoint, re-invoke with the same
  `thread_id`, assert resume.
- Provider-switch compatibility: DeepSeek→OpenAI, DeepSeek→Anthropic,
  Gemini→OpenAI; assert message conversion and no leaked provider-only fields.
- No-fallback / feature-flag-off: byte-for-byte current behaviour.

Checkpoint store:
- Write/read a thread; verify `patchMessages` round-trip including
  `additional_kwargs`.
- TTL/cleanup after terminal state.

## 14. Open questions / spike tasks (do these first)

1. **LangGraph JS checkpointer**: confirm the persistent saver package/version
   compatible with the repo's `@langchain/langgraph`; confirm message
   serialization keeps `additional_kwargs`.
2. **Resume API**: confirm how to resume after a node throws — `invoke(null, cfg)`
   vs `invoke({}, cfg)` vs `updateState(cfg, values)` then invoke; confirm node
   re-run semantics and whether completed `*_tools` node results are preserved.
3. **`updateState` vs job data** for persisting `providerOverride`; verify
   `asNode` behaviour.
4. **Worktree reuse**: confirm `GitService` can reuse an existing worktree
   without resetting it; add an explicit "resume" path.
5. **Patch session persistence**: choose state fields vs reconstruct-from-
   `patchMessages`; verify the "no changes applied" guard and read-before-edit
   guard after resume.
6. **Checkpoint size/cost**: measure `patchMessages` sizes for real repos; decide
   whether to trim or store large tool outputs off-checkpoint.
7. **Fallback catalog**: which providers/models are tool-calling-capable and
   context-comparable to the primary.

## 15. Rollout

- Feature flag: `ENABLE_PROVIDER_FAILOVER` (default off).
- Phase 1: `MemorySaver` + tests only (no prod change).
- Phase 2: persistent saver + failover enabled in a dev/staging instance;
  monitor resume success and duplicate-application incidents.
- Phase 3: enable per deployment; keep a kill switch.
- Rollback: disable the flag — graph runs exactly as today (compile without a
  checkpointer, or ignore it).

## 16. Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| In-node fallback only (try primary, catch, call fallback, continue) | No checkpointer needed; simplest | Doesn't survive process crashes; can't resume earlier nodes; still re-runs the node from scratch; duplicate-tool risk |
| Job-level failover, restart from START (today + provider override) | Simple; no checkpointer | Re-runs onboarding/RAG/planning; expensive; discards reasoning context; can lose edits |
| **Job-level failover with resumable checkpoints (this plan)** | Resumes near failure; survives crashes; provider-agnostic | Most work: checkpointer, idempotency, state schema, message sanitization, testing |

## 17. File-by-file change map (for the future implementer)

- `src/orchestration/graph.state.ts` — new state fields (§11).
- `src/orchestration/orchestration.service.ts` — compile with checkpointer;
  stable `thread_id`; resume vs fresh detection; catch/classify provider errors;
  persist override; emit failover audit/metrics.
- `src/orchestration/llm.service.ts` — `getModel(role, installationId, override?)`;
  fallback provider resolution; cache-key update; DeepSeek reasoning preservation
  must keep working (§9).
- `src/orchestration/agents/*.agent.ts` — pass `state.providerOverride` to
  `getModel`; persist patch-session bits; sanitize messages on provider switch.
- `src/orchestration/agents/patch-generator.agent.ts` — replace the in-memory
  `PatchSession` reliance for resume; ensure read-before-edit and "no changes
  applied" guards survive restart.
- `src/ingestion/issue.processor.ts` — idempotent pre-graph steps (reuse
  worktree, skip RAG on resume); resume detection; re-enqueue/retry with
  override; lock handling.
- `src/repository/*` / `src/git/*` (worktree) — explicit reuse path.
- `src/common/provider-errors.ts` (new) — classifier.
- `src/common/provider-override.ts` (new) — resolution/precedence.
- `src/ingestion/ingestion.module.ts` — job options (attempt count if changed).
- Tests under `src/**/*.spec.ts` + `test/` (mock providers).
- Docs: this file + architecture/README notes.

## 18. Acceptance criteria

- With failover disabled: behaviour and payloads are unchanged; all existing
  tests pass.
- With failover enabled and a fallback configured:
  - a retryable provider outage during `patcher` resumes at `patcher` (proven by
    tests asserting onboarding/planner are not re-executed),
  - no tool effect is applied twice,
  - the run completes and opens a PR using the fallback provider,
  - the job detail/audit log records the failover (provider, reason, node).
- A deterministic 400 (e.g. DeepSeek `reasoning_content`) does **not** trigger
  failover; it fails fast with a clear error.
- Checkpoints are cleaned up after terminal outcomes and are not logged.

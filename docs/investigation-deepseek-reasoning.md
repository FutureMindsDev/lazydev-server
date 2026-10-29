# Investigate: DeepSeek `400 reasoning_content ... must be passed back` on patch-gate retry

## Repo / stack
- **This is the repo to work in first.** The running container is
  `lazydev-server-app` (built from this repo), and this repo's `.env` is the one
  in effect: `OPENAI_BASE_URL=https://api.deepseek.com`, `LLM_MODEL=deepseek-flash`.
  (`/Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver` is the mirror.)
- NestJS + LangGraph multi-agent pipeline. LLM via LangChain (`@langchain/openai`, `@langchain/deepseek`).
- Deployed versions observed: `@langchain/openai@1.5.11`, `@langchain/deepseek@1.1.11`.
- Model in the failing run: native `ChatDeepSeek`, model `deepseek-flash` (log: `Initialized native DeepSeek client (model: deepseek-flash)` / `LLM backend: DeepSeek (native client) | Model: deepseek-flash ✅`).

## Symptom
The pipeline aborts with:
```
400 The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: <uuid>)
  at APIError.generate (@langchain/openai/.../openai/core/error.js)
  at OpenAI.makeRequest (.../client.js)
  at async .../@langchain/openai/dist/chat_models/completions.cjs:263
```
It fires **immediately after** the log line `Patch gate asked for a patch retry.` — i.e. on the *next* patcher LLM call after Gate B routes back to `patcher`. It has happened repeatedly (see `log.txt`, lines ~394, ~14:19:13, ~14:20:55).

## Update 2026-10-26 — likely trigger is thinking mode, not a provider rename
- Provider routing is by **base URL** (`detectProviderKind`), and this repo's
  `.env` is `OPENAI_BASE_URL=https://api.deepseek.com`, `LLM_MODEL=deepseek-flash`.
  The log confirms the native DeepSeek client, so provider detection did **not**
  change.
- The reasoning patch is present in `src/orchestration/llm.service.ts` and in the
  running `dist` (`reasoningPatched`), with no "patch FAILED to apply" log.
- Most likely change: **thinking mode is now on** for `deepseek-flash` (DeepSeek
  now serves `deepseek-flash` via V4.1-Flash, and thinking is an explicit
  capability). If an earlier run used a non-thinking model, the
  `reasoning_content` round-trip requirement simply did not apply then.
- Do **not** use provider failover to mask this 400 — it is a deterministic
  request-shape bug and must be classified as non-failover-eligible (see
  `docs/architecture/provider-failover-resume-plan.md` §6).
- Next step: confirm whether `LLM_MODEL` changed, then instrument the retry
  payload to see which assistant message lacks `reasoning_content`.

## Confirmed facts (do not re-litigate these)
1. This is **DeepSeek-specific**. The error text is DeepSeek's thinking-mode requirement; other providers (OpenAI, Gemini, Anthropic) don't require `reasoning_content` to be echoed back.
2. `src/orchestration/llm.service.ts` already monkey-patches `@langchain/openai`'s `convertMessagesToCompletionsMessageParams` to re-attach `reasoning_content` from `AIMessage.additional_kwargs` on outbound messages (function `patchLangChainReasoningContent`, ~lines 82–171; applied in the `LlmService` constructor ~lines 348–362 with a loud error if it can't apply).
3. The running container's `dist` **does** contain that patch (`grep -rl reasoningPatched /app/dist` → hit), and there was **no** "patch FAILED to apply" log. So the patch applied.
4. LangChain's inbound converter (`@langchain/openai/dist/converters/completions.cjs` ~line 160/175) copies `message.reasoning_content` into `additional_kwargs.reasoning_content` for assistant messages, and the streaming-delta converter does so at ~line 263.
5. The failing call is on the **retry** path: `patch_gate` → `patcher`. On that path `state.patchMessages` is *not* reset (only the planner and `human_feedback` reset it), so the request continues an existing conversation that ends with an assistant message (the previous final summary). `patch-generator.agent.ts` treats this as `isFreshAttempt = false`.
6. The Serena v2 `agent_interface` issue is **unrelated and already fixed**. Do not touch `Dockerfile.serena` or the Serena session handshake.

## Framework responsibility — what the docs actually say (checked 2026-10-26)
Do **not** expect LangGraph to solve this. Responsibility is split:

1. **LangGraph is orchestration only.** The official overview describes it as "a
   low-level orchestration framework and runtime" that "does not abstract
   prompts or architecture," focused on durable execution/streaming/HITL/
   persistence. Graph state just carries message objects between nodes; it does
   not serialize provider-specific request fields.
   https://docs.langchain.com/oss/javascript/langgraph/overview
2. **LangChain's messages layer carries the metadata, but doesn't guarantee the
   outbound round-trip.** The messages guide says reasoning is valid message
   content (v1 standard `ContentBlock.Reasoning` / `reasoning`) and that
   `AIMessage` carries provider metadata; it also describes conversations as a
   stateless growing message list — the model integration is what converts that
   list to each provider's wire format.
   https://docs.langchain.com/oss/javascript/langchain/messages
3. **`ChatDeepSeek` documents `additional_kwargs.reasoning_content` on the
   *response* AIMessage** (the integration page's sample output shows it), but
   does **not** document that it is automatically echoed back on the next
   request. Our installed `@langchain/openai@1.5.11` converter drops it
   outbound — which is exactly why this repo already has the monkey-patch.
   https://docs.langchain.com/oss/javascript/integrations/chat/deepseek

Conclusion: a correct fix belongs in the LangChain converter/patch (or in how we
build messages), not in LangGraph. Alternatively, avoid thinking mode entirely
for this role (see hypothesis 8).

## Non-goals
- Do not change Serena/MCP code.
- Do not "fix" by catching/ignoring the 400 or by silently retrying blindly; find the actual missing field.
- Do not wait for LangGraph to fix it; LangGraph deliberately does not handle provider payloads.

## Key files / locations to read first
- `src/orchestration/llm.service.ts` — patch function (`patchLangChainReasoningContent`, `applyPatch`), `buildModel`, DeepSeek branch (`new ChatDeepSeek(...)` ~lines 426–437), `onModuleInit` logging.
- `src/orchestration/agents/patch-generator.agent.ts` — `invoke()` ~lines 106–259: builds `currentMessages` from `state.patchMessages`, `isFreshAttempt` logic, `model.bindTools(...)`, `model.invoke(invokeMessages)`, and returns `patchMessages` / `patchMessages: []` semantics.
- `src/orchestration/orchestration.service.ts` — `patch_gate` node + conditional edge (~lines 375–390), `patcher_tools` node (~lines 197–255), `planner_tools` node (~lines 100–160), places that construct `new AIMessage({ content, tool_calls })` (~lines 141–146 and ~225–230).
- `src/orchestration/pipeline-gates.service.ts` — Gate B `patchGateNode` (does it append/modify messages?).
- `src/orchestration/agents/planner.agent.ts` — `replay = new AIMessage({ content, additional_kwargs: response.additional_kwargs })` (~line 634) as the reference for correctly preserving reasoning.
- `src/common/llm-guards.ts` — `ensureEndsWithUserTurn` (Gemini-only) and token stripping.
- `src/orchestration/graph.state.ts` — `patchMessages` channel reducer (replace semantics).
- Tests: `src/orchestration/llm.service.spec.ts` (if present), `src/orchestration/agents/patch-generator.agent.spec.ts`, `src/orchestration/orchestration.service.spec.ts`.

## Hypotheses (rank and test them, don't assume)
1. **Truthiness guard drops empty reasoning.** `applyPatch` does `if (msg.additional_kwargs?.reasoning_content) { ... }`. If DeepSeek returns `reasoning_content: ""` for some assistant turn (or requires the key to be present even when empty), it is never re-attached. Fix candidate: check `!== undefined` / `Object.hasOwn`.
2. **Some assistant turns never captured reasoning.** Inventory every assistant message in the failing outbound payload and check which lack `additional_kwargs.reasoning_content`. If the assistant message that DeepSeek requires is a turn where LangChain didn't surface the field (e.g., tool-call-only response, empty body, or a synthesized/continuation message), the patch has nothing to re-attach.
3. **Message reconstruction drops `additional_kwargs`.** `new AIMessage({ content, tool_calls })` in `orchestration.service.ts` (~141–146, ~225–230) drops `additional_kwargs`. Confirm whether the *filtered* message is what persists into graph state (current reading: only `filteredMessages` goes to `ToolNode`, while state appends the original `patchMessages`, so state may be intact — but verify empirically; also check any `.slice`/`map`/serialization that rebuilds messages, including LangGraph state persistence).
4. **Patch hits the wrong module instance.** The patch resolves `@langchain/openai/dist/converters/completions.cjs` by absolute path. Verify the *function actually runs* for the failing `ChatDeepSeek` request (log inside the patched wrapper), and that it's the same instance `ChatOpenAICompletions` uses.
5. **`deepseek-flash` returns reasoning under a different shape/version** than the one the patch was verified against (`deepseek-reasoner`). Inspect a raw response (`additional_kwargs.__raw_response` or a local capture server) to confirm the exact field name/value per turn.
6. **Streaming vs non-streaming** path differences (inbound delta captures reasoning only if `includeRawResponse`/delta present; the history-building path may differ).
7. **Thinking mode is unnecessary for this model/task** — consider whether `deepseek-flash` should be configured with thinking disabled, or whether the model should not be used for multi-turn tool loops at all.
8. **Thinking is on by default / silently enabled for `deepseek-flash`.** DeepSeek's docs expose thinking as an explicit request parameter (`"thinking": {"type": "enabled"}`, plus `reasoning_effort`) for `deepseek-flash` (https://api-docs.deepseek.com/). Our `ChatDeepSeek` construction passes only `model`, `apiKey`, `temperature`, and optional `baseURL` — no `thinking`/`reasoning_effort`. Confirm what the server defaults to. If thinking is on, either make the round-trip robust or explicitly disable it (e.g. pass the field through `modelKwargs`/extra body if supported).

## Reproduction / instrumentation plan
1. **Rebuild first** (the running image predates the latest `main`): `docker compose build app && docker compose up -d app`. Confirm logs still show `deepseek-flash` and reproduce by re-delivering/re-triggering the issue that exercises the patch-gate retry.
2. **Fast offline experiment** (no full pipeline): in a Node script (run inside the container or with the same `node_modules`), require the absolute converter path, build messages mimicking the retry (`SystemMessage`, `HumanMessage`, `AIMessage` with `additional_kwargs.reasoning_content`, tool-call assistant + `ToolMessage`, final assistant summary), call `convertMessagesToCompletionsMessageParams`, and print the JSON. Then repeat with: empty-string reasoning, missing reasoning, and reasoning on a tool-call assistant message. This isolates the converter/patch without DeepSeek.
3. **Capture the real outbound payload**: temporarily point `ChatDeepSeek` at a local HTTP server that records the request body and returns a canned DeepSeek-style response (or add a debug log inside the patched converter, gated by e.g. `DEBUG_REASONING_PATCH=1`, logging role + whether `additional_kwargs.reasoning_content` is present per message). Diff the outbound body against what DeepSeek requires.
4. **Instrument inbound**: log each assistant `AIMessage.additional_kwargs` after `model.invoke` in `patch-generator.agent.ts` / `planner.agent.ts` to see which turns carry reasoning.

## Fix directions (choose based on evidence)
- Change the re-attach guard from truthiness to `!== undefined` (and consider always emitting the key when in thinking mode).
- Preserve `additional_kwargs` whenever reconstructing `AIMessage` (spread `...lastAIMessage.additional_kwargs`, or clone the message via `new AIMessage(lastAIMessage)` and override only `tool_calls`).
- If DeepSeek requires reasoning on *every* assistant turn and some turns genuinely lack it, either (a) reconstruct a valid history (drop/adjust those turns for DeepSeek), or (b) disable thinking mode for `deepseek-flash` in `buildModel`.
- If the `deepseek-flash` thinking default can't be relied on, pass `thinking: { type: "disabled" }` (or the supported equivalent via `modelKwargs`/extra body) for this role, if the task doesn't need chain-of-thought — but confirm the field reaches the wire first.
- Keep the fix DeepSeek-scoped; do not alter OpenAI/Gemini/Anthropic payloads.

## Long-term fix (recommended architecture)
The durable fix is not "patch it again". The real smell is depending on a
third-party library's *internal, undocumented* wire-format conversion while
tracking an unpinned dependency. Long term, own that boundary and encode the
provider contract in tests.

Layered recommendation (do all four; they reinforce each other):

1. **Make thinking mode an explicit per-agent policy.**
   - DeepSeek `deepseek-flash` thinking is an opt-in request param
     (`thinking`, `reasoning_effort`). Decide per role:
     - deterministic tool loops (patcher, git, validation): thinking OFF —
       little benefit, removes the fragile history contract entirely;
     - planning/research: thinking ON only where it measurably helps.
   - This shrinks the blast radius to the few agents that actually need
     reasoning, instead of the whole pipeline.

2. **Replace the package-internal monkey-patch with an owned adapter.**
   - Preferred: a thin `ChatDeepSeek` subclass (or `ChatOpenAI` subclass) that
     overrides the request/message-building hook to inject
     `reasoning_content` from `message.additional_kwargs`. Uses class APIs, not
     `@langchain/openai/dist/converters/completions.cjs` by absolute path, so a
     patch release can't silently break it.
   - If no stable hook exists: `pnpm patch`/`patch-package` with a **pinned**
     `@langchain/*` version and a committed patch file — explicit, reviewable,
     and upgrade-gated (not a runtime path require).
   - Fallback for a DeepSeek-primary product: bypass LangChain conversion for
     DeepSeek and build requests with the official `openai` SDK (DeepSeek is
     OpenAI-compatible), mapping messages yourself with `reasoning_content` as
     a first-class field. More code to own, but zero internal-path fragility.
   - Note: migrating to LangChain v1 `contentBlocks` does **not** fix this by
     itself in `@langchain/openai@1.5.11` — the v1 converter filters reasoning
     blocks out of content and has no outbound `reasoning_content` mapping
     (verified in the installed converter). Treat that as a future option to
     re-check, not the fix.

3. **Make message handling lossless and centralized.**
   - Add a single helper (e.g. `withAllowedToolCalls(msg, ids)`) that clones an
     `AIMessage` while preserving `additional_kwargs`, `response_metadata`,
     `id`, `name`, etc. Replace every `new AIMessage({ content, tool_calls })`
     in graph/tool nodes (planner_tools, patcher_tools).
   - Provider-agnostic payoff: also preserves Gemini `thought_signature` and any
     future provider field. Add a unit test asserting metadata survives each
     reconstruction site.

4. **Enforce the provider contract in CI (highest leverage).**
   - Add an e2e test with a tiny mock "DeepSeek" OpenAI-compatible server that:
     returns `reasoning_content` on responses, and returns **400** when any
     assistant message in the request lacks it (mirrors the real API).
   - Exercise planner + patch-gate-retry against it. This turns this class of
     prod failure into a CI failure and catches LangChain upgrades, patch drift,
     and lossy message reconstruction.
   - Pin `@langchain/*` versions (pnpm overrides/lockfile) and add a startup
     "contract check" that fails loudly if the hook/patch target disappears on
     upgrade. Track the upstream fix (langchainjs PR #10889) and delete the
     adapter when native round-trip lands.

Suggested phasing:
- **Now (correctness):** fix the truthiness guard (`!== undefined`), preserve
  `additional_kwargs` at reconstruction sites, add the mock-server test, pin
  versions.
- **Next (durability):** move the DeepSeek quirk into a subclass or pinned
  patch; make thinking policy explicit per agent.
- **Later (cleanup):** drop the adapter once upstream round-trips
  `reasoning_content` natively.

Trade-offs:
- Thinking OFF = simplest/most robust, least reasoning quality.
- Owned adapter/pinned patch = keeps thinking, adds maintenance.
- Direct SDK for DeepSeek = most control, most code to own.

### Decision under our constraints (DeepSeek is NOT primary; keep reasoning; never break other providers)
- **Do not disable thinking.** Keep reasoning on.
- **Do not build DeepSeek-specific infrastructure** (no direct-SDK path, no
  DeepSeek-only subclass). Instead use a **provider-agnostic
  "message metadata preservation" shim** for the OpenAI-compatible converter:
  carry over a small allowlist from `AIMessage.additional_kwargs`
  (`reasoning_content`, and per-tool-call `extra_content`) only when present.
  It is a no-op for providers that don't use those keys, and native
  Gemini/Anthropic clients don't go through this converter at all.
- **Harden + test it, don't expand it:** `!== undefined` for empty reasoning,
  one module, startup contract check, pinned `@langchain/*`.
- **Fix lossy message reconstruction** (`cloneMessage` preserving
  `additional_kwargs`/`response_metadata`/`id`) — provider-agnostic and also
  protects Gemini `thought_signature`.
- **Keep the per-agent provider/model override** as the escape hatch: reasoning-
  heavy agents can point at a provider with native reasoning round-trip;
  DeepSeek remains a supported-but-shimmed provider, never the architectural
  center.
- **Guarantee "don't break others" with a contract test matrix**, not by
  avoiding the shim: mock DeepSeek (400 when reasoning missing) + assert exact
  OpenAI payload has no leaked fields + native Gemini/Anthropic unaffected.

## Tests / verification
- Add unit tests around the converter patch: an `AIMessage` with non-empty, empty-string, and missing `reasoning_content`; assert outbound JSON has/handles the field correctly. Include a tool-call assistant message case.
- Add a regression test for whatever reconstruction path is implicated (assert `additional_kwargs` survives).
- Run: `npm run build`, `npx eslint <changed files>`, `npx jest` (full suite must stay green — currently 385 tests in this repo).
- If feasible, an integration test with a mock OpenAI-compatible server that 400s when `reasoning_content` is missing on an assistant turn.

## Deliverables
1. A concise root-cause writeup (which exact assistant message lost `reasoning_content`, and where).
2. A minimal code fix + tests.
3. A short note in the appropriate architecture/LLM doc explaining the DeepSeek thinking-mode round-trip requirement and the fix.
4. Confirmation that non-DeepSeek providers are unaffected, with the full test suite + build + lint output.

## Guardrails
- Follow repo conventions (TypeScript strict, prettier, conventional commits). Do not add comments unless consistent with surrounding style.
- Don't commit unless explicitly asked. If asked, branch from `main` (e.g. `fix/deepseek-reasoning-roundtrip`) and keep the diff focused.

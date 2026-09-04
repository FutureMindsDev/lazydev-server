Based on the commit history (94 commits) and the runtime logs (`log-recursion-limit-on-issueprocessor.txt`, `log-1/2/3.txt`, `logs-ai-calendar*.txt`), the difficult parts of this agent's development fall into **six categories**. Each is given as a single sentence, followed by a STAR-format explanation.

---

### 1. Agent loop control & tool-loop convergence
**Sentence:** Getting the LangGraph agent loops (planner and patcher) to actually *stop* instead of spinning until the recursion limit was the single hardest control-flow problem in the project.

**STAR:**
- **Situation:** The pipeline ran as a planner ⇄ planner_tools and patcher ⇄ patcher_tools tool loop on LangGraph. Jobs were failing with `GraphRecursionError: Recursion limit of 100 reached without hitting a stop condition` (visible throughout `log-recursion-limit-on-issueprocessor.txt`, e.g. issue #4 at 15:27:35).
- **Task:** Make the loops terminate cleanly via the model's own signal, without arbitrary force-stops that produced garbage plans/patches.
- **Action:** First attempt was post-hoc compensation — budget warnings at 70% of cap, DSML token stripping, fallback plan synthesis, raised hard caps to 80/120 (`78f1d00`). This was later recognized as treating symptoms and refactored to the **dispatch-boundary** pattern (Claude Code / Codex style): repeat detection moved into the tool-dispatch node so duplicate calls return a `ToolMessage` refusal instead of executing; primary stop = no `tool_calls` from the model; hard caps kept only as backstops at 50/60 messages and 40/60 global tool-call budgets; `tool-call-tracker.ts` rewritten with 18 unit tests (`8d2a69e`).
- **Result:** The loop now converges on the model's own end signal, the post-hoc machinery (DSML stripping, fallback synthesis, budget warnings) was deleted entirely, and the recursion-limit failures stopped appearing in later logs.

---

### 2. LLM hallucination of symbol names across agent handoffs
**Sentence:** Symbol names were being silently corrupted as they passed through the research → planning → patch-generation chain, causing `replace_symbol_body` to fail on names like `Home` that should have been `HomePage`.

**STAR:**
- **Situation:** The original three-agent pipeline (IssueAnalyzer → Research → Planning) used free-text prose handoffs. ResearchAgent had a `get_file_symbols` tool but the LLM often picked `read_code_file` instead, and even when structured symbol data was collected it got summarized away into the `researchContext` string.
- **Task:** Ensure the patch generator sees and uses the *exact* symbol names from the real codebase.
- **Action:** Three iterations, two of them reverted. (a) `0e28ecd` added a filesystem-write fallback when `replace_symbol_body` failed — **reverted** (`29bbb5d`) because it masked the root cause. (b) `1516c8e` added fuzzy-match retry via `get_symbols_overview` — **reverted** (`7c4f344`) for the same reason. (c) `5af11ef` fixed the root cause: fetch symbol overviews *before* the LLM call and inject them as a "Symbol Reference" section. Finally, `9b5df1b` collapsed all three agents into a single `PlannerAgent` tool-loop so symbol names are verified against the live language server before the plan is ever written.
- **Result:** The `Home` vs `HomePage` class of failures disappeared because the LLM never has to guess a symbol name — it reads them from the LSP directly in the same conversation that produces the plan.

---

### 3. Multi-provider LLM API compatibility quirks
**Sentence:** Supporting Gemini, DeepSeek, OpenAI, and Ollama through LangChain's OpenAI-compatible adapter required patching around silent field-stripping and provider-specific request-shape rules that broke multi-turn tool calling.

**STAR:**
- **Situation:** The agent uses per-agent model selection (`c25dcfc`), so different agents hit different providers. Gemini 3 requires a `thought_signature` on every tool call when replaying history; DeepSeek emits `reasoning_content`; Gemini rejects requests that end with a model/assistant turn.
- **Task:** Make one LangChain-based code path work across all four providers without per-provider branches.
- **Action:** `836138e` extended the existing `patchLangChainReasoningContent` monkey-patch to re-attach `extra_content` (carrying `thought_signature`) from `additional_kwargs.tool_calls` back onto the OpenAI-format tool calls by matching tool-call IDs — a no-op for OpenAI/DeepSeek/Ollama. `12816c2` reordered the ResearchAgent message array to `[systemPrompt, ...existingMessages, userPrompt]` so requests always end on a user turn for Gemini. The DSML token-stripping quirk was handled in `78f1d00` (and later removed once the loop stop mechanism was fixed in `8d2a69e`).
- **Result:** Multi-turn function calling now works uniformly across providers; the patches are defensive no-ops for providers that don't emit the relevant fields.

---

### 4. Concurrency, distributed locks & job deduplication
**Sentence:** Race conditions between BullMQ workers, Redis locks, and GitHub webhook redelivery caused duplicate pipeline runs, undefined-lock crashes, and doubled log lines.

**STAR:**
- **Situation:** On fresh container starts with retried jobs already in Redis, BullMQ workers could pull a job the instant `IssueProcessor` was instantiated, with no guarantee `LockService.onModuleInit` had run — `acquire()` hit a still-undefined `this.redlock` (`TypeError: Cannot read properties of undefined (reading 'acquire')`). Separately, `removeOnComplete` was unset, so a second webhook delivery after job completion spawned a duplicate run.
- **Task:** Guarantee locks are available before any job can run, and prevent duplicate processing of redelivered webhooks.
- **Action:** `81f3bfa` moved redlock initialization from `onModuleInit` into the `LockService` constructor so it's ready before workers start. `bf38e5a` set `removeOnComplete: { age: 3600 }` and `removeOnFail: { age: 86400 }` so BullMQ's `jobId` deduplication covers GitHub's retry window. `d34ec28` improved lock lifecycle and BullMQ queue cleanup on restart; `241cc9f` set `concurrency=1` to stop duplicate jobs.
- **Result:** Container restarts no longer crash on undefined locks, and redelivered webhooks are safely rejected by BullMQ's existing-job check instead of producing twin pipeline runs.

---

### 5. Docker / sandbox / environment plumbing
**Sentence:** Reconciling filesystem paths, volumes, and native-module build requirements between the `app`, `serena`, and sandbox containers was a long sequence of subtle integration bugs.

**STAR:**
- **Situation:** Three containers share state: the app clones repos into `repo-cache`, Serena's language server must read the same clone, and the validation sandbox builds the patched code. A relative `REPO_CACHE_DIR=./repo-cache` resolved against Serena's container cwd (not the app's), so Serena reported "Project not found". The sandbox used `node:20-alpine`, which lacks Python/make/g++ and broke native npm modules. `ripgrep` scanned `node_modules` and overflowed the child-process stdout buffer.
- **Task:** Make the three-container setup share a consistent filesystem and build environment.
- **Action:** `81f3bfa` added a named `repo-cache` volume mounted into both app and serena, and resolved `REPO_CACHE_DIR` to an absolute path in the constructor. `e30e108` switched the sandbox image from `node:20-alpine` to full `node:20`, added ripgrep `--glob` exclusions, `--max-count=5`, `--max-filesize=1M`, and raised `maxBuffer` to 5MB. `bf38e5a` fixed the worktree-vs-cwd path bug so search results are repo-root-relative. `73044fa` added `isGitRepoHealthy()` to detect `.git/config` corrupted by interrupted volume writes and re-clone.
- **Result:** Serena activates the correct project, the sandbox builds native modules, search no longer crashes on common terms, and corrupted caches self-heal instead of failing every subsequent job.

---

### 6. Git workflow correctness
**Sentence:** Automating branch creation, commits, and PRs via the GitHub App token hit a cluster of edge cases around empty commits, branch conflicts, existing PRs, and token expiry.

**STAR:**
- **Situation:** The agent pushes fix branches and opens PRs automatically. Early versions produced empty commits (when `.serena` was staged), failed on branch-name collisions, errored when a PR already existed for the branch, and silently broke after the GitHub App token expired mid-run.
- **Task:** Make the git/PR leg idempotent and resilient to retries and token rotation.
- **Action:** `e929287` unstaged `.serena` to prevent empty commits; `e5bd493` handled branch-creation conflicts, ignored lockfiles, and included the AI approach in the PR body; `534f0e5` gracefully handled existing PRs and prevented branch-reset commits; `62252a8` enforced explicit author identity and fixed the token-expiry bug; `9095f92` made the push strategy (force vs normal) configurable via env.
- **Result:** The git/PR automation is now idempotent across retries and no longer fails on the common edge cases, though it remains the area with the most individual fix commits — a sign the surface is inherently fiddly.
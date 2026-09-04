# Frontend task: Per-agent model overrides in the BYOK settings UI

The backend now supports **per-agent model name overrides** within a BYOK
config. This lets the user say "all agents use model X from my provider,
but the planner uses model Y instead" — same provider, same API key, just
different model names per agent.

This document is the **delta** on top of `FRONTEND_BYOK_PROMPT.md`. Read
that file first for the full BYOK settings page context. This file only
covers what changed for per-agent overrides.

---

## What changed in the backend

The `llm_config` table now has an `agentModelOverrides` JSON column. It
stores a map of `{ agentRole: modelName }` — e.g.:

```json
{
  "planner": "anthropic/claude-3.5-sonnet",
  "patch_generator": "anthropic/claude-3.5-sonnet",
  "onboarding": "meta-llama/llama-3.1-8b-instruct"
}
```

All models in the map are served by the **same** BYOK provider (same API
key + base URL). Only the model name varies per agent. If an agent isn't
in the map, it uses the shared `model` field.

**Resolution order** (most specific wins):
1. Per-agent env override (`PLANNER_MODEL` + `PLANNER_API_KEY`) — can point at a different provider entirely
2. BYOK per-agent model override (`agentModelOverrides[role]`) — same provider, different model name
3. BYOK shared model (`model` field)
4. Shared env default (`OPENAI_API_KEY` + `LLM_MODEL`)

---

## Updated types

### `ByokSettingsDto` (response from GET /api/dashboard/settings)

```typescript
export interface ByokSettingsDto {
  configured: boolean;
  scope: 'installation' | 'global' | null;
  baseUrl: string | null;
  model: string | null;
  /** NEW: per-agent model overrides, or null when none are set. */
  agentModelOverrides: Record<string, string> | null;
  apiKeyHint: string | null;
  updatedAt: string | null;
}
```

### `UpdateLlmSettingsRequest` (body for PUT /api/dashboard/settings/llm)

```typescript
export interface UpdateLlmSettingsRequest {
  installationId?: number | null;
  apiKey?: string;
  baseUrl?: string | null;
  model?: string;
  /**
   * NEW: per-agent model overrides. Pass a partial map to merge (e.g.
   * { planner: "strong-model" }), null to clear all overrides, or omit
   * to leave them unchanged. Unknown agent role keys are silently dropped.
   */
  agentModelOverrides?: Record<string, string> | null;
}
```

### Agent role keys

The valid keys for `agentModelOverrides` are:

```typescript
const AGENT_ROLES = [
  { key: 'planner',         label: 'Planner',         description: 'Analyzes the issue and creates the implementation plan' },
  { key: 'patch_generator', label: 'Patch Generator', description: 'Writes the actual code changes' },
  { key: 'validation',      label: 'Validation',      description: 'Reviews and validates generated patches' },
  { key: 'onboarding',      label: 'Onboarding',      description: 'Indexes new repositories (cheap model is fine)' },
] as const;
```

> `git` and `analyzer`/`research` are valid keys too but `git` doesn't use
> an LLM and `analyzer`/`research` are dead code. Only show the 4 above in
> the UI.

---

## UI design

Add a **"Per-agent model overrides"** section inside the LLM Provider card,
below the shared model field. It only appears when `byok.configured === true`
(there's no point overriding per-agent if no BYOK config is saved).

### Layout

```
┌─────────────────────────────────────────────────────┐
│  LLM Provider                         [source: byok] │
│                                                     │
│  Provider:  OpenRouter                               │
│  Model:     qwen/qwen2.5-coder-32b-instruct          │
│  API Key:   ••••abcd                  (scope: global)│
│                                                     │
│  ── Per-agent model overrides ───────────────────── │
│  Use a different model for specific agents. All     │
│  agents share the same provider (key + URL above).  │
│                                                     │
│  Planner:         [ qwen/qwen2.5-coder-32b  ▾ ]     │
│  Patch Generator: [ anthropic/claude-3.5-so ▾ ]     │
│  Validation:      [ qwen/qwen2.5-coder-32b  ▾ ]     │
│  Onboarding:      [ meta-llama/llama-3.1-8b ▾ ]     │
│                                                     │
│  [ Reset to shared model ]                           │
│  ─────────────────────────────────────────────────── │
│  [ Save changes ]    [ Cancel ]                      │
└─────────────────────────────────────────────────────┘
```

### Behaviour

1. **Each agent row** has a text input pre-filled with:
   - The override value if `agentModelOverrides[role]` exists
   - The shared `model` value if no override exists (shown as a placeholder, not the actual value — the input is empty with a placeholder like "uses shared model")
   - Actually, simpler: **if an override exists, show it in the input. If not, show the input empty with a placeholder reading the shared model name.** This makes it clear which agents have overrides and which don't.

2. **"Reset to shared model"** button per row (small × icon): clears that agent's override. When cleared, the input goes back to empty with the placeholder.

3. **Save**: collects all non-empty inputs into a map and sends:
   ```typescript
   PUT /api/dashboard/settings/llm
   { agentModelOverrides: { planner: "...", patch_generator: "..." } }
   ```
   - Agents with empty inputs are **omitted** from the map (not included as empty strings). The backend treats omitted keys as "no override for this agent".
   - If ALL inputs are empty, send `agentModelOverrides: null` to clear all overrides.
   - You can save overrides **without** re-sending apiKey/baseUrl/model — they're omitted from the body and the backend keeps the stored values.

4. **After save**: the SWR cache refreshes (`mutate('settings')`) and the UI shows the updated override values.

5. **No separate save per agent**: one Save button saves all overrides at once. This matches the backend's single PUT call.

### When no BYOK config is saved

The entire per-agent section is hidden. Per-agent model overrides only
make sense within a BYOK config (they share the BYOK provider's key). If
the user is on env defaults, they should use `PLANNER_MODEL` etc. in
`.env` instead — show a small note: "Per-agent model overrides require a
saved provider config above."

---

## Mock updates

### `src/mocks/data.ts`

Update `mockSettings()` to include `agentModelOverrides`:

```typescript
byok: {
  configured: false,
  scope: null,
  baseUrl: null,
  model: null,
  agentModelOverrides: null,  // NEW
  apiKeyHint: null,
  updatedAt: null,
},
```

### `src/mocks/handlers.ts`

Update the PUT handler to store and return `agentModelOverrides`:

```typescript
// In the mock BYOK state, add:
let mockByokState: ByokSettingsDto = {
  configured: false, scope: null, baseUrl: null, model: null,
  agentModelOverrides: null, apiKeyHint: null, updatedAt: null,
};

// PUT handler — add agentModelOverrides handling:
http.put(`${BASE}/api/dashboard/settings/llm`, async ({ request }) => {
  await delay(LATENCY);
  const body = await request.json() as UpdateLlmSettingsRequest;
  mockByokState = {
    ...mockByokState,
    configured: true,
    scope: body.installationId != null ? 'installation' : 'global',
    baseUrl: body.baseUrl ?? mockByokState.baseUrl,
    model: body.model ?? mockByokState.model,
    agentModelOverrides: body.agentModelOverrides !== undefined
      ? body.agentModelOverrides
      : mockByokState.agentModelOverrides,
    apiKeyHint: body.apiKey
      ? `••••${body.apiKey.slice(-4)}`
      : mockByokState.apiKeyHint,
    updatedAt: new Date().toISOString(),
  };
  return HttpResponse.json(mockByokState);
});
```

---

## Component checklist

- [ ] Update `src/lib/types.ts` — add `agentModelOverrides` to `ByokSettingsDto` and `UpdateLlmSettingsRequest`
- [ ] Update `src/mocks/data.ts` — add `agentModelOverrides: null` to `mockSettings()`
- [ ] Update `src/mocks/handlers.ts` — store/return `agentModelOverrides` in PUT handler
- [ ] Update `src/app/settings/page.tsx` — add per-agent model override section (4 agent rows, save/reset, only visible when BYOK is configured)
- [ ] Verify with `pnpm dev` (mocks on) — save a BYOK config → set per-agent overrides → verify they persist in the display → clear one → verify it reverts to shared model
- [ ] Verify `pnpm build` passes

---

## Key points to remember

1. **Per-agent overrides are model names only** — not separate API keys or providers. All agents share the BYOK provider's key and base URL.
2. **The section only shows when `byok.configured === true`** — no point overriding models if no provider is configured.
3. **Empty input = no override for that agent** — it uses the shared model. Don't send empty strings in the map.
4. **One Save button for all overrides** — not per-row saves.
5. **The `agentModelOverrides` field is optional in the PUT body** — omit it to leave overrides unchanged, pass `null` to clear all, pass a map to set/merge.
6. **Unknown agent role keys are silently dropped by the backend** — but the UI should only show the 4 valid roles listed above anyway.

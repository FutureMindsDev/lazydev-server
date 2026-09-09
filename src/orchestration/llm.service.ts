/**
 * Copyright (c) 2026 FutureMindsDev. All rights reserved.
 *
 * LazyDev™ is a trademark of FutureMindsDev.
 * Organization : https://github.com/FutureMindsDev
 *
 * Authors:
 *   Arkar Chan Myae  <https://github.com/arkar-chanmyae>
 *   Khin Me Me Latt  <https://github.com/KhinMeMeLatt>
 *
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 */

import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatAnthropic } from '@langchain/anthropic';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { LlmConfigService } from './llm-config.service';

/**
 * Monkey-patches LangChain's OpenAI message converter to preserve two
 * provider-specific fields that LangChain drops when converting AIMessages
 * back to OpenAI Chat Completions format:
 *
 * 1. `reasoning_content` (DeepSeek thinking mode) — on the assistant message
 *    itself. DeepSeek requires this to be present when the AIMessage is sent
 *    back in multi-turn tool loops, but LangChain only passes `role`,
 *    `content`, and `tool_calls`, silently dropping it. Without the patch:
 *
 *      400 The `reasoning_content` in the thinking mode must be passed back.
 *
 *    Verified against @langchain/openai@1.5.11 (latest): the outbound
 *    converter still drops it. ChatDeepSeek (@langchain/deepseek@1.1.11)
 *    extends ChatOpenAICompletions and inherits the same bug, so this patch
 *    is required for BOTH the ChatOpenAI→DeepSeek path and the native
 *    ChatDeepSeek path (they share this deduped converter module).
 *
 * 2. `extra_content.google.thought_signature` (Gemini 3 thinking models) — on
 *    each tool call in the assistant message. Gemini 3 requires the
 *    `thought_signature` to be passed back on tool_calls when sending
 *    conversation history, or multi-turn function calling fails with:
 *
 *      400 Function call is missing a thought_signature in functionCall parts.
 *
 *    This part of the patch only matters for Gemini routed through an
 *    OpenAI-compatible PROXY (e.g. OpenRouter) — direct Gemini now goes
 *    through @langchain/google-genai's ChatGoogleGenerativeAI, which
 *    round-trips thought_signature natively.
 *
 * Both patches are no-ops for providers that don't use these fields (OpenAI,
 * Ollama, OpenRouter non-Gemini models).
 *
 * Returns true if the patch applied (or was already applied), false if the
 * patch target could not be found — callers must log loudly on false, since
 * a silently unpatched converter means DeepSeek/Gemini tool loops start
 * failing with 400s again.
 *
 * Remove this once LangChain's @langchain/openai preserves these fields in
 * `convertMessagesToCompletionsMessageParams` natively (upstream PR #10889
 * is not in any released version as of 1.5.11).
 */
function patchLangChainReasoningContent(): boolean {
  try {
    // @langchain/openai's package.json "exports" field only exposes the
    // package root, blocking direct require() of internal subpaths by
    // package specifier. But "./package.json" IS exported, so we resolve the
    // package root from it and then require the converter module by its
    // ABSOLUTE path — absolute-path requires bypass the exports map, and
    // module identity is keyed by resolved file path, so this returns the
    // exact same module instance the package internals (and ChatOpenAI)
    // use. Works identically under plain Node and under jest (which uses its
    // own module registry instead of Node's Module._cache).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkgJsonPath = require.resolve('@langchain/openai/package.json');
    const completionsPath = path.join(
      path.dirname(pkgJsonPath),
      'dist',
      'converters',
      'completions.cjs',
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const completionsModule = require(completionsPath);
    return applyPatch(completionsModule);
  } catch {
    return false;
  }
}

function applyPatch(completionsModule: any): boolean {
  const originalConvert =
    completionsModule.convertMessagesToCompletionsMessageParams;
  if (!originalConvert) return false;
  if (originalConvert.__reasoningPatched) return true;

  const patched = function ({ messages, model }: any) {
    const result = originalConvert({ messages, model });
    // The converter preserves message order, so result[i] corresponds to
    // messages[i].
    for (let i = 0; i < messages.length && i < result.length; i++) {
      const msg = messages[i];
      const converted = result[i];
      if (converted?.role !== 'assistant') continue;

      // Re-attach reasoning_content (DeepSeek thinking mode).
      if (msg?.additional_kwargs?.reasoning_content) {
        converted.reasoning_content = msg.additional_kwargs.reasoning_content;
      }

      // Re-attach extra_content on tool calls (Gemini thought signatures).
      // Gemini 3 models require thought_signature to be passed back on the
      // assistant message's tool_calls when sending conversation history.
      // LangChain stores the raw tool calls (with extra_content) in
      // additional_kwargs.tool_calls but uses the parsed tool_calls (without
      // extra_content) when converting back — so we need to re-attach it.
      const rawToolCalls = msg?.additional_kwargs?.tool_calls;
      const convertedToolCalls = converted?.tool_calls;
      if (
        Array.isArray(rawToolCalls) &&
        Array.isArray(convertedToolCalls) &&
        convertedToolCalls.length > 0
      ) {
        const rawById = new Map<string, any>();
        for (const rt of rawToolCalls) {
          if (rt?.id && rt?.extra_content) rawById.set(rt.id, rt);
        }
        if (rawById.size > 0) {
          for (const ct of convertedToolCalls) {
            const raw = rawById.get(ct.id);
            if (raw?.extra_content) ct.extra_content = raw.extra_content;
          }
        }
      }
    }
    return result;
  };
  patched.__reasoningPatched = true;
  completionsModule.convertMessagesToCompletionsMessageParams = patched;
  return true;
}

/**
 * Agent role identifiers. Each corresponds to a trio of `*_MODEL`,
 * `*_API_KEY`, and `*_BASE_URL` env overrides (e.g. PLANNER_MODEL /
 * PLANNER_API_KEY / PLANNER_BASE_URL) that, when set, take precedence over
 * the shared LLM_MODEL / OPENAI_API_KEY / OPENAI_BASE_URL for that agent
 * only. This lets each agent use a different provider, not just a different
 * model — e.g. a cheap DeepSeek model for onboarding while the patcher runs
 * a strong OpenAI model.
 *
 * `analyzer` and `research` are kept for backward compatibility with the
 * now-unused IssueAnalyzerAgent and ResearchAgent files (dead code after
 * the merge into PlannerAgent, but still compiled by tsc).
 */
export type AgentRole =
  | 'planner'
  | 'patch_generator'
  | 'validation'
  | 'git'
  | 'onboarding'
  | 'analyzer'
  | 'research';

const AGENT_MODEL_ENV: Record<AgentRole, string> = {
  planner: 'PLANNER_MODEL',
  patch_generator: 'PATCH_GENERATOR_MODEL',
  validation: 'VALIDATION_MODEL',
  git: 'GIT_MODEL',
  onboarding: 'ONBOARDING_MODEL',
  analyzer: 'ANALYZER_MODEL',
  research: 'RESEARCH_MODEL',
};

/** Per-agent API key override — falls back to OPENAI_API_KEY when unset. */
const AGENT_API_KEY_ENV: Record<AgentRole, string> = {
  planner: 'PLANNER_API_KEY',
  patch_generator: 'PATCH_GENERATOR_API_KEY',
  validation: 'VALIDATION_API_KEY',
  git: 'GIT_API_KEY',
  onboarding: 'ONBOARDING_API_KEY',
  analyzer: 'ANALYZER_API_KEY',
  research: 'RESEARCH_API_KEY',
};

/** Per-agent base URL override — falls back to OPENAI_BASE_URL when unset. */
const AGENT_BASE_URL_ENV: Record<AgentRole, string> = {
  planner: 'PLANNER_BASE_URL',
  patch_generator: 'PATCH_GENERATOR_BASE_URL',
  validation: 'VALIDATION_BASE_URL',
  git: 'GIT_BASE_URL',
  onboarding: 'ONBOARDING_BASE_URL',
  analyzer: 'ANALYZER_BASE_URL',
  research: 'RESEARCH_BASE_URL',
};

// ─────────────────────────────────────────────────────────────────────────────
// Provider dispatch
//
// All providers expose the same BaseChatModel interface (bindTools, invoke,
// message round-trip), but each has provider-specific payload requirements
// that generic OpenAI-compat clients silently break (DeepSeek's
// reasoning_content round-trip, Gemini's thought_signature, Anthropic's
// Messages API being a different format entirely). Detecting the provider
// from the resolved base URL lets buildModel() construct the right
// provider-native LangChain class, which handles those requirements itself.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which provider-native LangChain class to construct for a given base URL.
 *
 * - `gemini`    → ChatGoogleGenerativeAI (native generateContent API;
 *                 round-trips thought_signature natively)
 * - `deepseek`  → ChatDeepSeek (native client; still needs the converter
 *                 patch for reasoning_content — see patch docs above)
 * - `anthropic` → ChatAnthropic (native Messages API — NOT OpenAI-compatible)
 * - `openai`    → ChatOpenAI (native OpenAI, OpenRouter, Ollama's
 *                 OpenAI-compatible endpoint, or any other OpenAI-compatible
 *                 gateway such as LiteLLM/vLLM)
 */
export type ProviderKind = 'openai' | 'gemini' | 'deepseek' | 'anthropic';

export function detectProviderKind(baseUrl?: string): ProviderKind {
  const url = (baseUrl ?? '').toLowerCase();
  if (url.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (url.includes('deepseek')) return 'deepseek';
  if (url.includes('anthropic')) return 'anthropic';
  return 'openai';
}

/**
 * Human-facing provider id inferred from a base URL — used by startup logs
 * and the dashboard settings API. Unlike ProviderKind (which selects the
 * LangChain class), this distinguishes the individual OpenAI-compatible
 * providers: OpenRouter, NVIDIA NIM, Z.AI (GLM), MiniMax, Xiaomi MiMo,
 * Kimi (Moonshot), and Grok (xAI) all route through ChatOpenAI but are
 * different services with different keys/pricing.
 */
export type ProviderLabelId =
  | 'openai'
  | 'ollama'
  | 'gemini'
  | 'deepseek'
  | 'anthropic'
  | 'openrouter'
  | 'nvidia'
  | 'zai'
  | 'minimax'
  | 'xiaomi'
  | 'kimi'
  | 'grok'
  | 'custom';

export function providerLabel(baseUrl?: string): ProviderLabelId {
  const url = (baseUrl ?? '').toLowerCase();
  if (url.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (url.includes('deepseek')) return 'deepseek';
  if (url.includes('anthropic')) return 'anthropic';
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('nvidia.com')) return 'nvidia';
  if (url.includes('z.ai') || url.includes('bigmodel.')) return 'zai';
  if (url.includes('minimax')) return 'minimax';
  if (url.includes('xiaomimimo.com') || url.includes('mimo.mi.com'))
    return 'xiaomi';
  if (url.includes('moonshot')) return 'kimi';
  if (url.includes('x.ai')) return 'grok';
  if (url.includes('ollama') || url.includes(':11434')) return 'ollama';
  if (!url) return 'openai';
  return 'custom';
}

/** Display names for logging each ProviderLabelId. */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderLabelId, string> = {
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Gemini (Google, native client)',
  deepseek: 'DeepSeek (native client)',
  anthropic: 'Anthropic (native client)',
  openrouter: 'OpenRouter',
  nvidia: 'NVIDIA NIM',
  zai: 'Z.AI (GLM)',
  minimax: 'MiniMax',
  xiaomi: 'Xiaomi MiMo',
  kimi: 'Kimi (Moonshot)',
  grok: 'Grok (xAI)',
  custom: 'Custom OpenAI-compatible',
};

@Injectable()
export class LlmService implements OnModuleInit {
  private readonly logger = new Logger(LlmService.name);
  private model: BaseChatModel;
  // True when the default model is any cloud provider (OpenAI/Gemini/DeepSeek/
  // Anthropic/OpenRouter/gateway) rather than the local Ollama fallback. Used
  // only by the onModuleInit health check to pick the logging branch.
  private usingOpenAI: boolean = false;
  /**
   * Cache of constructed models, keyed
   * `<scope>|<source>|<role>` where scope is an installation id, 'global',
   * or 'env' (unscoped env-only lookups) and source is 'byok' or 'env'.
   * One entry per distinct resolved configuration, so each installation
   * with its own BYOK config gets its own model instance while env-only
   * roles keep sharing the boot-time default.
   */
  private readonly modelCache = new Map<string, BaseChatModel>();

  /**
   * The BYOK (dashboard-submitted) config store. Optional so plain
   * `new LlmService()` (unit tests) keeps working without the DB-backed
   * provider; when absent, getModel() is purely env-driven, exactly as
   * before BYOK existed.
   */
  constructor(@Optional() private readonly llmConfigService?: LlmConfigService) {
    // Apply the reasoning_content patch before any ChatOpenAI/ChatDeepSeek
    // instance is used. Node.js caches require()d modules, so patching the
    // module export here affects all such instances in the process.
    // Fail LOUD if it cannot be applied: a silently unpatched converter means
    // DeepSeek thinking-mode and Gemini-via-proxy tool loops start failing
    // with 400s again, which is far better caught at startup.
    if (!patchLangChainReasoningContent()) {
      this.logger.error(
        'LangChain reasoning-content patch FAILED to apply — the @langchain/openai ' +
          'internal converter module could not be resolved. DeepSeek thinking-mode ' +
          'and Gemini-via-proxy multi-turn tool calls WILL fail with 400 errors. ' +
          'This usually means @langchain/openai changed its internal layout in a new ' +
          'version — update or remove patchLangChainReasoningContent() accordingly.',
      );
    }

    this.model = this.buildModel({ modelName: process.env.LLM_MODEL });
  }

  /**
   * Build a chat model from an explicit (or inherited) provider + model
   * configuration, dispatching to the provider-native LangChain class.
   *
   * - `modelName`: the model to use. Falls back to LLM_MODEL (cloud
   *   providers) or OLLAMA_LLM_MODEL (Ollama fallback).
   * - `apiKey` / `baseUrl`: the provider to use. Falls back to OPENAI_API_KEY /
   *   OPENAI_BASE_URL when unset. This is what lets a per-agent override point
   *   at a *different provider* (e.g. DeepSeek), not just a different model.
   *
   * Dispatch (detectProviderKind on the resolved baseUrl):
   *   - generativelanguage.googleapis.com → ChatGoogleGenerativeAI (native;
   *     handles Gemini 3 thought_signature round-trip itself. The
   *     `/v1beta/openai` suffix from the old OpenAI-compat configs is simply
   *     ignored — the native endpoint is used.)
   *   - api.deepseek.com → ChatDeepSeek (native; still needs the shared
   *     converter patch for reasoning_content)
   *   - api.anthropic.com → ChatAnthropic (native Messages API)
   *   - anything else / unset → ChatOpenAI (OpenAI, OpenRouter, Ollama's
   *     OpenAI-compatible endpoint, or any OpenAI-compatible gateway)
   *
   * If no API key resolves (neither the override nor OPENAI_API_KEY is set),
   * it falls back to Ollama via the local OpenAI-compatible endpoint.
   */
  private buildModel(options: {
    modelName?: string;
    apiKey?: string;
    baseUrl?: string;
  } = {}): BaseChatModel {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    const baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL;

    // If an API key resolves (override or shared), use it. Otherwise, default
    // to a local model (Ollama via OpenAI compatible endpoint).
    if (apiKey) {
      const resolved = options.modelName || process.env.LLM_MODEL;
      if (!resolved) {
        this.logger.warn(
          'No model name resolved — requests will fail. Please set LLM_MODEL in your .env',
        );
      }
      this.usingOpenAI = true;
      switch (detectProviderKind(baseUrl)) {
        case 'gemini': {
          this.logger.log(
            `Initialized native Google Gemini client (model: ${resolved})`,
          );
          return new ChatGoogleGenerativeAI({
            // Native classes require a string model; an unset LLM_MODEL is
            // already warned above and fails fast at request time.
            model: resolved ?? '',
            apiKey,
            temperature: 0,
          });
        }
        case 'deepseek': {
          this.logger.log(
            `Initialized native DeepSeek client (model: ${resolved})`,
          );
          return new ChatDeepSeek({
            model: resolved ?? '',
            apiKey,
            temperature: 0,
            ...(baseUrl
              ? { configuration: { baseURL: baseUrl } }
              : {}),
          });
        }
        case 'anthropic': {
          this.logger.log(
            `Initialized native Anthropic client (model: ${resolved})`,
          );
          return new ChatAnthropic({
            model: resolved ?? '',
            apiKey,
            temperature: 0,
            ...(baseUrl ? { anthropicApiUrl: baseUrl } : {}),
          });
        }
        default: {
          this.logger.log(
            `Initialized ChatOpenAI-compatible client with model: ${resolved}` +
              (baseUrl ? ` (baseURL: ${baseUrl})` : ''),
          );
          return new ChatOpenAI({
            modelName: resolved,
            temperature: 0,
            apiKey,
            configuration: {
              baseURL: baseUrl, // Supports OpenAI/OpenRouter/LiteLLM/vLLM/etc
            },
          });
        }
      }
    }

    // Fallback to Ollama using local OpenAI compatible endpoint
    const ollamaModel = options.modelName || process.env.OLLAMA_LLM_MODEL;
    if (!ollamaModel) {
      this.logger.warn('No OPENAI_API_KEY and OLLAMA_LLM_MODEL is not set — pipeline will fail. Please set OLLAMA_LLM_MODEL in your .env');
    }
    this.logger.warn(
      `No API key found — falling back to Ollama (model: ${ollamaModel}) at ${process.env.OLLAMA_HOST || 'http://localhost:11434'}`,
    );
    return new ChatOpenAI({
      modelName: ollamaModel,
      temperature: 0,
      apiKey: 'ollama', // dummy key
      configuration: {
        baseURL: process.env.OLLAMA_HOST
          ? `${process.env.OLLAMA_HOST}/v1`
          : 'http://localhost:11434/v1',
      },
    });
  }

  async onModuleInit() {
    // Perform a lightweight health check to warn early if the LLM backend is unreachable
    try {
      if (this.usingOpenAI) {
        // Detect actual provider from OPENAI_BASE_URL for accurate logging
        const baseUrl = process.env.OPENAI_BASE_URL || '';
        const label = PROVIDER_DISPLAY_NAMES[providerLabel(baseUrl)];
        const loggedLabel =
          label === 'Custom OpenAI-compatible' && baseUrl
            ? `${label} (${baseUrl})`
            : label;
        const model = process.env.LLM_MODEL;
        if (!model) {
          this.logger.warn(`LLM backend: ${loggedLabel} ⚠️ LLM_MODEL is not set — requests will fail. Please set LLM_MODEL in your .env`);
        } else {
          this.logger.log(`LLM backend: ${loggedLabel} | Model: ${model} ✅`);
        }
      } else {
        // Ollama: attempt a real connectivity check
        const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
        const response = await fetch(`${ollamaHost}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          this.logger.log(
            `LLM backend: Ollama ✅ (reachable at ${ollamaHost})`,
          );
        } else {
          this.logger.warn(
            `LLM backend: Ollama ⚠️ responded with status ${response.status} at ${ollamaHost}`,
          );
        }
      }
    } catch {
      const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
      this.logger.warn(
        `LLM backend: Ollama ❌ NOT reachable at ${ollamaHost} — pipeline will fail on first issue. ` +
        `Set OPENAI_API_KEY or ensure Ollama is running.`,
      );
    }
  }

  /**
   * Returns the chat model for the given agent role, optionally scoped to a
   * GitHub App installation (BYOK).
   *
   * Resolution for a scoped call, most specific first:
   *
   * 1. BYOK config — the installation's dashboard-submitted row, else the
   *    global BYOK row (see LlmConfigService). A resolved BYOK config fully
   *    replaces the env defaults for that scope, *including per-role env
   *    overrides*: a key the user just submitted through the UI is a more
   *    specific, more recent intent than static process env. One model
   *    instance serves every role under a BYOK config (roles share the same
   *    provider+model; bindTools() returns bound copies per agent anyway).
   * 2. Per-role env override — any of `<ROLE>_MODEL`, `<ROLE>_API_KEY`, or
   *    `<ROLE>_BASE_URL` set → a dedicated model for that role (this lets
   *    each agent use a *different provider*, not just a different model).
   * 3. Shared env default (LLM_MODEL / OLLAMA_LLM_MODEL fallback).
   *
   * Unscoped calls (no role, no installationId) return the boot-time default
   * unchanged, unless a global BYOK row has been primed.
   *
   * `installationId` is resolved synchronously from the cache primed by
   * primeForInstallation() — see LlmConfigService for why getModel stays
   * synchronous.
   */
  getModel(role?: AgentRole, installationId?: number | null): BaseChatModel {
    // BYOK lookup only when an installation scope is explicitly provided
    // (null = global scope, number = installation-specific). `undefined` means
    // truly unscoped (env-only) — e.g. boot-time health check or unit tests —
    // so we skip BYOK entirely and fall through to env resolution.
    const byok =
      installationId !== undefined
        ? (this.llmConfigService?.getResolvedConfig(installationId) ?? null)
        : null;

    if (!role && installationId === undefined && !byok) return this.model;

    const scopeKey =
      installationId === undefined ? 'env' : String(installationId);

    // Resolution order (most specific first):
    // 1. Per-agent provider assignment (agentAssignments[role] → provider config)
    // 2. Per-agent model-name override (agentModelOverrides[role] — same provider, different model)
    // 3. Shared BYOK default (byok.model + byok.apiKey + byok.baseUrl)
    // 4. Per-role env override
    // 5. Shared env default
    const agentAssignment =
      byok?.agentAssignments && role
        ? byok.agentAssignments[role]
        : undefined;
    const assignedProvider =
      agentAssignment && this.llmConfigService
        ? this.llmConfigService.getResolvedProvider(agentAssignment, installationId ?? null)
        : null;

    const agentOverride =
      byok?.agentModelOverrides && role
        ? byok.agentModelOverrides[role]
        : undefined;

    // Cache key: per-agent provider assignment gets its own key; model-name
    // override gets a per-role key; shared BYOK gets one key; env keys on role.
    const cacheKey = byok
      ? assignedProvider
        ? `${scopeKey}|byok|provider:${assignedProvider.id}|${role}`
        : agentOverride
          ? `${scopeKey}|byok|${role}`
          : `${scopeKey}|byok`
      : `${scopeKey}|env|${role ?? 'default'}`;
    const cached = this.modelCache.get(cacheKey);
    if (cached) return cached;

    let built: BaseChatModel;
    if (byok) {
      if (assignedProvider) {
        // Per-agent provider assignment: use a completely different provider
        // (key + baseUrl + model) for this agent.
        this.logger.log(
          `Agent role [${role ?? 'default'}] using assigned provider config ` +
            `(scope: ${byok.scope}, provider: ${providerLabel(assignedProvider.baseUrl ?? undefined)}, ` +
            `model: ${assignedProvider.model})`,
        );
        built = this.buildModel({
          modelName: assignedProvider.model,
          apiKey: assignedProvider.apiKey,
          baseUrl: assignedProvider.baseUrl ?? undefined,
        });
      } else {
        const effectiveModel = agentOverride ?? byok.model;
        this.logger.log(
          `Agent role [${role ?? 'default'}] using BYOK config ` +
            `(scope: ${byok.scope}, provider: ${providerLabel(byok.baseUrl ?? undefined)}, model: ${effectiveModel}` +
            (agentOverride ? ', override' : '') + ')',
        );
        built = this.buildModel({
          modelName: effectiveModel,
          apiKey: byok.apiKey,
          baseUrl: byok.baseUrl ?? undefined,
        });
      }
    } else {
      built = this.buildEnvModel(role);
    }
    this.modelCache.set(cacheKey, built);
    return built;
  }

  /**
   * The env-only resolution previously inlined in getModel(): per-role
   * overrides, else the shared default built at boot.
   */
  private buildEnvModel(role?: AgentRole): BaseChatModel {
    if (!role) return this.model;

    const modelOverride = process.env[AGENT_MODEL_ENV[role]];
    const apiKeyOverride = process.env[AGENT_API_KEY_ENV[role]];
    const baseUrlOverride = process.env[AGENT_BASE_URL_ENV[role]];

    // No override at all → shared default model.
    if (!modelOverride && !apiKeyOverride && !baseUrlOverride) {
      return this.model;
    }

    this.logger.log(
      `Agent role [${role}] using provider override: ` +
        `model=${modelOverride || process.env.LLM_MODEL || '(ollama)'} ` +
        `baseURL=${baseUrlOverride || process.env.OPENAI_BASE_URL || '(none)'}`,
    );
    return this.buildModel({
      modelName: modelOverride,
      apiKey: apiKeyOverride,
      baseUrl: baseUrlOverride,
    });
  }

  /**
   * Loads the BYOK config rows for an installation (exact + global) into the
   * LlmConfigService's in-memory cache, so subsequent getModel()/getProvider
   * Kind() calls for that scope resolve synchronously. Called once at the
   * start of every pipeline run; failures are non-fatal (env fallback).
   */
  async primeForInstallation(installationId?: number | null): Promise<void> {
    if (!this.llmConfigService) return;
    try {
      await this.llmConfigService.loadForInstallation(
        installationId ?? null,
      );
    } catch (e: any) {
      this.logger.warn(
        `Failed to prime BYOK LLM config (env defaults still apply): ${e?.message ?? e}`,
      );
    }
  }

  /**
   * Drops cached model instances after a BYOK config write/delete so the
   * next getModel() rebuilds with the new key/model. A global-scope change
   * (or an unspecified scope) clears everything — the global row is the
   * fallback for every installation.
   */
  invalidateInstallationModels(installationId?: number | null): void {
    if (installationId == null) {
      this.modelCache.clear();
      return;
    }
    const prefix = `${installationId}|`;
    for (const key of this.modelCache.keys()) {
      if (key.startsWith(prefix)) this.modelCache.delete(key);
    }
  }

  /**
   * Resolves which provider a role's model runs on, mirroring exactly the
   * resolution getModel() uses: a primed BYOK config for the scope (exact
   * installation row → global row) first, then the role's `<ROLE>_BASE_URL`
   * override, then OPENAI_BASE_URL.
   *
   * Agents use this to apply provider-specific message guards — e.g. Gemini
   * rejects request payloads that end with a text-only assistant turn, and
   * DeepSeek thinking mode can leak DSML markup into output text.
   */
  getProviderKind(role?: AgentRole, installationId?: number | null): ProviderKind {
    if (installationId !== undefined) {
      const byok = this.llmConfigService?.getResolvedConfig(installationId);
      if (byok) return detectProviderKind(byok.baseUrl ?? undefined);
    }
    const baseUrl = role
      ? process.env[AGENT_BASE_URL_ENV[role]] ?? process.env.OPENAI_BASE_URL
      : process.env.OPENAI_BASE_URL;
    return detectProviderKind(baseUrl);
  }

  /**
   * Logs token usage from an LLM response for telemetry/cost tracking.
   * LangChain's ChatOpenAI populates `usage_metadata` on the AIMessage when
   * the provider returns usage info (OpenAI, DeepSeek, Gemini via OpenRouter,
   * etc.). If the provider doesn't return usage info (e.g. some Ollama
   * setups), this is a no-op.
   */
  logTokenUsage(role: string, response: any): void {
    const usage =
      response?.usage_metadata ||
      response?.additional_kwargs?.usage ||
      response?.usage;
    if (!usage) return;
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens;
    const totalTokens = usage.total_tokens ?? usage.total_tokens;
    if (inputTokens == null && outputTokens == null) return;
    this.logger.log(
      `[${role}] tokens: ${inputTokens ?? '?'} in / ${outputTokens ?? '?'} out / ${totalTokens ?? '?'} total`,
    );
  }
}

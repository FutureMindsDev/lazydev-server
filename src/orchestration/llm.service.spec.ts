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

/* eslint-disable */
import { ChatOpenAI } from '@langchain/openai';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  LlmService,
  detectProviderKind,
  providerLabel,
} from './llm.service';
import type { ResolvedLlmConfig } from './llm-config.service';

/**
 * Reads the converter off the *internal* completions module — resolved by
 * absolute path, exactly like the patch does (see patchLangChainReasoningContent).
 * The package root's re-export is a copy of the original function reference
 * made at load time, so reading via the package root would never see the
 * patch; the internal module object is the one both the patch and
 * ChatOpenAI itself use.
 */
const getConverter = (): any => {
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
  return require(completionsPath).convertMessagesToCompletionsMessageParams;
};

describe('LlmService', () => {
  const ENV_KEYS = [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'LLM_MODEL',
    'OLLAMA_LLM_MODEL',
    'OLLAMA_HOST',
    'PLANNER_MODEL',
    'PLANNER_API_KEY',
    'PLANNER_BASE_URL',
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.LLM_MODEL = 'test-model';
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  // ── Monkey-patch: applied + round-trips provider fields ─────────────────

  describe('reasoning-content converter patch', () => {
    it('applies the patch on construction (fail-loud contract)', () => {
      new LlmService();
      const converter = getConverter() as any;
      expect(converter.__reasoningPatched).toBe(true);
    });

    it('is idempotent — a second LlmService does not double-wrap', () => {
      new LlmService();
      const first = getConverter() as any;
      new LlmService();
      const second = getConverter() as any;
      expect(second).toBe(first);
      expect(second.__reasoningPatched).toBe(true);
    });

    it('round-trips reasoning_content on assistant messages (DeepSeek thinking mode)', () => {
      new LlmService();
      const ai = new AIMessage({
        content: 'calling a tool',
        tool_calls: [
          { name: 'find_symbol', args: { name: 'AuthContext' }, id: 'call_1' },
        ],
        additional_kwargs: {
          reasoning_content: 'chain-of-thought here',
        },
      });
      const params = getConverter()({
        messages: [new HumanMessage('fix the bug'), ai],
        model: 'deepseek-chat',
      });
      const assistantParam = params.find((p: any) => p.role === 'assistant');
      expect(assistantParam.reasoning_content).toBe('chain-of-thought here');
    });

    it('round-trips extra_content on tool calls (Gemini thought_signature via proxy)', () => {
      new LlmService();
      const ai = new AIMessage({
        content: '',
        tool_calls: [
          { name: 'find_symbol', args: { name: 'AuthContext' }, id: 'call_1' },
          { name: 'read_file', args: { path: 'a.ts' }, id: 'call_2' },
        ],
        additional_kwargs: {
          // Raw tool calls as the OpenAI-compat proxy returns them — the
          // parsed tool_calls above do NOT carry extra_content.
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'find_symbol', arguments: '{}' },
              extra_content: {
                google: { thought_signature: 'SIG_1' },
              },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
              // no extra_content on this one — patch must not invent one
            },
          ] as any,
        },
      });
      const params = getConverter()({
        messages: [new HumanMessage('fix the bug'), ai],
        model: 'gemini-3-pro',
      });
      const assistantParam = params.find((p: any) => p.role === 'assistant');
      expect(assistantParam.tool_calls).toHaveLength(2);
      const byId = new Map(
        assistantParam.tool_calls.map((tc: any) => [tc.id, tc]),
      );
      expect((byId.get('call_1') as any).extra_content).toEqual({
        google: { thought_signature: 'SIG_1' },
      });
      expect((byId.get('call_2') as any).extra_content).toBeUndefined();
    });

    it('is a no-op for clean OpenAI messages (no invented fields)', () => {
      new LlmService();
      const ai = new AIMessage({
        content: 'done',
        tool_calls: [
          { name: 'find_symbol', args: { name: 'X' }, id: 'call_1' },
        ],
      });
      const params = getConverter()({
        messages: [new HumanMessage('hi'), ai],
        model: 'gpt-4o',
      });
      const assistantParam = params.find((p: any) => p.role === 'assistant');
      expect(assistantParam.reasoning_content).toBeUndefined();
      expect(assistantParam.tool_calls[0].extra_content).toBeUndefined();
    });
  });

  // ── Provider detection ───────────────────────────────────────────────────

  describe('detectProviderKind', () => {
    it('detects direct Gemini (incl. old /v1beta/openai compat URLs)', () => {
      expect(
        detectProviderKind(
          'https://generativelanguage.googleapis.com/v1beta/openai',
        ),
      ).toBe('gemini');
    });
    it('detects DeepSeek', () => {
      expect(detectProviderKind('https://api.deepseek.com')).toBe('deepseek');
    });
    it('detects Anthropic', () => {
      expect(detectProviderKind('https://api.anthropic.com')).toBe('anthropic');
    });
    it('routes OpenRouter to the OpenAI-compatible path', () => {
      expect(detectProviderKind('https://openrouter.ai/api/v1')).toBe('openai');
    });
    it('defaults to openai for unset or generic gateways', () => {
      expect(detectProviderKind(undefined)).toBe('openai');
      expect(detectProviderKind('http://litellm:4000/v1')).toBe('openai');
    });
  });

  // ─ buildModel dispatch (via getModel) ────────────────────────────────────

  describe('provider dispatch', () => {
    it('constructs ChatGoogleGenerativeAI for direct Gemini configs', () => {
      process.env.OPENAI_API_KEY = 'gemini-key';
      process.env.OPENAI_BASE_URL =
        'https://generativelanguage.googleapis.com/v1beta/openai';
      const svc = new LlmService();
      expect(svc.getModel()).toBeInstanceOf(ChatGoogleGenerativeAI);
    });

    it('constructs ChatDeepSeek for direct DeepSeek configs', () => {
      process.env.OPENAI_API_KEY = 'ds-key';
      process.env.OPENAI_BASE_URL = 'https://api.deepseek.com';
      const svc = new LlmService();
      expect(svc.getModel()).toBeInstanceOf(ChatDeepSeek);
    });

    it('constructs ChatAnthropic for direct Anthropic configs', () => {
      process.env.OPENAI_API_KEY = 'anthropic-key';
      process.env.OPENAI_BASE_URL = 'https://api.anthropic.com';
      const svc = new LlmService();
      expect(svc.getModel()).toBeInstanceOf(ChatAnthropic);
    });

    it('constructs ChatOpenAI for native OpenAI / OpenRouter / unset', () => {
      process.env.OPENAI_API_KEY = 'key';
      const svc = new LlmService();
      expect(svc.getModel()).toBeInstanceOf(ChatOpenAI);

      process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1';
      expect(new LlmService().getModel()).toBeInstanceOf(ChatOpenAI);
    });

    it('dispatches per-agent overrides independently of the default', () => {
      // Default: native OpenAI.
      process.env.OPENAI_API_KEY = 'openai-key';
      // Planner override: DeepSeek with its own key + base URL.
      process.env.PLANNER_MODEL = 'deepseek-chat';
      process.env.PLANNER_API_KEY = 'ds-key';
      process.env.PLANNER_BASE_URL = 'https://api.deepseek.com';
      const svc = new LlmService();
      expect(svc.getModel()).toBeInstanceOf(ChatOpenAI);
      expect(svc.getModel('planner')).toBeInstanceOf(ChatDeepSeek);
      // Untouched role inherits the default.
      expect(svc.getModel('validation')).toBeInstanceOf(ChatOpenAI);
    });

    it('falls back to Ollama (ChatOpenAI + ollama baseURL) without any key', () => {
      process.env.OLLAMA_LLM_MODEL = 'llama3';
      const svc = new LlmService();
      const model = svc.getModel() as ChatOpenAI;
      expect(model).toBeInstanceOf(ChatOpenAI);
      expect((model as any).apiKey).toBe('ollama');
    });
  });

  // ── Provider labels (OpenAI-compatible provider identification) ──────────

  describe('providerLabel', () => {
    it('labels every supported provider from its base URL', () => {
      expect(providerLabel(undefined)).toBe('openai');
      expect(providerLabel('')).toBe('openai');
      expect(providerLabel('https://openrouter.ai/api/v1')).toBe('openrouter');
      expect(providerLabel('https://integrate.api.nvidia.com/v1')).toBe('nvidia');
      expect(providerLabel('https://api.z.ai/api/paas/v4')).toBe('zai');
      expect(providerLabel('https://api.minimax.io/v1')).toBe('minimax');
      expect(providerLabel('https://api.minimaxi.com/v1')).toBe('minimax');
      expect(providerLabel('https://api.xiaomimimo.com/v1')).toBe('xiaomi');
      expect(providerLabel('https://api.moonshot.ai/v1')).toBe('kimi');
      expect(providerLabel('https://api.x.ai/v1')).toBe('grok');
      expect(providerLabel('https://generativelanguage.googleapis.com')).toBe('gemini');
      expect(providerLabel('https://api.deepseek.com')).toBe('deepseek');
      expect(providerLabel('https://api.anthropic.com')).toBe('anthropic');
      expect(providerLabel('http://localhost:11434/v1')).toBe('ollama');
    });

    it('falls back to custom for unknown OpenAI-compatible gateways', () => {
      expect(providerLabel('http://litellm:4000/v1')).toBe('custom');
      expect(providerLabel('https://my-gateway.example.com/v1')).toBe('custom');
    });
  });

  // ── BYOK (installation-scoped) model resolution ──────────────────────────

  describe('BYOK model resolution', () => {
    /** Mutable stub for LlmConfigService — getResolvedConfig returns `current`. */
    const stubConfigService = () => {
      const stub: {
        current: ResolvedLlmConfig | null;
        providers: Map<string, { apiKey: string; baseUrl: string | null; model: string }>;
        getResolvedConfig: (installationId?: number | null) => ResolvedLlmConfig | null;
        getResolvedProvider: (providerId: string, installationId?: number | null) => any;
      } = {
        current: null,
        providers: new Map(),
        getResolvedConfig: () => stub.current,
        getResolvedProvider: (providerId: string) => {
          const p = stub.providers.get(providerId);
          if (!p) return null;
          return { id: providerId, ...p };
        },
      };
      return stub;
    };

    const openrouterByok: ResolvedLlmConfig = {
      apiKey: 'sk-or-byok',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'qwen/qwen2.5-coder-32b-instruct',
      agentModelOverrides: null,
      agentAssignments: null,
      scope: 'installation',
    };

    it('builds the model from the installation BYOK config', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      const stub = stubConfigService();
      stub.current = openrouterByok;
      const svc = new LlmService(stub as any);

      const model = svc.getModel('planner', 42) as ChatOpenAI;
      expect(model).toBeInstanceOf(ChatOpenAI);
      expect((model as any).apiKey).toBe('sk-or-byok');
    });

    it('dispatches BYOK base URLs to provider-native clients', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      const stub = stubConfigService();
      stub.current = {
        apiKey: 'gemini-byok-key',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-flash',
        agentModelOverrides: null,
        agentAssignments: null,
        scope: 'global',
      };
      const svc = new LlmService(stub as any);
      expect(svc.getModel('planner', 42)).toBeInstanceOf(ChatGoogleGenerativeAI);
    });

    it('BYOK fully replaces env — including per-role env overrides', () => {
      // Env default: OpenAI. Planner env override: DeepSeek.
      process.env.OPENAI_API_KEY = 'openai-key';
      process.env.PLANNER_MODEL = 'deepseek-chat';
      process.env.PLANNER_API_KEY = 'ds-env-key';
      process.env.PLANNER_BASE_URL = 'https://api.deepseek.com';

      const stub = stubConfigService();
      stub.current = openrouterByok;
      const svc = new LlmService(stub as any);

      // Unscoped calls keep the env behaviour (DeepSeek override applies).
      expect(svc.getModel('planner')).toBeInstanceOf(ChatDeepSeek);
      // Scoped calls use the BYOK config instead.
      expect(svc.getModel('planner', 42)).toBeInstanceOf(ChatOpenAI);
    });

    it('shares one model instance across roles under a BYOK config', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      const stub = stubConfigService();
      stub.current = openrouterByok;
      const svc = new LlmService(stub as any);

      expect(svc.getModel('planner', 42)).toBe(
        svc.getModel('patch_generator', 42),
      );
    });

    it('getProviderKind follows the BYOK base URL', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      process.env.OPENAI_BASE_URL = 'https://api.deepseek.com';
      const stub = stubConfigService();
      stub.current = {
        apiKey: 'byok-key',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-flash',
        agentModelOverrides: null,
        agentAssignments: null,
        scope: 'installation',
      };
      const svc = new LlmService(stub as any);

      expect(svc.getProviderKind('planner', 42)).toBe('gemini');
      expect(svc.getProviderKind('planner')).toBe('deepseek');
    });

    it('falls back to env when no BYOK config is primed', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      const svc = new LlmService(stubConfigService() as any);
      expect(svc.getModel('planner', 42)).toBeInstanceOf(ChatOpenAI);
      expect((svc.getModel('planner', 42) as any).apiKey).toBe('env-key');
    });

    it('invalidateInstallationModels rebuilds with the new config', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      const stub = stubConfigService();
      stub.current = openrouterByok;
      const svc = new LlmService(stub as any);

      const before = svc.getModel('planner', 42);
      expect(before).toBeInstanceOf(ChatOpenAI);

      // Tenant switches to direct Gemini.
      stub.current = {
        apiKey: 'rotated-key',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-flash',
        agentModelOverrides: null,
        agentAssignments: null,
        scope: 'installation',
      };
      svc.invalidateInstallationModels(42);
      const after = svc.getModel('planner', 42);
      expect(after).toBeInstanceOf(ChatGoogleGenerativeAI);

      // Global-scope invalidation clears everything.
      svc.invalidateInstallationModels(null);
      expect(svc.getModel('planner', 42)).toBeInstanceOf(ChatGoogleGenerativeAI);
    });

    // ── Per-agent model overrides within a BYOK config ──────────────────

    it('uses the per-agent model override when one is set', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      const stub = stubConfigService();
      stub.current = {
        ...openrouterByok,
        model: 'qwen/qwen2.5-coder-32b-instruct',
        agentModelOverrides: { planner: 'anthropic/claude-3.5-sonnet' },
      };
      const svc = new LlmService(stub as any);

      // Planner gets the override model.
      const plannerModel = svc.getModel('planner', 42) as ChatOpenAI;
      expect(plannerModel).toBeInstanceOf(ChatOpenAI);
      expect((plannerModel as any).model).toBe('anthropic/claude-3.5-sonnet');
      // Still uses the BYOK provider's key.
      expect((plannerModel as any).apiKey).toBe('sk-or-byok');

      // Patch generator (no override) gets the shared BYOK model.
      const patcherModel = svc.getModel('patch_generator', 42) as ChatOpenAI;
      expect((patcherModel as any).model).toBe('qwen/qwen2.5-coder-32b-instruct');
    });

    it('gives each overridden role its own model instance', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      const stub = stubConfigService();
      stub.current = {
        ...openrouterByok,
        agentModelOverrides: {
          planner: 'anthropic/claude-3.5-sonnet',
          patch_generator: 'anthropic/claude-3.5-sonnet',
        },
      };
      const svc = new LlmService(stub as any);

      // Both overridden roles use the same model name, but since they have
      // the same override they share one instance (same cache key).
      const planner = svc.getModel('planner', 42);
      const patcher = svc.getModel('patch_generator', 42);
      // Different roles with different override values would get separate
      // instances; here they're the same model so they share.
      expect((planner as any).model).toBe('anthropic/claude-3.5-sonnet');
      expect((patcher as any).model).toBe('anthropic/claude-3.5-sonnet');

      // A role WITHOUT an override gets the shared BYOK model — a different
      // instance from the overridden roles.
      const validation = svc.getModel('validation', 42) as ChatOpenAI;
      expect((validation as any).model).toBe('qwen/qwen2.5-coder-32b-instruct');
      expect(validation).not.toBe(planner);
    });

    it('shares one instance across non-overridden roles', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      const stub = stubConfigService();
      stub.current = {
        ...openrouterByok,
        agentModelOverrides: { planner: 'strong-model' },
      };
      const svc = new LlmService(stub as any);

      // validation and onboarding have no override → share the BYOK default.
      expect(svc.getModel('validation', 42)).toBe(
        svc.getModel('onboarding', 42),
      );
    });

    // ── Per-agent provider assignments (multi-provider) ─────────────────

    it('uses the assigned provider config for an agent when one is set', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      const stub = stubConfigService();
      // Shared BYOK = OpenRouter. Planner is assigned to a DeepSeek provider.
      stub.current = {
        ...openrouterByok,
        agentAssignments: { planner: 'provider-deepseek-1' },
      };
      stub.providers.set('provider-deepseek-1', {
        apiKey: 'ds-provider-key',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
      });
      const svc = new LlmService(stub as any);

      // Planner uses the assigned DeepSeek provider (different key + URL + model).
      const plannerModel = svc.getModel('planner', 42);
      expect(plannerModel).toBeInstanceOf(ChatDeepSeek);
      expect((plannerModel as any).apiKey).toBe('ds-provider-key');

      // Patch generator (no assignment) uses the shared BYOK provider.
      const patcherModel = svc.getModel('patch_generator', 42) as ChatOpenAI;
      expect(patcherModel).toBeInstanceOf(ChatOpenAI);
      expect((patcherModel as any).apiKey).toBe('sk-or-byok');
      expect((patcherModel as any).model).toBe('qwen/qwen2.5-coder-32b-instruct');
    });

    it('falls back to shared BYOK when the assigned provider is not found', () => {
      process.env.OPENAI_API_KEY = 'env-key';
      const stub = stubConfigService();
      stub.current = {
        ...openrouterByok,
        agentAssignments: { planner: 'nonexistent-provider' },
      };
      // No provider registered under 'nonexistent-provider' → falls back.
      const svc = new LlmService(stub as any);

      const plannerModel = svc.getModel('planner', 42) as ChatOpenAI;
      expect(plannerModel).toBeInstanceOf(ChatOpenAI);
      expect((plannerModel as any).apiKey).toBe('sk-or-byok');
    });
  });
});

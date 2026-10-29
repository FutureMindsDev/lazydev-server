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
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  DecisionProviderId,
  DecisionQuestion,
  DecisionResult,
} from './decision.dto';
import { ClefProvider } from './providers/clef.provider';
import { JevProvider } from './providers/jev.provider';
import { LlmJudgeProvider } from './providers/llm-judge.provider';

/** Gate names for per-gate provider overrides (DECISION_PROVIDER_TRIAGE…). */
export type DecisionGate = 'guard' | 'triage' | 'patch' | 'validation';

const KNOWN_PROVIDERS: DecisionProviderId[] = [
  'clef-workers',
  'clef-local',
  'jev-typesafe',
  'jev-vercel',
  'jev-openrouter',
  'laya-local',
  'openjev-local',
  'llm-judge',
];

/** Local-weight backends need a Python sidecar that does not exist yet —
 *  asking for one is a clear error (which the fallback chain catches),
 *  never a silent wrong answer. */
const NOT_IMPLEMENTED: DecisionProviderId[] = [
  'clef-local',
  'laya-local',
  'openjev-local',
];

/** New single selector (DECISION_MODEL) accepts family shortcuts too. */
const DECISION_MODEL_ALIASES: Record<string, DecisionProviderId> = {
  clef: 'clef-workers',
  'clef-flash': 'clef-workers',
  jev: 'jev-typesafe',
  llm: 'llm-judge',
  judge: 'llm-judge',
};

/** Redis key for the dashboard Clef toggle. Absent = follow the env. */
const CLEF_FLAG_KEY = 'settings:guard:clef';

@Injectable()
export class DecisionProviderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DecisionProviderService.name);
  private readonly redis: Redis;
  /** Providers that have answered at least once this process (log once). */
  private readonly connected = new Set<DecisionProviderId>();

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD') || undefined,
      maxRetriesPerRequest: 2,
    });
    this.redis.on('error', (err: Error) => {
      this.logger.warn(
        `Decision flag Redis error: ${err.message || String(err).slice(0, 120)}`,
      );
    });
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  /**
   * Boot-time visibility for the System One layer: who serves each gate,
   * whether the Clef switch and credentials are usable, and — when Clef is
   * actually on — one tiny smoke request so "connected" is a fact, not a
   * guess. Never throws: a dead provider degrades to the caller's heuristic.
   */
  async onModuleInit(): Promise<void> {
    const gates: DecisionGate[] = ['guard', 'triage', 'patch', 'validation'];
    const routes = gates.map((g) => `${g}=${this.resolveProviderId(g)}`).join(', ');
    const fallback = this.resolveFallbackId();
    const decisionEnabled = await this.isDecisionEnabled();
    const clefEnabled = await this.isClefEnabled();
    const clefConfigured = this.areClefCredsPresent();
    const clefModel = this.clefModelName();

    this.logger.log(
      `System One decision layer — master=${decisionEnabled ? 'on' : 'off'}, ` +
        `model=${this.decisionModelSetting()} (${routes}); fallback=${fallback}; ` +
        `Clef: ${clefEnabled ? 'enabled' : 'disabled'}` +
        (clefEnabled
          ? ` (model=${clefModel}, creds ${clefConfigured ? 'present' : 'MISSING'})`
          : ''),
    );

    if (!decisionEnabled) {
      this.logger.log(
        'System One: decision models are off (DECISION_MODEL_ENABLED=false) — ' +
          'regex + local heuristics only.',
      );
      return;
    }

    // Say explicitly which providers get a real boot probe (Clef only — it
    // is free) and which log "connected" on their first real call. Keeps
    // "no connected line" from being mistaken for "provider is broken".
    const active = [
      ...new Set(gates.flatMap((g) => this.providerChain(g, clefEnabled))),
    ];
    const bootProbe = clefEnabled && clefConfigured ? ['clef-workers'] : [];
    const firstUse = active.filter((id) => !bootProbe.includes(id));
    if (active.length === 0) {
      this.logger.warn(
        'System One: no provider candidates — Clef is off and the fallback is ' +
          'also Clef. Gates will use their local heuristics.',
      );
    } else {
      this.logger.log(
        'System One connectivity — ' +
          `boot probe: ${bootProbe.length ? 'clef-workers (free tier)' : 'none'}; ` +
          `"connected" on first real call: ${
            firstUse.length ? firstUse.join(', ') : 'none (Clef already probed)'
          }`,
      );
    }

    if (!clefEnabled) {
      this.logger.log(
        'System One: Clef is off — clef-workers is excluded from every chain; ' +
          'the configured non-Clef providers still run.',
      );
      return;
    }
    if (!clefConfigured) {
      const clefPrimary = gates.some(
        (g) => this.resolveProviderId(g) === 'clef-workers',
      );
      if (clefPrimary) {
        this.logger.warn(
          'System One: Clef serves at least one gate but CLOUDFLARE_ACCOUNT_ID/' +
            'CLOUDFLARE_API_TOKEN are missing — those calls will fail and fall back. ' +
            'Set them or pick another DECISION_MODEL.',
        );
      } else {
        this.logger.log(
          'System One: Clef has no credentials — it is only an implicit fallback ' +
            'and will be skipped if the primary fails.',
        );
      }
      return;
    }

    // Smoke test: one noul question with a short timeout and no fallback
    // chain — proves account/token/model work without exercising gate logic.
    try {
      await new ClefProvider({
        accountId: this.configService.get<string>('CLOUDFLARE_ACCOUNT_ID', ''),
        apiToken: this.configService.get<string>('CLOUDFLARE_API_TOKEN', ''),
        model: clefModel,
        timeoutMs: 5000,
      }).decide('System One startup health check.', [
        { id: 'ok', type: 'bool', text: 'Is this a health check?' },
      ]);
      this.logger.log(`System One [CLEF-WORKERS/${clefModel}] connected successfully ✅`);
    } catch (e: any) {
      this.logger.warn(
        `System One [CLEF-WORKERS/${clefModel}] smoke-test failed: ${e.message} — ` +
          'gates will fall back until this recovers.',
      );
    }
  }

  private clefModelName(): 'clef' | 'clef-flash' {
    return this.configService.get<string>('PROMPT_GUARD_MODEL', 'clef-flash') === 'clef'
      ? 'clef'
      : 'clef-flash';
  }

  /** Ordered provider candidates for one gate: primary → free Clef tier
   *  (skipped when disabled) → explicitly configured fallback. Shared by
   *  decide() and the boot log so the two can never disagree. */
  private providerChain(
    gate: DecisionGate,
    clefEnabled: boolean,
  ): DecisionProviderId[] {
    const candidates: DecisionProviderId[] = [];
    const add = (id: DecisionProviderId) => {
      if (id === 'clef-workers' && !clefEnabled) return;
      if (!candidates.includes(id)) candidates.push(id);
    };
    add(this.resolveProviderId(gate));
    // The free Clef tier is the implicit fallback. Skipped when the operator
    // turned Clef off (the explicit fallback below still runs).
    add('clef-workers');
    // Paid-capable fallback runs ONLY on explicit opt-in. resolveFallbackId
    // returns clef-workers unless DECISION_FALLBACK names something else,
    // so a non-Clef value here means the operator chose it.
    add(this.resolveFallbackId());
    return candidates;
  }

  /** Which provider serves this gate. Order: per-gate env override →
   *  DECISION_MODEL (single selector; family aliases allowed) →
   *  legacy DECISION_PROVIDER → built-in default. Unknown ids warn + default. */
  resolveProviderId(gate?: DecisionGate): DecisionProviderId {
    const fallbackDefault: DecisionProviderId = 'clef-workers';
    const candidates = [
      gate ? this.configService.get<string>(`DECISION_PROVIDER_${gate.toUpperCase()}`) : undefined,
      this.configService.get<string>('DECISION_MODEL'),
      this.configService.get<string>('DECISION_PROVIDER'),
    ];
    for (const raw of candidates) {
      const setting = (raw || '').trim();
      if (!setting) continue;
      const id = (DECISION_MODEL_ALIASES[setting.toLowerCase()] ??
        setting) as DecisionProviderId;
      if (KNOWN_PROVIDERS.includes(id)) return id;
      this.logger.warn(
        `Unknown decision model "${setting}" — falling back to ${fallbackDefault}.`,
      );
      return fallbackDefault;
    }
    return fallbackDefault;
  }

  /** Raw selector for logs/status: DECISION_MODEL, else legacy provider id. */
  decisionModelSetting(): string {
    return (
      this.configService.get<string>('DECISION_MODEL') ||
      this.configService.get<string>('DECISION_PROVIDER') ||
      'clef-workers'
    ).trim();
  }

  /** Fallback provider id: explicit DECISION_FALLBACK wins, otherwise the
   *  free Clef tier (never a paid model unless the operator opts in). */
  resolveFallbackId(): DecisionProviderId {
    const raw = (this.configService.get<string>('DECISION_FALLBACK') || '').trim();
    if (raw && (KNOWN_PROVIDERS as string[]).includes(raw)) {
      return raw as DecisionProviderId;
    }
    return 'clef-workers';
  }

  private buildProvider(id: DecisionProviderId) {
    switch (id) {
      case 'clef-workers':
        return new ClefProvider({
          accountId: this.configService.get<string>('CLOUDFLARE_ACCOUNT_ID', ''),
          apiToken: this.configService.get<string>('CLOUDFLARE_API_TOKEN', ''),
          model: this.clefModelName(),
        });
      case 'jev-typesafe':
      case 'jev-vercel':
      case 'jev-openrouter':
        return new JevProvider(
          {
            apiKey: this.configService.get<string>('TYPESAFE_API_KEY', ''),
            endpoint: this.configService.get<string>('JEV_ENDPOINT') || undefined,
          },
          id,
        );
      case 'llm-judge':
        return new LlmJudgeProvider({
          apiKey: this.configService.get<string>('OPENAI_API_KEY', ''),
          baseUrl: this.configService.get<string>('OPENAI_BASE_URL') || undefined,
          model:
            this.configService.get<string>('JUDGE_MODEL') ||
            this.configService.get<string>('LLM_MODEL') ||
            undefined,
          // Reasoning models on remote gateways routinely need >30s; a
          // timeout here silently degrades every gate to its heuristic.
          timeoutMs:
            Number(this.configService.get<string>('JUDGE_TIMEOUT_MS', '60000')) ||
            60000,
        });
      default:
        // clef-local / laya-local / openjev-local: no sidecar yet.
        throw new Error(
          `Decision provider "${id}" needs a local-model sidecar that is not built yet. Pick another provider.`,
        );
    }
  }

  /**
   * Ask providers in order, free first: primary → free Clef tier (unless
   * it WAS the primary) → explicit paid fallback (only when the operator
   * set DECISION_FALLBACK). If everything fails, throw so the caller can
   * apply its own free last resort (regex-only / old heuristic).
   * Default = free: no surprise LLM bills, ever.
   *
   * Clef is skipped entirely when disabled (PROMPT_GUARD_CLEF_ENABLED=false
   * or the dashboard toggle is off) — the switch must gate every Clef call,
   * not just the prompt guard, or "disabled" is a lie.
   */
  async decide(
    gate: DecisionGate,
    state: string,
    questions: DecisionQuestion[],
  ): Promise<DecisionResult> {
    if (!(await this.isDecisionEnabled())) {
      throw new Error(
        'Decision models are disabled (DECISION_MODEL_ENABLED=false) — ' +
          'gates fall back to regex/heuristics.',
      );
    }
    const clefEnabled = await this.isClefEnabled();
    const candidates = this.providerChain(gate, clefEnabled);

    if (candidates.length === 0) {
      throw new Error(
        'Clef is disabled and no alternative decision provider is configured. ' +
          'Set DECISION_PROVIDER / DECISION_FALLBACK to a non-Clef provider.',
      );
    }
    if (!clefEnabled) {
      this.logger.debug('Clef is disabled — skipping clef-workers provider.');
    }

    let lastError: unknown = new Error('No decision provider available.');
    for (const id of candidates) {
      // One quick retry for provider-side overload/throttling (429/5xx).
      // Gateways return these transiently; immediately degrading the gate to
      // a heuristic makes the pipeline look broken when nothing is wrong.
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await this.buildProvider(id).decide(state, questions);
          if (!this.connected.has(result.providerId)) {
            this.connected.add(result.providerId);
            this.logger.log(
              `System One [${result.providerId.toUpperCase()}] connected ✅ ` +
                `(answered a ${gate} decision).`,
            );
          } else {
            this.logger.debug(`Decision (${gate}) served by ${result.providerId}.`);
          }
          return result;
        } catch (e: any) {
          lastError = e;
          const transient = /HTTP (429|500|502|503|504)/i.test(e.message || '');
          if (transient && attempt < 1) {
            this.logger.warn(
              `Decision provider ${id} temporarily unavailable (${gate}): ${e.message}. Retrying once.`,
            );
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          this.logger.warn(
            `Decision provider ${id} failed (${gate}): ${e.message}.`,
          );
          break;
        }
      }
    }
    throw lastError;
  }

  /** Single master switch: DECISION_MODEL_ENABLED. Falls back to the
   *  legacy Clef-only switch so existing .env files keep working. Default off. */
  isDecisionEnabledByEnv(): boolean {
    const master = (this.configService.get<string>('DECISION_MODEL_ENABLED') || '')
      .trim()
      .toLowerCase();
    if (master === 'true') return true;
    if (master === 'false') return false;
    return (
      (this.configService.get<string>('PROMPT_GUARD_CLEF_ENABLED') || '')
        .trim()
        .toLowerCase() === 'true'
    );
  }

  /** Effective master switch (env today; storage-free on purpose). */
  async isDecisionEnabled(): Promise<boolean> {
    return this.isDecisionEnabledByEnv();
  }

  /** Clef is allowed when the master switch is on. When the master is on,
   *  a legacy PROMPT_GUARD_CLEF_ENABLED=false still opts Clef out (per-model
   *  switch), while an absent legacy value follows the master. */
  isClefEnabledByEnv(): boolean {
    if (!this.isDecisionEnabledByEnv()) return false;
    const legacy = (this.configService.get<string>('PROMPT_GUARD_CLEF_ENABLED') || '')
      .trim()
      .toLowerCase();
    return legacy === '' ? true : legacy === 'true';
  }

  /** Effective switch = env AND stored flag (absent stored flag = follow env). */
  async isClefEnabled(): Promise<boolean> {
    if (!this.isClefEnabledByEnv()) return false;
    try {
      const stored = await this.redis.get(CLEF_FLAG_KEY);
      if (stored === 'false') return false;
    } catch (e: any) {
      this.logger.warn(`Could not read Clef flag, following env: ${e.message}`);
    }
    return true;
  }

  async setClefEnabled(on: boolean): Promise<boolean> {
    try {
      await this.redis.set(CLEF_FLAG_KEY, on ? 'true' : 'false');
    } catch (e: any) {
      this.logger.warn(`Could not persist Clef flag: ${e.message}`);
      if (on) throw new Error('Could not save the toggle (Redis unavailable).');
    }
    return this.isClefEnabled();
  }

  areClefCredsPresent(): boolean {
    return Boolean(
      (this.configService.get<string>('CLOUDFLARE_ACCOUNT_ID') || '').trim() &&
        (this.configService.get<string>('CLOUDFLARE_API_TOKEN') || '').trim(),
    );
  }

  /** Status object for GET settings + meta (never includes the token). */
  async getGuardStatus(): Promise<{
    regexAlwaysOn: boolean;
    decisionEnabled: boolean;
    decisionModel: string;
    clefEnabled: boolean;
    clefConfigured: boolean;
    clefModel: string;
    blockAt: number;
    quarantineAt: number;
    provider: DecisionProviderId;
    fallback: DecisionProviderId;
  }> {
    const num = (v: string | undefined, d: number) => {
      const n = parseFloat(v || '');
      return Number.isFinite(n) ? n : d;
    };
    return {
      regexAlwaysOn: true,
      decisionEnabled: await this.isDecisionEnabled(),
      decisionModel: this.decisionModelSetting(),
      clefEnabled: await this.isClefEnabled(),
      clefConfigured: this.areClefCredsPresent(),
      clefModel: this.clefModelName(),
      blockAt: num(this.configService.get<string>('PROMPT_GUARD_BLOCK_AT'), 0.8),
      quarantineAt: num(this.configService.get<string>('PROMPT_GUARD_QUARANTINE_AT'), 0.4),
      provider: this.resolveProviderId('guard'),
      fallback: this.resolveFallbackId(),
    };
  }
}

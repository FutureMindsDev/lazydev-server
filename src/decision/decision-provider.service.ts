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
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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

/** Redis key for the dashboard Clef toggle. Absent = follow the env. */
const CLEF_FLAG_KEY = 'settings:guard:clef';

@Injectable()
export class DecisionProviderService implements OnModuleDestroy {
  private readonly logger = new Logger(DecisionProviderService.name);
  private readonly redis: Redis;

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

  /** Which provider serves this gate. Order: per-gate env override →
   *  DECISION_PROVIDER → built-in default. Unknown ids warn + default. */
  resolveProviderId(gate?: DecisionGate): DecisionProviderId {
    const fallbackDefault: DecisionProviderId = 'clef-workers';
    const candidates = [
      gate ? this.configService.get<string>(`DECISION_PROVIDER_${gate.toUpperCase()}`) : undefined,
      this.configService.get<string>('DECISION_PROVIDER'),
    ];
    for (const raw of candidates) {
      const id = (raw || '').trim() as DecisionProviderId;
      if (!id) continue;
      if (KNOWN_PROVIDERS.includes(id)) return id;
      this.logger.warn(
        `Unknown decision provider "${id}" — falling back to ${fallbackDefault}.`,
      );
      return fallbackDefault;
    }
    return fallbackDefault;
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
          model: this.configService.get<string>('PROMPT_GUARD_MODEL', 'clef-flash'),
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
   */
  async decide(
    gate: DecisionGate,
    state: string,
    questions: DecisionQuestion[],
  ): Promise<DecisionResult> {
    const primary = this.resolveProviderId(gate);
    const candidates: DecisionProviderId[] = [primary];
    if (primary !== 'clef-workers') candidates.push('clef-workers');
    const explicit = this.resolveFallbackId();
    if (explicit !== 'clef-workers' && !candidates.includes(explicit)) {
      // Paid-capable fallback runs ONLY on explicit opt-in. resolveFallbackId
      // returns clef-workers unless DECISION_FALLBACK names something else,
      // so reaching here means the operator chose it.
      candidates.push(explicit);
    }
    let lastError: unknown = new Error('No decision provider available.');
    for (const id of candidates) {
      try {
        const result = await this.buildProvider(id).decide(state, questions);
        this.logger.debug(`Decision (${gate}) served by ${result.providerId}.`);
        return result;
      } catch (e: any) {
        this.logger.warn(
          `Decision provider ${id} failed (${gate}): ${e.message}.`,
        );
        lastError = e;
      }
    }
    throw lastError;
  }

  /** Env master switch (default off). Env false ALWAYS wins over storage. */
  isClefEnabledByEnv(): boolean {
    return (
      (this.configService.get<string>('PROMPT_GUARD_CLEF_ENABLED') || '')
        .trim()
        .toLowerCase() === 'true'
    );
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
      clefEnabled: await this.isClefEnabled(),
      clefConfigured: this.areClefCredsPresent(),
      clefModel: this.configService.get<string>('PROMPT_GUARD_MODEL', 'clef-flash'),
      blockAt: num(this.configService.get<string>('PROMPT_GUARD_BLOCK_AT'), 0.8),
      quarantineAt: num(this.configService.get<string>('PROMPT_GUARD_QUARANTINE_AT'), 0.4),
      provider: this.resolveProviderId('guard'),
      fallback: this.resolveFallbackId(),
    };
  }
}

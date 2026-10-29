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
import { DecisionProviderService } from './decision-provider.service';
import { parseClefAnswer } from './providers/clef.provider';
import { extractJsonObject } from './providers/llm-judge.provider';

/** Minimal ConfigService stand-in: plain object lookup. */
function fakeConfig(values: Record<string, string>) {
  return {
    get: (key: string, fallback?: any) => values[key] ?? fallback,
  } as any;
}

describe('DecisionProviderService', () => {
  describe('resolveProviderId', () => {
    it('defaults to clef-workers', () => {
      const svc = new DecisionProviderService(fakeConfig({}));
      expect(svc.resolveProviderId('guard')).toBe('clef-workers');
      void svc.onModuleDestroy();
    });

    it('boots (and logs status) without calling a provider when the master switch is off', async () => {
      const svc = new DecisionProviderService(
        fakeConfig({ DECISION_MODEL_ENABLED: 'false' }),
      );
      // Master off must short-circuit before any Redis read or HTTP call.
      await expect(svc.onModuleInit()).resolves.toBeUndefined();
      void svc.onModuleDestroy();
    });

    it('prefers per-gate override, then DECISION_PROVIDER', () => {
      const svc = new DecisionProviderService(
        fakeConfig({ DECISION_PROVIDER: 'jev-typesafe', DECISION_PROVIDER_TRIAGE: 'llm-judge' }),
      );
      expect(svc.resolveProviderId('triage')).toBe('llm-judge');
      expect(svc.resolveProviderId('guard')).toBe('jev-typesafe');
      void svc.onModuleDestroy();
    });

    it('falls back on unknown ids', () => {
      const svc = new DecisionProviderService(fakeConfig({ DECISION_PROVIDER: 'nope' }));
      expect(svc.resolveProviderId()).toBe('clef-workers');
      void svc.onModuleDestroy();
    });
  });

  describe('env switch', () => {
    it('isClefEnabledByEnv defaults to false', () => {
      const svc = new DecisionProviderService(fakeConfig({}));
      expect(svc.isClefEnabledByEnv()).toBe(false);
      void svc.onModuleDestroy();
    });

    it('reads true case-insensitively', () => {
      const svc = new DecisionProviderService(
        fakeConfig({ PROMPT_GUARD_CLEF_ENABLED: ' True ' }),
      );
      expect(svc.isClefEnabledByEnv()).toBe(true);
      void svc.onModuleDestroy();
    });

    it('DECISION_MODEL_ENABLED is the single master switch', () => {
      const on = new DecisionProviderService(
        fakeConfig({ DECISION_MODEL_ENABLED: 'true' }),
      );
      expect(on.isDecisionEnabledByEnv()).toBe(true);
      // Master on + no legacy opt-out → Clef allowed.
      expect(on.isClefEnabledByEnv()).toBe(true);
      void on.onModuleDestroy();

      const off = new DecisionProviderService(
        fakeConfig({
          DECISION_MODEL_ENABLED: 'false',
          // Legacy Clef switch must NOT override the new master.
          PROMPT_GUARD_CLEF_ENABLED: 'true',
        }),
      );
      expect(off.isDecisionEnabledByEnv()).toBe(false);
      expect(off.isClefEnabledByEnv()).toBe(false);
      void off.onModuleDestroy();
    });

    it('legacy PROMPT_GUARD_CLEF_ENABLED still works when the master is absent', () => {
      const svc = new DecisionProviderService(
        fakeConfig({ PROMPT_GUARD_CLEF_ENABLED: 'true' }),
      );
      expect(svc.isDecisionEnabledByEnv()).toBe(true);
      void svc.onModuleDestroy();
    });

    it('legacy PROMPT_GUARD_CLEF_ENABLED=false only opts Clef out', () => {
      const svc = new DecisionProviderService(
        fakeConfig({
          DECISION_MODEL_ENABLED: 'true',
          PROMPT_GUARD_CLEF_ENABLED: 'false',
        }),
      );
      expect(svc.isDecisionEnabledByEnv()).toBe(true);
      expect(svc.isClefEnabledByEnv()).toBe(false);
      void svc.onModuleDestroy();
    });
  });

  describe('DECISION_MODEL selector', () => {
    it('accepts family aliases and full provider ids', () => {
      const clef = new DecisionProviderService(fakeConfig({ DECISION_MODEL: 'clef' }));
      expect(clef.resolveProviderId('guard')).toBe('clef-workers');
      void clef.onModuleDestroy();

      const jev = new DecisionProviderService(fakeConfig({ DECISION_MODEL: 'jev' }));
      expect(jev.resolveProviderId('triage')).toBe('jev-typesafe');
      void jev.onModuleDestroy();

      const judge = new DecisionProviderService(fakeConfig({ DECISION_MODEL: 'llm-judge' }));
      expect(judge.resolveProviderId()).toBe('llm-judge');
      void judge.onModuleDestroy();

      const full = new DecisionProviderService(
        fakeConfig({ DECISION_MODEL: 'jev-openrouter' }),
      );
      expect(full.resolveProviderId('patch')).toBe('jev-openrouter');
      void full.onModuleDestroy();
    });

    it('wins over the legacy DECISION_PROVIDER; per-gate overrides win over both', () => {
      const svc = new DecisionProviderService(
        fakeConfig({
          DECISION_MODEL: 'jev',
          DECISION_PROVIDER: 'llm-judge',
          DECISION_PROVIDER_GUARD: 'clef-workers',
        }),
      );
      expect(svc.resolveProviderId('triage')).toBe('jev-typesafe');
      expect(svc.resolveProviderId('guard')).toBe('clef-workers');
      void svc.onModuleDestroy();
    });
  });

  describe('decide fallback chain', () => {
    it('falls back when primary is unconfigured, then throws for last resort', async () => {
      const svc = new DecisionProviderService(
        fakeConfig({ DECISION_MODEL_ENABLED: 'true' }),
      );
      // clef-workers has no creds here AND llm-judge has no key → throws,
      // so the caller can apply regex-only / old heuristic.
      await expect(
        svc.decide('guard', 'some state', [{ id: 'q', type: 'bool', text: 'bad?' }]),
      ).rejects.toThrow();
      void svc.onModuleDestroy();
    });

    it('refuses to call any provider when the master switch is off', async () => {
      const svc = new DecisionProviderService(
        fakeConfig({
          DECISION_MODEL_ENABLED: 'false',
          DECISION_MODEL: 'jev',
          DECISION_FALLBACK: 'llm-judge',
        }),
      );
      await expect(
        svc.decide('guard', 's', [{ id: 'q', type: 'bool', text: 't' }]),
      ).rejects.toThrow(/DECISION_MODEL_ENABLED/);
      void svc.onModuleDestroy();
    });

    it('local-weight ids fail with a clear not-built error', async () => {
      const svc = new DecisionProviderService(
        fakeConfig({
          DECISION_MODEL_ENABLED: 'true',
          DECISION_PROVIDER: 'laya-local',
        }),
      );
      await expect(
        svc.decide('guard', 's', [{ id: 'q', type: 'bool', text: 't' }]),
      ).rejects.toThrow();
      void svc.onModuleDestroy();
    });

    it('free-first: paid primary falls back to clef, never llm-judge', async () => {
      const svc = new DecisionProviderService(
        fakeConfig({
          DECISION_MODEL_ENABLED: 'true',
          DECISION_PROVIDER: 'jev-typesafe',
        }),
      );
      jest.spyOn(svc, 'isClefEnabled').mockResolvedValue(true);
      // jev (no key) → clef-workers (no creds) → throw. The error must
      // come from Clef, proving llm-judge was never touched implicitly.
      await expect(
        svc.decide('guard', 's', [{ id: 'q', type: 'bool', text: 't' }]),
      ).rejects.toThrow(/CLOUDFLARE/i);
      void svc.onModuleDestroy();
    });

    it('explicit DECISION_FALLBACK=llm-judge opts into the paid fallback', async () => {
      const svc = new DecisionProviderService(
        fakeConfig({
          DECISION_MODEL_ENABLED: 'true',
          DECISION_PROVIDER: 'laya-local',
          DECISION_FALLBACK: 'llm-judge',
        }),
      );
      jest.spyOn(svc, 'isClefEnabled').mockResolvedValue(true);
      // laya (not built) → clef (no creds) → llm-judge (no key) → throw
      // with the llm-judge error, proving explicit opt-in runs it.
      await expect(
        svc.decide('guard', 's', [{ id: 'q', type: 'bool', text: 't' }]),
      ).rejects.toThrow(/OPENAI_API_KEY/);
      void svc.onModuleDestroy();
    });

    it('skips Clef entirely when the legacy Clef switch opts it out', async () => {
      const svc = new DecisionProviderService(
        fakeConfig({
          DECISION_MODEL_ENABLED: 'true',
          PROMPT_GUARD_CLEF_ENABLED: 'false',
          DECISION_PROVIDER: 'clef-workers',
          DECISION_FALLBACK: 'llm-judge',
        }),
      );
      // Clef would fail with CLOUDFLARE (no creds); the llm-judge error
      // proves the disabled provider was never attempted.
      await expect(
        svc.decide('guard', 's', [{ id: 'q', type: 'bool', text: 't' }]),
      ).rejects.toThrow(/OPENAI_API_KEY/);
      void svc.onModuleDestroy();
    });

    it('does not fall back to Clef when the primary is not Clef and Clef is disabled', async () => {
      const svc = new DecisionProviderService(
        fakeConfig({
          DECISION_MODEL_ENABLED: 'true',
          PROMPT_GUARD_CLEF_ENABLED: 'false',
          DECISION_PROVIDER: 'jev-typesafe',
        }),
      );
      await expect(
        svc.decide('guard', 's', [{ id: 'q', type: 'bool', text: 't' }]),
      ).rejects.toThrow(/TYPESAFE_API_KEY/);
      void svc.onModuleDestroy();
    });
  });
});

describe('ClefProvider request shape', () => {
  it('sends model + state + questions (Clef 400s without model)', async () => {
    const { ClefProvider } = require('./providers/clef.provider');
    let sentBody: any = null;
    const fetchFn = jest.fn().mockImplementation(async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          result: { malicious: { option: 'no', probability: 0.95 } },
        }),
      };
    });
    const provider = new ClefProvider({
      accountId: 'acc',
      apiToken: 'tok',
      model: 'clef-flash',
      fetchFn,
    });
    const result = await provider.decide('some state', [
      { id: 'malicious', type: 'bool', text: 'bad?' },
    ]);
    expect(sentBody.model).toBe('clef-flash');
    expect(sentBody.state).toBe('some state');
    expect(Object.keys(sentBody.questions)).toEqual(['malicious']);
    expect(result.answers['malicious']).toEqual({ option: 'no', probability: 0.95 });
  });

  it('maps a benign noul answer to a low score, not the old 0.5 fallback', async () => {
    const { ClefProvider } = require('./providers/clef.provider');
    const fetchFn = jest.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        result: {
          answers: {
            malicious: { type: 'noul', noul: 0.02 },
            verdict: {
              type: 'choice',
              choice: 'benign',
              probabilities: { benign: 0.95, suspicious: 0.04, malicious: 0.01 },
              confidence: 0.95,
            },
          },
        },
      }),
    }));
    const provider = new ClefProvider({ accountId: 'acc', apiToken: 'tok', fetchFn });
    const result = await provider.decide('s', [
      { id: 'malicious', type: 'bool', text: 'bad?' },
      { id: 'verdict', type: 'choice', text: 'classify', options: ['benign', 'suspicious', 'malicious'] },
    ]);
    expect(result.answers['malicious']).toEqual({ option: 'no', probability: 0.02 });
    expect(result.answers['verdict']).toEqual({ option: 'benign', probability: 0.95 });
    // The ingestion guard score uses malProb directly: 0.02 must stay below
    // the default quarantine line (0.4), not equal it.
    expect(result.answers['malicious'].probability).toBeLessThan(0.4);
  });

  it('maps questions to the published Clef schema (noul/choice+score)', async () => {
    const { ClefProvider } = require('./providers/clef.provider');
    let sentBody: any = null;
    const fetchFn = jest.fn().mockImplementation(async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          result: {
            kind: { option: 'bug', probability: 0.9 },
            retries: 3,
          },
        }),
      };
    });
    const provider = new ClefProvider({
      accountId: 'acc',
      apiToken: 'tok',
      fetchFn,
    });
    const result = await provider.decide('s', [
      { id: 'kind', type: 'choice', text: 'which?', options: ['bug', 'feature'] },
      { id: 'retries', type: 'score', text: 'how many?' },
    ]);
    // bool→noul, choice→criteria map, score→level list (schema-input.json).
    expect(sentBody.questions['kind']).toEqual({
      type: 'choice',
      instructions: 'which?',
      criteria: { bug: 'bug', feature: 'feature' },
    });
    expect(sentBody.questions['retries'].type).toBe('score');
    expect(sentBody.questions['retries'].criteria.length).toBeGreaterThanOrEqual(2);
    // Score index 3 of 5 levels → 0.75.
    expect(result.answers['retries']).toEqual({ value: 0.75, probability: 0.75 });
    expect(result.answers['kind']).toEqual({ option: 'bug', probability: 0.9 });
  });
});

describe('parseClefAnswer', () => {
  const boolQ = { id: 'q', type: 'bool' as const, text: 't' };
  const scoreQ = { id: 'q', type: 'score' as const, text: 't' };

  it('reads bare numbers', () => {
    expect(parseClefAnswer(0.9, boolQ)).toEqual({ option: 'yes', probability: 0.9 });
    expect(parseClefAnswer(0.1, boolQ)).toEqual({ option: 'no', probability: 0.1 });
    expect(parseClefAnswer(0.7, scoreQ)).toEqual({ value: 0.7, probability: 0.7 });
  });

  it('reads option/probability objects and aliases', () => {
    expect(parseClefAnswer({ option: 'malicious', probability: 0.8 }, boolQ)).toEqual({
      option: 'malicious',
      probability: 0.8,
    });
    expect(parseClefAnswer({ answer: 'bug', confidence: 0.6 }, boolQ)).toEqual({
      option: 'bug',
      probability: 0.6,
    });
  });

  it('reads the published Clef answer shapes (noul/choice/score)', () => {
    expect(parseClefAnswer({ type: 'noul', noul: 0.02 }, boolQ)).toEqual({
      option: 'no',
      probability: 0.02,
    });
    expect(parseClefAnswer({ type: 'noul', noul: 0.93 }, boolQ)).toEqual({
      option: 'yes',
      probability: 0.93,
    });

    const choiceQ = {
      id: 'v',
      type: 'choice' as const,
      text: 't',
      options: ['benign', 'malicious'],
    };
    // confidence (0.7) is NOT P(chosen option) (0.9) — use probabilities.
    expect(
      parseClefAnswer(
        {
          type: 'choice',
          choice: 'malicious',
          probabilities: { benign: 0.1, malicious: 0.9 },
          confidence: 0.7,
        },
        choiceQ,
      ),
    ).toEqual({ option: 'malicious', probability: 0.9 });

    expect(
      parseClefAnswer(
        {
          type: 'score',
          score: 0.25,
          legend: { '0': 'low', '1': 'high' },
          probabilities: { '0': 0.75, '1': 0.25 },
          confidence: 0.6,
        },
        scoreQ,
      ),
    ).toEqual({ value: 0.25, probability: 0.25 });
  });

  it('never invents a probability (unknown = 0, not 0.5)', () => {
    expect(parseClefAnswer({ option: 'x', probability: 'junk' }, boolQ).probability).toBe(0);
    expect(parseClefAnswer({ type: 'noul' }, boolQ).probability).toBe(0);
    expect(parseClefAnswer('no', boolQ)).toEqual({ option: 'no', probability: 0 });
    expect(parseClefAnswer(undefined, boolQ).probability).toBe(0);
  });
});

describe('LlmJudgeProvider', () => {
  it('uses 0 (not 0.5) when the judge omits a probability', async () => {
    const { LlmJudgeProvider } = require('./providers/llm-judge.provider');
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: '{"answers":{"q":{"option":"no"}}}' } },
        ],
      }),
    });
    const provider = new LlmJudgeProvider({ apiKey: 'k', fetchFn });
    const result = await provider.decide('s', [
      { id: 'q', type: 'bool', text: 't' },
    ]);
    expect(result.answers['q']).toEqual({ option: 'no', probability: 0 });
  });
});

describe('extractJsonObject', () => {
  it('pulls JSON out of prose and fences', () => {
    expect(extractJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! {"a": 1} done')).toEqual({ a: 1 });
    expect(extractJsonObject('no json here')).toBeNull();
  });
});

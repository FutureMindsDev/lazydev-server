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
  });

  describe('decide fallback chain', () => {
    it('falls back when primary is unconfigured, then throws for last resort', async () => {
      const svc = new DecisionProviderService(fakeConfig({}));
      // clef-workers has no creds here AND llm-judge has no key → throws,
      // so the caller can apply regex-only / old heuristic.
      await expect(
        svc.decide('guard', 'some state', [{ id: 'q', type: 'bool', text: 'bad?' }]),
      ).rejects.toThrow();
      void svc.onModuleDestroy();
    });

    it('local-weight ids fail with a clear not-built error', async () => {
      const svc = new DecisionProviderService(
        fakeConfig({ DECISION_PROVIDER: 'laya-local' }),
      );
      await expect(
        svc.decide('guard', 's', [{ id: 'q', type: 'bool', text: 't' }]),
      ).rejects.toThrow();
      void svc.onModuleDestroy();
    });

    it('free-first: paid primary falls back to clef, never llm-judge', async () => {
      const svc = new DecisionProviderService(
        fakeConfig({ DECISION_PROVIDER: 'jev-typesafe' }),
      );
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
          DECISION_PROVIDER: 'laya-local',
          DECISION_FALLBACK: 'llm-judge',
        }),
      );
      // laya (not built) → clef (no creds) → llm-judge (no key) → throw
      // with the llm-judge error, proving explicit opt-in runs it.
      await expect(
        svc.decide('guard', 's', [{ id: 'q', type: 'bool', text: 't' }]),
      ).rejects.toThrow(/OPENAI_API_KEY/);
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

  it('never returns NaN', () => {
    expect(parseClefAnswer({ option: 'x', probability: 'junk' }, boolQ).probability).toBe(0.5);
    expect(parseClefAnswer(undefined, boolQ).probability).toBe(0);
  });
});

describe('extractJsonObject', () => {
  it('pulls JSON out of prose and fences', () => {
    expect(extractJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! {"a": 1} done')).toEqual({ a: 1 });
    expect(extractJsonObject('no json here')).toBeNull();
  });
});

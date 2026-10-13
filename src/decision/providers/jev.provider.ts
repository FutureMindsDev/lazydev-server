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
/**
 * Jev by TypeSafe (`jev-latest`) — hosted decision API.
 *
 * Simple story: same job as Clef (bounded questions in, probabilities
 * out), different vendor. Paid: $0.042 per 1M input tokens, output free.
 *
 * WARNING: the exact REST field names below are reconstructed from
 * independent guides (jevmodel.org) — TypeSafe's official reference may
 * name them slightly differently. The parser tries every plausible shape
 * and the dispatcher falls back on mismatch, so a wrong guess costs a
 * warning log, never a broken pipeline. Verify with a real key before
 * making this the default (see the eval rule in docs/system-one-model-plan.md).
 */
import {
  DecisionAnswer,
  DecisionProviderId,
  DecisionQuestion,
  DecisionResult,
} from '../decision.dto';
import { parseClefAnswer } from './clef.provider';

export interface JevProviderOptions {
  /** TypeSafe key, or a gateway key when endpoint is overridden. */
  apiKey: string;
  /** Override for Vercel AI Gateway / OpenRouter routing. Defaults to TypeSafe. */
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 20_000;

export class JevProvider {
  readonly id: DecisionProviderId;

  constructor(
    private readonly opts: JevProviderOptions,
    id: DecisionProviderId = 'jev-typesafe',
  ) {
    this.id = id;
  }

  async decide(
    state: string,
    questions: DecisionQuestion[],
  ): Promise<DecisionResult> {
    if (!this.opts.apiKey) {
      throw new Error(
        'Jev needs an API key (TYPESAFE_API_KEY, or the gateway key when endpoint is overridden).',
      );
    }
    const endpoint = this.opts.endpoint || DEFAULT_ENDPOINT;
    const fetchFn = this.opts.fetchFn ?? fetch;

    // Jev primitives: choice (pick one), score (rank), noul (yes/no gate).
    const payloadQuestions: Record<string, unknown> = {};
    for (const q of questions) {
      const kind = q.type === 'bool' ? 'noul' : q.type;
      payloadQuestions[q.id] = {
        type: kind,
        prompt: q.text,
        ...(q.options ? { options: q.options } : {}),
      };
    }

    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.opts.model || 'jev-latest',
        state,
        questions: payloadQuestions,
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as Record<string, any>;
    const container =
      data?.result && typeof data.result === 'object'
        ? data.result
        : data?.decision && typeof data.decision === 'object'
          ? data.decision
          : data;
    const answers: Record<string, DecisionAnswer> = {};
    for (const q of questions) {
      const raw =
        container?.[q.id] ?? container?.answers?.[q.id] ?? container?.decisions?.[q.id];
      // Jev's noul answers read as yes/no probabilities — same tolerant
      // parser as Clef covers all three primitives.
      answers[q.id] = parseClefAnswer(raw, q);
    }
    return { providerId: this.id, answers };
  }
}

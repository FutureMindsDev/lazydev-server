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
 * Clef on Cloudflare Workers AI (`@cf/cloudflare/clef` / `clef-flash`).
 *
 * Simple story: Clef takes "here is the situation" (state) plus fixed
 * questions and returns a probability per answer — exactly what our gates
 * need. Covered by Workers AI's free 10,000 Neurons/day (no card).
 *
 * API shape follows https://developers.cloudflare.com/workers-ai/models/clef/
 * (state + up-to-64 typed questions under caller-chosen ids). Question
 * field names below are our best reading of the docs — the response
 * parser is deliberately tolerant (see parseAnswers) so a field rename
 * degrades to fallback instead of crashing.
 */
import {
  DecisionAnswer,
  DecisionProviderId,
  DecisionQuestion,
  DecisionResult,
} from '../decision.dto';

export interface ClefProviderOptions {
  accountId: string;
  apiToken: string;
  /** 'clef' (27B, multimodal) or 'clef-flash' (smaller/faster). */
  model?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** Pull one normalized answer out of Clef's per-question result following
 *  the published schema (schema-output.json):
 *
 *    noul   -> { type: 'noul', noul: 0..1 }              (probability of yes)
 *    choice -> { type: 'choice', choice, probabilities } (P per option)
 *    score  -> { type: 'score', score: 0..1, ... }       (weighted level)
 *
 *  Never invent a probability when the provider sent none: the old 0.5
 *  fallback sat above the default quarantine line (0.4), so every parse
 *  miss silently failed closed. Unknown = 0 = "let the human-visible
 *  Layer 0 verdict stand". */
export function parseClefAnswer(
  raw: unknown,
  question: DecisionQuestion,
): DecisionAnswer {
  if (typeof raw === 'number') {
    // Bare score (legacy/plain-LLM providers; Clef itself sends objects).
    const p = num(raw);
    if (question.type === 'score') return { value: p, probability: p };
    return { option: p >= 0.5 ? 'yes' : 'no', probability: p };
  }
  if (typeof raw === 'string') {
    // Label with no number attached — report it as unknown, not 0.5.
    return { option: raw, probability: 0 };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;

    // Yes/no: Clef answers with the probability of "yes".
    if (question.type === 'bool' && typeof o['noul'] === 'number') {
      const p = num(o['noul']);
      return { option: p >= 0.5 ? 'yes' : 'no', probability: p };
    }

    // Score: already a probability-weighted level on our 0..1 scale.
    if (question.type === 'score' && typeof o['score'] === 'number') {
      const p = num(o['score']);
      return { value: p, probability: p };
    }

    const option =
      typeof o['option'] === 'string'
        ? (o['option'] as string)
        : typeof o['answer'] === 'string'
          ? (o['answer'] as string)
          : typeof o['choice'] === 'string'
            ? (o['choice'] as string)
            : typeof o['label'] === 'string'
              ? (o['label'] as string)
              : undefined;
    const value =
      typeof o['value'] === 'number' || typeof o['value'] === 'string'
        ? num(o['value'])
        : undefined;
    // Prefer P(the option Clef actually chose). `confidence` is how sure
    // the model is overall, NOT the chance that this answer is right.
    const probabilities =
      o['probabilities'] && typeof o['probabilities'] === 'object'
        ? (o['probabilities'] as Record<string, unknown>)
        : undefined;
    const chosen = option && probabilities ? probabilities[option] : undefined;
    const probability = num(
      chosen ?? o['probability'] ?? o['confidence'] ?? o['p'] ?? o['score'],
    );
    if (question.type === 'score') {
      return { value: value ?? probability, probability };
    }
    return { option, probability };
  }
  return { probability: 0 };
}

export class ClefProvider {
  readonly id: DecisionProviderId = 'clef-workers';

  constructor(private readonly opts: ClefProviderOptions) {}

  async decide(
    state: string,
    questions: DecisionQuestion[],
  ): Promise<DecisionResult> {
    if (!this.opts.accountId || !this.opts.apiToken) {
      throw new Error(
        'Clef needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN. Set them in .env or pick another provider.',
      );
    }
    const model = this.opts.model === 'clef' ? 'clef' : 'clef-flash';
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${this.opts.accountId}` +
      `/ai/run/@cf/cloudflare/${model}`;
    const fetchFn = this.opts.fetchFn ?? fetch;

    // Question mapping follows the published input schema EXACTLY
    // (schema-input.json): noul {type, instructions}, choice {type,
    // instructions, criteria:{option: description}} (criteria REQUIRED,
    // 2-255 options), score {type, instructions, criteria:[levels lowest
    // first]} (REQUIRED, 2-10 levels). Anything else 400s.
    const scoreLevels = ['none at all', 'a little', 'half', 'a lot', 'maximum'];
    const payloadQuestions: Record<string, unknown> = {};
    for (const q of questions) {
      if (q.type === 'bool') {
        payloadQuestions[q.id] = {
          type: 'noul',
          instructions: q.text,
          criteria: { true: 'yes', false: 'no' },
        };
      } else if (q.type === 'choice') {
        const criteria: Record<string, string> = {};
        for (const opt of q.options || []) criteria[opt] = opt;
        // Schema demands 2+ options; a single-option question would 400.
        if (Object.keys(criteria).length < 2) criteria['other'] = 'anything else';
        payloadQuestions[q.id] = {
          type: 'choice',
          instructions: q.text,
          criteria,
        };
      } else {
        payloadQuestions[q.id] = {
          type: 'score',
          instructions: q.text,
          criteria: scoreLevels,
        };
      }
    }

    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiToken}`,
        'Content-Type': 'application/json',
      },
      // NOTE: Clef requires the model selector IN the body as well as the
      // URL (400 "required properties '/' are 'model,state,questions'"
      // without it — found via live test 2026-10-13).
      body: JSON.stringify({ model, state, questions: payloadQuestions }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Clef HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as Record<string, any>;
    // Workers AI wraps results in { result, success }; be liberal.
    const container =
      data?.result && typeof data.result === 'object' && !Array.isArray(data.result)
        ? data.result
        : data;
    const answers: Record<string, DecisionAnswer> = {};
    for (const q of questions) {
      const raw =
        container?.[q.id] ?? container?.answers?.[q.id] ?? container?.decisions?.[q.id];
      if (q.type === 'score' && typeof raw === 'number') {
        // Score answers are level INDEXES (0 = lowest of our 5 levels),
        // not 0..1 — convert. (parseClefAnswer would clamp an index to 1.)
        const levels = 5;
        const v = raw > 1 ? raw / (levels - 1) : raw;
        answers[q.id] = {
          value: Math.min(1, Math.max(0, v)),
          probability: Math.min(1, Math.max(0, v)),
        };
      } else {
        answers[q.id] = parseClefAnswer(raw, q);
      }
    }
    return { providerId: this.id, answers };
  }
}

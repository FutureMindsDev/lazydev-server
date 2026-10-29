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
 * LLM-as-judge fallback — asks the already-configured OpenAI-compatible
 * chat model for STRICT JSON verdicts. No new keys, no new deps, always
 * available — which is why it is the last resort in every fallback chain.
 *
 * Slower and pricier per call than a decision model, and its prose must
 * be parsed (with a tolerant JSON extractor). Never the default; only
 * the safety net.
 */
import {
  DecisionAnswer,
  DecisionProviderId,
  DecisionQuestion,
  DecisionResult,
} from '../decision.dto';

export interface LlmJudgeProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Pull a JSON object out of chat prose (fences, preamble, trailing text). */
export function extractJsonObject(text: string): Record<string, any> | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export class LlmJudgeProvider {
  readonly id: DecisionProviderId = 'llm-judge';

  constructor(private readonly opts: LlmJudgeProviderOptions) {}

  async decide(
    state: string,
    questions: DecisionQuestion[],
  ): Promise<DecisionResult> {
    if (!this.opts.apiKey) {
      throw new Error(
        'LLM judge needs OPENAI_API_KEY (or the provider key for OPENAI_BASE_URL).',
      );
    }
    const baseUrl = (this.opts.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const fetchFn = this.opts.fetchFn ?? fetch;

    const spec = questions
      .map(
        (q) =>
          `- ${q.id} (${q.type}${q.options ? `: one of ${q.options.join(' | ')}` : ''}): ${q.text}` +
          (q.type === 'score'
            ? ' Answer with a number 0..1.'
            : ' Answer with the exact option text.'),
      )
      .join('\n');
    const prompt =
      `You are a strict classifier. Answer ONLY with a JSON object shaped like ` +
      `{"answers": {"<id>": {"option": "<text>", "value": <number>, "probability": <0..1>}}}. ` +
      `No prose, no fences.\n\nState:\n${state}\n\nQuestions:\n${spec}`;

    const res = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.opts.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`LLM judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as any;
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    const parsed = extractJsonObject(content);
    if (!parsed || typeof parsed.answers !== 'object') {
      throw new Error('LLM judge returned unparseable output.');
    }
    const answers: Record<string, DecisionAnswer> = {};
    for (const q of questions) {
      const a = (parsed.answers as Record<string, any>)[q.id] || {};
      const probability =
        typeof a.probability === 'number' && Number.isFinite(a.probability)
          ? Math.min(1, Math.max(0, a.probability))
          : // Missing number = unknown, not 0.5. 0.5 sits above the default
            // quarantine line (0.4), so inventing it turns every malformed
            // judge reply into a false positive. Matches Clef's parser.
            0;
      answers[q.id] =
        q.type === 'score'
          ? {
              value:
                typeof a.value === 'number' ? a.value : probability,
              probability,
            }
          : { option: typeof a.option === 'string' ? a.option : undefined, probability };
    }
    return { providerId: this.id, answers };
  }
}

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

/**
 * Shared shapes for System One decision providers (Clef, Jev, Llama-style
 * local models, or a plain LLM asked for JSON as fallback).
 *
 * Simple story: every gate in the pipeline asks bounded questions
 * (yes/no, pick-one, score) and gets back short answers WITH numbers.
 * This file is the common language so gates never talk to a vendor SDK
 * directly — see DecisionProviderService.
 */

/** Provider ids a user can pick (env, dashboard UI, or per-gate override). */
export type DecisionProviderId =
  | 'clef-workers'
  | 'clef-local'
  | 'jev-typesafe'
  | 'jev-vercel'
  | 'jev-openrouter'
  | 'laya-local'
  | 'openjev-local'
  | 'llm-judge';

/** One bounded question. bool = yes/no, choice = pick one option,
 *  score = place on a 0..1 scale. */
export interface DecisionQuestion {
  id: string;
  type: 'bool' | 'choice' | 'score';
  /** The question in plain words. */
  text: string;
  /** Allowed answers for type 'choice'. */
  options?: string[];
}

/** Normalized answer: what won, plus how sure the model is (0..1). */
export interface DecisionAnswer {
  /** Winning option for bool/choice (bool uses 'yes'/'no'). */
  option?: string;
  /** Value for score questions (0..1). */
  value?: number;
  /** Calibrated confidence 0..1. Low confidence = fail closed downstream. */
  probability: number;
}

export interface DecisionResult {
  providerId: DecisionProviderId;
  answers: Record<string, DecisionAnswer>;
}

/** Gate A — issue triage verdict. */
export interface TriageVerdict {
  issueKind:
    | 'bug'
    | 'feature'
    | 'refactor'
    | 'documentation'
    | 'dependency'
    | 'security'
    | 'unknown';
  complexity: 'low' | 'medium' | 'high';
  requiresRepositorySearch: boolean;
  requiresHumanReview: boolean;
  confidence: number;
}

/** Gate B — patch safety verdict. */
export type PatchDecision =
  | 'validate'
  | 'retry_patch'
  | 'request_human_review'
  | 'abort';

export interface PatchGateVerdict {
  decision: PatchDecision;
  risk: 'low' | 'medium' | 'high';
  reasons: string[];
  confidence: number;
}

/** Gate C — validation retry verdict. */
export type ValidationAction =
  | 'accept'
  | 'retry_patch'
  | 'retry_with_more_context'
  | 'request_human_review'
  | 'abort';

export type FailureClass =
  | 'test_failure'
  | 'type_error'
  | 'lint_error'
  | 'environment_failure'
  | 'missing_dependency'
  | 'incorrect_patch'
  | 'unknown';

export interface ValidationDecision {
  action: ValidationAction;
  failureClass: FailureClass;
  confidence: number;
  maxAdditionalAttempts: number;
}

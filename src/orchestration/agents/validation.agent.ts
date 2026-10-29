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
import { Injectable, Logger } from '@nestjs/common';
import { AgentState } from '../graph.state';
import { ValidationService } from '../../validation/validation.service';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { SerenaMcpService } from '../../intelligence/serena-mcp.service';
import { LlmService } from '../llm.service';
import { extractMcpText } from '../../common/mcp-text';
import { DecisionProviderService } from '../../decision/decision-provider.service';
import { HumanFeedbackService } from '../../feedback/human-feedback.service';
import {
  FailureClass,
  ValidationAction,
  ValidationDecision,
} from '../../decision/decision.dto';

@Injectable()
export class ValidationAgent {
  private readonly logger = new Logger(ValidationAgent.name);

  constructor(
    private readonly validationService: ValidationService,
    private readonly serenaMcp: SerenaMcpService,
    private readonly llmService: LlmService,
    private readonly decision: DecisionProviderService,
    private readonly feedback: HumanFeedbackService,
  ) {}

  async invoke(state: AgentState): Promise<Partial<AgentState>> {
    this.logger.log('Validating generated patch...');

    // Count every visit, including the early return below: the validator's
    // retry edge aborts at 3 attempts, and an early return that skips the
    // increment leaves the counter frozen at 0. That is exactly what fueled
    // the empty-plan death spiral — "No patch found" never counted as an
    // attempt, so the retry edge looped until GraphRecursionError.
    const attempts = (state.validationAttempts || 0) + 1;

    if (!state.generatedPatch) {
      this.logger.warn('No patch generated to validate.');
      return {
        isValid: false,
        validationFeedback: 'No patch found.',
        validationAttempts: attempts,
      };
    }

    const worktreePath = state.issuePayload?.worktreePath;

    if (!worktreePath) {
      this.logger.warn('No worktreePath in state — skipping sandbox validation, marking as valid.');
      return { isValid: true, validationFeedback: 'Skipped (no worktree path).', validationAttempts: attempts };
    }

    try {
      this.logger.log(`Running validation sandbox (Attempt ${attempts})...`);

      // ValidationService auto-detects the project language (Node.js, Python, Go,
      // Rust, PHP, Java, C#) from the worktree and runs the correct install + test
      // command in the appropriate Docker image. No hardcoded language assumptions.
      const result = await this.validationService.validateWorktree(worktreePath);

      if (result.success) {
        this.logger.log(`Patch validation passed (language: ${result.language}).`);
        
        // Update lessons learned BEFORE returning. GitAgent copies Serena's
        // memories into the worktree right before committing; a fire-and-forget
        // write races that snapshot and the new lesson misses the commit.
        if (process.env.ENABLE_SERENA_ISSUE_HISTORY === 'true') {
          const repoPath = state.issuePayload?.repoPath;
          try {
            await this.updateLessonsLearned(state, worktreePath, repoPath);
          } catch (err) {
            this.logger.error('Failed to update historical_issues_and_lessons:', err);
          }
        }

        return {
          isValid: true,
          validationFeedback: `All tests passed.\n${result.stdout}`,
          validationAttempts: attempts,
          messages: [new SystemMessage('Validation successful.')],
        };
      } else {
        const feedback = result.stderr || result.stdout || 'Unknown validation error.';
        this.logger.warn(`Validation failed (language: ${result.language}): ${feedback}`);

        // Deterministic syntax/parse errors in the patched code: truncated
        // JSX, unclosed tags, missing brackets, etc. These are ALWAYS the
        // patch's fault (incomplete LLM output), never the environment's.
        // Catch them before Gate C so the retry is immediate — asking a
        // decision model to classify "Expected '</'" adds latency and risks
        // a misclassification to 'unknown' → 'request_human_review'.
        if (this.isSyntaxError(feedback)) {
          this.logger.warn(
            'Deterministic syntax/parse error detected in patched code — retrying patch.',
          );
          return {
            isValid: false,
            validationFeedback:
              '[Syntax error — the patch produced invalid code (truncated output, unclosed ' +
              'tags, or missing brackets). The file must be fully rewritten with correct JSX/TSX.]\n' +
              feedback,
            validationAttempts: attempts,
            messages: [new SystemMessage(`Validation failed (syntax error):\n${feedback}`)],
          };
        }

        // Deterministic environment failures: sandbox timeouts, disk/cache
        // exhaustion, image/network trouble. Retrying patch generation cannot
        // fix any of these — it just burns another full timeout (and another
        // 100-step graph run) before failing the same way. Stop for a human.
        if (this.isEnvironmentFailure(feedback)) {
          const reason =
            'Validation could not run (environment failure): ' +
            feedback.split('\n')[0].slice(0, 300);
          this.logger.warn(reason);
          const taskId = state.issuePayload?.taskId;
          if (taskId) {
            await this.feedback.storeGateStatus(taskId, {
              stoppedBy: 'validation-gate',
              decision: 'abort',
              reason,
            });
          }
          return {
            isValid: false,
            validationFeedback: feedback,
            validationAttempts: attempts,
            abortReason: reason,
            messages: [new SystemMessage(`Validation stopped:\n${feedback}`)],
          };
        }

        // Gate C: classify the failure BEFORE deciding the retry, so an
        // environment problem never blames the patch (and vice versa).
        const gate = await this.classifyFailure(feedback, String(result.language), attempts);
        if (gate.action === 'accept') {
          this.logger.log(
            `Gate C accepted the run despite validation output (class=${gate.failureClass}). Marking valid.`,
          );
          return {
            isValid: true,
            validationFeedback: `Accepted by Gate C (${gate.failureClass}):\n${feedback}`,
            validationAttempts: attempts,
            messages: [new SystemMessage('Validation accepted by Gate C.')],
          };
        }
        if (gate.action === 'request_human_review' || gate.action === 'abort') {
          const reason =
            gate.action === 'abort'
              ? `Gate C aborted the run (class=${gate.failureClass})`
              : `Gate C asked for human review (class=${gate.failureClass})`;
          this.logger.warn(reason);
          // Record for the run-detail banner (same 24h TTL as task data).
          const taskId = state.issuePayload?.taskId;
          if (taskId) {
            await this.feedback.storeGateStatus(taskId, {
              stoppedBy: 'validation-gate',
              decision: gate.action,
              reason,
            });
          }
          return {
            isValid: false,
            validationFeedback: `${reason}:\n${feedback}`,
            validationAttempts: attempts,
            abortReason: reason,
            messages: [new SystemMessage(`Validation stopped:\n${feedback}`)],
          };
        }
        const extra =
          gate.action === 'retry_with_more_context'
            ? '\n(Gate C suggests retrying with broader repo context.)'
            : '';
        return {
          isValid: false,
          validationFeedback: feedback + extra,
          validationAttempts: attempts,
          validationMaxAttempts: attempts + gate.maxAdditionalAttempts,
          messages: [new SystemMessage(`Validation failed:\n${feedback}`)],
        };
      }
    } catch (e: any) {
      this.logger.warn(`Validation failed: ${e.message}`);
      return {
        isValid: false,
        validationFeedback: e.message,
        validationAttempts: attempts,
        messages: [new SystemMessage(`Validation failed:\n${e.message}`)],
      };
    }
  }

  /**
   * True for build/compile errors that are clearly caused by malformed
   * patched code — truncated JSX, unclosed tags, missing brackets, etc.
   * These are always the patch's fault (the LLM's output was incomplete),
   * never the environment's, and should route straight to retry_patch
   * without asking Gate C (which tends to misclassify them as 'unknown').
   */
  private isSyntaxError(feedback: string): boolean {
    return (
      // Turbopack / SWC / esbuild parse failures
      /Expected\s+['"]<\/['"],?\s*got\s+['"]<eof>['"]/i.test(feedback) ||
      /Parsing ecmascript source code failed/i.test(feedback) ||
      /Unterminated JSX (contents|element)/i.test(feedback) ||
      // Babel / tsc parse errors
      /SyntaxError:\s*(Unexpected token|Unexpected end of input)/i.test(feedback) ||
      /Unexpected token.*Expected.*[;})>]/i.test(feedback) ||
      // Generic truncation indicators: EOF in the middle of a construct
      /error.*unexpected.*eof/i.test(feedback) ||
      /error.*unterminated.*string|template literal/i.test(feedback)
    );
  }

  /**
   * True for failures that are about the sandbox/host, not the patch.
   * These must never enter the patch-retry loop.
   */
  private isEnvironmentFailure(feedback: string): boolean {
    return (
      /Sandbox execution timed out/i.test(feedback) ||
      /ENOSPC|no space left on device/i.test(feedback) ||
      (/EEXIST/i.test(feedback) && /(_cacache|\.npm)/i.test(feedback)) ||
      /Unable to find image|Cannot connect to the Docker daemon/i.test(feedback) ||
      /npm error code (ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT)/i.test(feedback)
    );
  }

  /**
   * Gate C: ask the decision provider what KIND of failure this is and what
   * to do about it. On any provider trouble, returns the old behavior
   * (plain retry until 3 attempts) — a dead gate must never change routing.
   */
  private async classifyFailure(
    feedback: string,
    language: string,
    attempts: number,
  ): Promise<ValidationDecision> {
    const fallback: ValidationDecision = {
      action: 'retry_patch',
      failureClass: 'unknown',
      confidence: 0,
      maxAdditionalAttempts: Math.max(0, 3 - attempts),
    };
    const stateText =
      `Language: ${language}\nAttempt: ${attempts}\nFailure output:\n${feedback}`.slice(0, 4000);
    try {
      const result = await this.decision.decide('validation', stateText, [
        {
          id: 'failureClass',
          type: 'choice',
          text: 'What kind of failure is this?',
          options: [
            'test_failure',
            'type_error',
            'syntax_error',
            'lint_error',
            'environment_failure',
            'missing_dependency',
            'incorrect_patch',
            'unknown',
          ],
        },
        {
          id: 'action',
          type: 'choice',
          text: 'What should happen next?',
          options: [
            'accept',
            'retry_patch',
            'retry_with_more_context',
            'request_human_review',
            'abort',
          ],
        },
        {
          id: 'retries',
          type: 'score',
          text: 'How many more attempts is this worth? 0 = stop now, 1 = full budget.',
        },
      ]);
      const a = result.answers;
      const pick = (id: string, allowed: string[], d: string) => {
        const o = a[id]?.option;
        return typeof o === 'string' && allowed.includes(o) ? o : d;
      };
      const retriesRaw = a['retries']?.value ?? a['retries']?.probability ?? 0.5;
      return {
        action: pick(
          'action',
          ['accept', 'retry_patch', 'retry_with_more_context', 'request_human_review', 'abort'],
          'retry_patch',
        ) as ValidationAction,
        failureClass: pick(
          'failureClass',
          ['test_failure', 'type_error', 'syntax_error', 'lint_error', 'environment_failure', 'missing_dependency', 'incorrect_patch', 'unknown'],
          'unknown',
        ) as FailureClass,
        confidence: a['action']?.probability ?? 0.5,
        maxAdditionalAttempts: Math.min(3, Math.max(0, Math.round(retriesRaw * 3))),
      };
    } catch (e: any) {
      this.logger.warn(`Gate C unavailable, keeping old retry behavior: ${e.message}`);
      return fallback;
    }
  }

  private async updateLessonsLearned(
    state: AgentState,
    worktreePath: string,
    repoPath?: string,
  ) {
    this.logger.log('Generating lessons learned from this fix...');
    const issueTitle = state.issuePayload?.issue?.title || state.issuePayload?.title || 'Unknown Issue';
    const plan = state.implementationPlan || 'No plan available';
    const patch = state.generatedPatch || 'No patch available';

    const prompt = `You are a senior software engineer reflecting on a recently resolved issue.
Please write a short JSON object containing a summary of the issue, the solution approach taken, and any lessons learned.
Do not wrap it in markdown block quotes, return strictly valid JSON matching this schema:
{
  "issue": "...",
  "solution": "...",
  "lessons_learned": "..."
}

Context:
Issue Title: ${issueTitle}
Plan: ${plan}
Patch:
${patch}
`;

    let newEntry: any;
    try {
      const response = await this.llmService
        .getModel('validation', state.issuePayload?.installation?.id)
        .invoke([new HumanMessage(prompt)]);
      let content = response.content.toString().trim();
      if (content.startsWith('\`\`\`json')) {
        content = content.replace(/^\`\`\`json/, '').replace(/\`\`\`$/, '').trim();
      }
      newEntry = JSON.parse(content);
    } catch (e) {
      this.logger.warn('Failed to generate or parse lessons learned from LLM:', e);
      return;
    }

    try {
      // Memories physically live under `<active project>/.serena/memories/`,
      // and this ephemeral worktree is deleted when the job ends — so this
      // log must be read/written against the persistent repo-cache clone
      // (repoPath), not the worktree, or every entry would vanish with it.
      const memoryProjectPath = repoPath || worktreePath;
      await this.serenaMcp.activateProject(memoryProjectPath);

      const readRes = await this.serenaMcp.readMemory('historical_issues_and_lessons');
      const memoryText = extractMcpText(readRes) ?? '';

      let parsedMemory: any;
      try {
        parsedMemory = JSON.parse(memoryText);
      } catch (e) {
        // If not parseable, default to a new template
        parsedMemory = {
          description: "Running log of historical issues, methods used, and lessons learned during automated fix attempts.",
          entries: []
        };
      }

      if (!Array.isArray(parsedMemory.entries)) {
        parsedMemory.entries = [];
      }

      parsedMemory.entries.push(newEntry);

      const writeResult = await this.serenaMcp.writeMemory(
        'historical_issues_and_lessons',
        JSON.stringify(parsedMemory, null, 2),
      );

      // Restore the worktree as the active project so anything else in this
      // job (e.g. a retry attempt) still targets the real checkout.
      await this.serenaMcp.activateProject(worktreePath);

      if (writeResult?.isError) {
        this.logger.warn(
          `Failed to write historical_issues_and_lessons memory: ${writeResult.content?.[0]?.text ?? 'unknown error'}`,
        );
      } else {
        this.logger.log('Successfully updated historical_issues_and_lessons memory.');
      }
    } catch (e) {
      this.logger.warn('Failed to read or write historical_issues_and_lessons memory:', e);
    }
  }
}

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
import { ConfigService } from '@nestjs/config';
import { AgentState } from './graph.state';
import {
  DecisionProviderService,
} from '../decision/decision-provider.service';
import { HumanFeedbackService } from '../feedback/human-feedback.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PatchDecision,
  TriageVerdict,
} from '../decision/decision.dto';
import { MCP_ISSUE_MARKER } from '../mcp-server/mcp.constants';

/** Gate B retry cap: the patch gate may send work back to the patcher at
 *  most this many times before stopping for a human. */
const MAX_PATCH_GATE_RETRIES = 2;

/** Dependency manifests — touching one means every install changes. */
const DEP_FILES = [
  'package.json',
  'package-lock.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'composer.json',
  'pom.xml',
  '.csproj',
  'Gemfile',
];

/**
 * Pipeline gates (triage + patch safety) as graph nodes.
 *
 * Simple story: two checkpoints with fixed questions. Triage (Gate A)
 * runs between onboarding and planning and decides what the job IS and
 * whether a human must see it first. The patch gate (Gate B) runs between
 * patching and validation and decides whether the patch is safe to test.
 * Both fail closed (unclear → human) and both honor human approvals first
 * (feedback present on the task = approved = walk through).
 */
@Injectable()
export class PipelineGatesService {
  private readonly logger = new Logger(PipelineGatesService.name);

  constructor(
    private readonly decision: DecisionProviderService,
    private readonly feedback: HumanFeedbackService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  private taskIdOf(state: AgentState): string | undefined {
    return state.issuePayload?.taskId;
  }

  /** True when a human already weighed in on this task (dashboard or MCP).
   *  Approvals bypass gates — otherwise "approved, proceed" would just get
   *  quarantined again. Read-only: the feedback itself is still consumed
   *  later by the human_feedback node. */
  private async hasApproval(state: AgentState): Promise<boolean> {
    const taskId = this.taskIdOf(state);
    if (!taskId) return false;
    try {
      // typeof-guard: unit tests mock HumanFeedbackService with only the
      // methods they exercise — a missing read() means "no approval".
      const read = (this.feedback as any)?.read;
      if (typeof read !== 'function') return false;
      return (await read.call(this.feedback, taskId)) !== null;
    } catch {
      return false;
    }
  }

  private issueText(state: AgentState): { title: string; body: string; repo: string } {
    const p = state.issuePayload || {};
    return {
      title: p.issue?.title || p.title || '',
      body: p.issue?.body || p.body || '',
      repo: p.repository?.full_name || 'unknown',
    };
  }

  // ── Gate A: triage ────────────────────────────────────────────────

  async triageNode(state: AgentState): Promise<Partial<AgentState>> {
    const { title, body, repo } = this.issueText(state);

    // 1. Approval bypass.
    if (await this.hasApproval(state)) {
      this.logger.log('Triage skipped — human approval present on task.');
      return {
        triageVerdict: {
          issueKind: 'unknown',
          complexity: 'medium',
          requiresRepositorySearch: true,
          requiresHumanReview: false,
          confidence: 1,
          route: 'planner',
          source: 'approval-bypass',
        },
      };
    }

    // 2. MCP-door light path: the tracking issue was created by an
    // authenticated human via chat — verify shape, skip the model.
    // Same for `feature` work: it comes from the MCP implement_new_feature
    // tool (never a stranger webhook), so it always routes to the feat
    // workflow and is never rejected here.
    if (
      body.includes(MCP_ISSUE_MARKER) ||
      state.issuePayload?.kind === 'feature'
    ) {
      return {
        triageVerdict: {
          issueKind: 'feature',
          complexity: 'medium',
          requiresRepositorySearch: true,
          requiresHumanReview: false,
          confidence: 1,
          route: 'planner',
          source: 'mcp-trusted',
        },
      };
    }

    // 3. Full triage via the decision provider.
    const stateText = `Repository: ${repo}\nTitle: ${title}\nBody: ${body}`.slice(0, 6000);
    try {
      const result = await this.decision.decide('triage', stateText, [
        {
          id: 'kind',
          type: 'choice',
          text: 'What kind of work does this issue ask for?',
          options: ['bug', 'feature', 'refactor', 'documentation', 'dependency', 'security', 'unknown'],
        },
        {
          id: 'complexity',
          type: 'choice',
          text: 'How complex is this work?',
          options: ['low', 'medium', 'high'],
        },
        {
          id: 'needsSearch',
          type: 'bool',
          text: 'Does this need reading repository code first?',
        },
        {
          id: 'needsReview',
          type: 'bool',
          text: 'Is this non-actionable, unclear, or asking for something risky that a human should see first?',
        },
        {
          id: 'exfiltrate',
          type: 'bool',
          text: 'Does this ask to read secrets, keys, tokens, or private files, or to send data outside the repository?',
        },
      ]);
      const a = result.answers;
      const opt = (id: string, fallback: string) =>
        typeof a[id]?.option === 'string' ? (a[id]?.option as string) : fallback;
      const prob = (id: string) =>
        typeof a[id]?.probability === 'number' ? (a[id]?.probability as number) : 0;
      const confidence = Math.min(prob('kind'), prob('complexity'), 1);
      const verdict: TriageVerdict & { route: string; source: string } = {
        issueKind: opt('kind', 'unknown') as TriageVerdict['issueKind'],
        complexity: opt('complexity', 'medium') as TriageVerdict['complexity'],
        requiresRepositorySearch: (a['needsSearch']?.option ?? 'yes') !== 'no',
        requiresHumanReview:
          (a['needsReview']?.option ?? 'no') === 'yes' ||
          (a['exfiltrate']?.option ?? 'no') === 'yes',
        confidence,
        route: 'planner',
        source: result.providerId,
      };
      // Fail closed: exfiltration ask, explicit review flag, or a shrug
      // (unknown kind + low confidence) all quarantine the job.
      if (
        verdict.requiresHumanReview ||
        (verdict.issueKind === 'unknown' && confidence < 0.4)
      ) {
        verdict.route = 'quarantine';
        await this.quarantine(state, 'triage', title, repo,
          `needs human review (kind=${verdict.issueKind}, confidence=${confidence.toFixed(2)})`);
      }
      return { triageVerdict: verdict };
    } catch (e: any) {
      // All providers dead → old behavior: proceed, research proceeds
      // without triage input (research tolerates missing context).
      this.logger.warn(`Triage unavailable, proceeding without verdict: ${e.message}`);
      return {
        triageVerdict: {
          issueKind: 'unknown',
          complexity: 'medium',
          requiresRepositorySearch: true,
          requiresHumanReview: false,
          confidence: 0,
          route: 'planner',
          source: 'fallback-proceed',
        },
      };
    }
  }

  // ── Gate B: patch safety ──────────────────────────────────────────

  /** Pull `ACTION <path>` file mentions out of applied/blocked summaries. */
  private changedFiles(text: string): string[] {
    if (!text) return [];
    const out: string[] = [];
    const re = /^(?:CREATE|EDIT|MODIFY|DELETE|RENAME)\s+(\S+)/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return [...new Set(out)];
  }

  private protectedPatterns(): string[] {
    const raw = this.config.get<string>(
      'PROTECTED_PATHS',
      '.env,*.pem,*.key,*.pem.*,id_rsa*',
    );
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  /** Tiny glob: only `*` is special, everything else literal. */
  private matchesProtected(file: string): string | null {
    for (const pattern of this.protectedPatterns()) {
      const re = new RegExp(
        '^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
        'i',
      );
      // Match against the full path AND the basename (so "*.pem" catches
      // "keys/deploy.pem" too).
      const base = file.split('/').pop() || file;
      if (re.test(file) || re.test(base)) return pattern;
    }
    return null;
  }

  async patchGateNode(state: AgentState): Promise<Partial<AgentState>> {
    const attempts = (state.patchGateAttempts || 0) + 1;

    // 1. Approval bypass.
    if (await this.hasApproval(state)) {
      this.logger.log('Patch gate skipped — human approval present on task.');
      return {
        patchRisk: 'low',
        patchGateAttempts: attempts,
        patchGateDecision: 'validate',
      } as Partial<AgentState>;
    }

    const patchText = state.generatedPatch || '';
    const unapplied = (state.unappliedChanges || '').trim();
    const hasUnapplied = unapplied.length > 0;
    const files = this.changedFiles(`${patchText}\n${unapplied}`);
    const testsTouched = files.some((f) => /test|spec|__tests__/i.test(f));
    const depTouched = files.filter((f) =>
      DEP_FILES.some((d) => f === d || f.endsWith('/' + d)),
    );
    const protectedHit = files.map((f) => this.matchesProtected(f)).find(Boolean) as string | undefined;
    const triageKind = state.triageVerdict?.issueKind;
    const securitySensitive =
      triageKind === 'security' ||
      /secur|auth|password|token|secret|private key/i.test(
        `${state.issuePayload?.issue?.title || ''} ${patchText}`.slice(0, 2000),
      );

    const reasons: string[] = [];
    if (files.length === 0) reasons.push('no file changes detected in patch summary');
    // NOTE: `unapplied` is deliberately NOT a risk reason. It also contains
    // self-corrected/optional failures (e.g. "delete this unused image" when
    // the file is binary). Treating it as a safety flag sent one-file patches
    // to the model, which kept answering retry_patch even though the applied
    // change was complete — burning the whole retry budget without ever
    // changing anything. The PR body still surfaces it to a human.
    if (depTouched.length > 0) reasons.push(`dependency files touched: ${depTouched.join(', ')}`);
    if (protectedHit) reasons.push(`protected path matched: ${protectedHit}`);
    if (securitySensitive) reasons.push('security-sensitive issue or patch content');

    // 2. Retry cap FIRST (before the cheap path): a patcher sent back too
    // many times stops for a human, no matter how clean it looks now.
    // MAX = number of send-backs; abort on the next visit.
    if (attempts > MAX_PATCH_GATE_RETRIES) {
      await this.quarantine(state, 'patch-gate', '', '',
        `patch sent back ${MAX_PATCH_GATE_RETRIES} times without converging`);
      return {
        patchRisk: 'high',
        patchGateAttempts: attempts,
        patchGateDecision: 'abort',
        abortReason: 'patch gate retry budget spent',
      } as Partial<AgentState>;
    }

    // 3. Cheap path: small, clean, non-sensitive patch — no model call.
    // Unapplied notes only raise the risk label; they do not block validation.
    if (
      reasons.length === 0 &&
      files.length > 0 &&
      files.length <= 2
    ) {
      return {
        patchRisk: hasUnapplied ? 'medium' : 'low',
        patchGateAttempts: attempts,
        patchGateDecision: 'validate',
      } as Partial<AgentState>;
    }

    // 4. Model verdict on the evidence.
    const evidence =
      `Files changed (${files.length}): ${files.join(', ') || 'none'}\n` +
      `Tests touched: ${testsTouched}\n` +
      `Unapplied edits: ${unapplied ? 'yes — ' + unapplied.slice(0, 500) : 'no'}\n` +
      `Flags: ${reasons.join('; ') || 'none'}`;
    try {
      const result = await this.decision.decide('patch', evidence, [
        {
          id: 'decision',
          type: 'choice',
          text:
            'Given this patch evidence, what should happen next? Choose retry_patch ' +
            'ONLY when the APPLIED patch is unsafe or clearly missing a required change. ' +
            'Unapplied optional/cleanup edits are not a reason to retry.',
          options: ['validate', 'retry_patch', 'request_human_review', 'abort'],
        },
        {
          id: 'risk',
          type: 'choice',
          text: 'What is the risk level of applying this patch?',
          options: ['low', 'medium', 'high'],
        },
      ]);
      const decision = (result.answers['decision']?.option || 'validate') as PatchDecision;
      const risk = (result.answers['risk']?.option || 'medium') as string;
      const confidence = result.answers['decision']?.probability ?? 0.5;
      // Fail closed on low confidence: treat as medium (validate + review note).
      let finalDecision: PatchDecision =
        confidence < 0.4 && decision === 'validate' ? 'request_human_review' : decision;
      // Pure "unapplied notes" with no actual safety flag: validating the
      // applied patch is enough. A retry here cannot converge — the next
      // patcher run sees the same worktree and just says "already done".
      if (
        finalDecision === 'retry_patch' &&
        reasons.length === 0 &&
        hasUnapplied &&
        files.length > 0
      ) {
        this.logger.log(
          'Patch gate: ignoring retry for unapplied notes — no safety flag, validating applied patch.',
        );
        finalDecision = 'validate';
      }
      if (finalDecision === 'request_human_review' || finalDecision === 'abort') {
        await this.quarantine(state, 'patch-gate', '', '',
          `decision=${finalDecision} risk=${risk}: ${reasons.slice(0, 5).join('; ') || 'see evidence'}`);
      }
      if (finalDecision === 'request_human_review') {
        // Medium path: still validate, but the risk travels in state and a
        // review note goes out so a human checks the PR.
        const taskId = this.taskIdOf(state);
        if (taskId) {
          await this.feedback.storeGateStatus(taskId, {
            stoppedBy: 'patch-gate',
            decision: 'validate',
            risk,
            reason: `medium risk under validation: ${reasons.slice(0, 5).join('; ') || 'see logs'}`,
          });
        }
        await this.notifications.sendDiscordNotification({
          title: 'Medium-risk patch under validation',
          description: `A patch was rated **medium risk** and is being validated. Please review the PR when it opens.\nReasons: ${reasons.slice(0, 5).join('; ') || 'see logs'}`,
          color: 15105570,
        }).catch(() => undefined);
        return {
          patchRisk: risk,
          patchGateAttempts: attempts,
          patchGateDecision: 'validate',
        } as Partial<AgentState>;
      }
      return {
        patchRisk: risk,
        patchGateAttempts: attempts,
        patchGateDecision: finalDecision,
        ...(finalDecision === 'abort' ? { abortReason: `patch gate abort (risk=${risk})` } : {}),
      } as Partial<AgentState>;
    } catch (e: any) {
      // All providers dead → old behavior: validate everything.
      this.logger.warn(`Patch gate unavailable, validating (old behavior): ${e.message}`);
      return {
        patchRisk: 'medium',
        patchGateAttempts: attempts,
        patchGateDecision: 'validate',
      } as Partial<AgentState>;
    }
  }

  /** Stop the job loudly: log + Discord so a human knows where to look. */
  private async quarantine(
    state: AgentState,
    gate: 'triage' | 'patch-gate',
    title: string,
    repo: string,
    reason: string,
  ): Promise<void> {
    const taskId = this.taskIdOf(state) || 'unknown';
    this.logger.warn(`[${gate}] quarantined task ${taskId}: ${reason}`);
    if (taskId !== 'unknown') {
      await this.feedback.storeGateStatus(taskId, {
        stoppedBy: gate,
        decision: 'quarantine',
        reason,
      });
    }
    await this.notifications
      .sendDiscordNotification({
        title: `Job quarantined by ${gate} (task ${taskId})`,
        description: `${title ? `**${title}** in ${repo}\n` : ''}Reason: ${reason}\nReply with feedback (dashboard or MCP) to approve and re-run.`,
        color: 15158332,
      })
      .catch(() => undefined);
  }
}

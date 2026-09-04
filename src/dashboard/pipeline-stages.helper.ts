/* eslint-disable */
import { AuditLog } from '../orchestration/entities/audit-log.entity';
import { PipelineStage } from './dashboard.dto';

/**
 * Reconstructs the pipeline stage timeline for a completed run from the
 * fields stored on the AuditLog entity.
 *
 * Mirrors the frontend mock's `makePipelineStages` (src/mocks/data.ts) so the
 * Run Detail screen renders identically against the real backend. For
 * in-progress runs the SSE endpoint (#15) feeds live updates instead.
 *
 * The graph's actual node order is:
 *   onboarding → (analyzer merged into planner) → research ⇄ tools →
 *   planner → patcher ⇄ patcher_tools → validator ⇄ human_feedback → git
 *
 * For a completed run we render the canonical 7-stage view the UI expects.
 */
export function derivePipelineStages(run: AuditLog): PipelineStage[] {
  const isFailed = run.status === 'FAILED';
  const attempts = run.validationAttempts || 1;
  const repo = run.repo ?? 'unknown_repo';
  const branch = run.branch ?? 'main';

  const stages: PipelineStage[] = [
    {
      node: 'onboarding',
      label: 'Onboarding',
      status: 'completed',
      output: `Repository cloned: ${repo}\nBase branch: ${branch}`,
    },
    {
      node: 'analyzer',
      label: 'Analyzer',
      status: 'completed',
      output: run.triageContext
        ? run.triageContext
        : `Issue type: bug\nLikely files: (not recorded)`,
    },
    {
      node: 'research',
      label: 'Research',
      status: 'completed',
      output: run.researchContext ?? 'Research context not recorded.',
    },
    {
      node: 'planner',
      label: 'Planner',
      status: 'completed',
      output: run.implementationPlan ?? 'Implementation plan not recorded.',
    },
    {
      node: 'patcher',
      label: 'Patcher',
      status: 'completed',
      output: run.generatedPatch
        ? `Patch applied (${run.generatedPatch.split('\n').length} lines).`
        : 'No patch generated.',
    },
    {
      node: 'validator',
      label: 'Validator',
      status: isFailed ? 'failed' : 'completed',
      attempt: attempts,
      output: isFailed
        ? run.finalValidationFeedback ?? 'Validation failed'
        : `All validations passed after ${attempts} attempt(s).`,
    },
    {
      node: 'git',
      label: 'Git / PR',
      status: isFailed ? 'pending' : 'completed',
      output: isFailed
        ? undefined
        : run.prUrl
          ? `Branch: ${run.branch ?? branch}\nPR: ${run.prUrl}`
          : `Branch: ${run.branch ?? branch} pushed.`,
    },
  ];

  // For failed runs with multiple attempts, surface the loop count on the
  // validator stage — matches the mock's behaviour.
  if (isFailed && attempts > 1) {
    stages[5] = {
      ...stages[5],
      status: 'failed',
      attempt: attempts,
      output: `Attempt ${attempts} failed.\n${run.finalValidationFeedback ?? ''}`,
    };
  }

  return stages;
}

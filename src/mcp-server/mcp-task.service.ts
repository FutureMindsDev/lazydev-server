import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, type JobProgress } from 'bullmq';
import { randomUUID } from 'crypto';
import { AuditLogService } from '../orchestration/audit-log.service';
import { HumanFeedbackService } from '../feedback/human-feedback.service';
import type { IssueJobData } from '../ingestion/issue.processor';

export type TaskState =
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'unknown';

export interface TaskStatus {
  taskId: string;
  state: TaskState;
  repository?: string;
  issueNumber?: number;
  progress?: JobProgress;
  failedReason?: string;
  attemptsMade?: number;
  /** True when the status was recovered from the audit log rather than the queue. */
  fromAuditLog?: boolean;
}

/**
 * Bridges MCP tool calls to the BullMQ `issue-processing` pipeline.
 *
 * `task_id` is intentionally the BullMQ job id, so status lookups are a direct
 * `queue.getJob(taskId)` with no extra bookkeeping.
 */
@Injectable()
export class McpTaskService {
  private readonly logger = new Logger(McpTaskService.name);

  constructor(
    @InjectQueue('issue-processing') private readonly issueQueue: Queue,
    private readonly auditLogService: AuditLogService,
    private readonly feedbackService: HumanFeedbackService,
  ) {}

  /**
   * Enqueues a pipeline run and returns the generated task id.
   *
   * `urgent` uses BullMQ's priority so the job runs ahead of everything already
   * waiting. The worker is single-concurrency, so this only reorders the queue —
   * it never interrupts a job that is already running.
   */
  async enqueueTask(
    data: IssueJobData,
    options: { urgent?: boolean } = {},
  ): Promise<string> {
    const taskId = `mcp-${randomUUID()}`;

    await this.issueQueue.add('process-issue', data, {
      jobId: taskId,
      // Keep terminal jobs around long enough for a chat client to poll status.
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 86_400 },
      // BullMQ: lower number = higher priority; omit for normal FIFO order.
      ...(options.urgent ? { priority: 1 } : {}),
    });

    this.logger.log(
      `Queued MCP task ${taskId} for ${data.repository}#${data.issueNumber}${
        options.urgent ? ' (urgent)' : ''
      }`,
    );
    return taskId;
  }

  /**
   * Finds a queued or running job already targeting this issue, whatever
   * queued it.
   *
   * Without this, asking the agent to fix an issue that the `issues.opened`
   * webhook has already queued would run the whole pipeline twice: the two jobs
   * carry different job ids so BullMQ cannot dedupe them, and the issue lock
   * only prevents *concurrent* runs (the worker is single-concurrency, so the
   * duplicate simply runs afterwards) — burning LLM tokens and force-pushing
   * over the first run's branch.
   */
  async findInFlightTask(
    repository: string,
    issueNumber: number,
  ): Promise<string | null> {
    const jobs = await this.issueQueue.getJobs([
      'waiting',
      'active',
      'delayed',
      'prioritized',
    ]);

    const match = jobs.find((job) => {
      const data = job.data as IssueJobData | undefined;
      return (
        data?.repository === repository && data?.issueNumber === issueNumber
      );
    });

    return match?.id ?? null;
  }

  /**
   * Resolves the state of a task. Falls back to the audit log when the job has
   * already been evicted from Redis.
   */
  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const job = await this.issueQueue.getJob(taskId);

    if (job) {
      const state = (await job.getState()) as TaskState;
      const jobData = job.data as IssueJobData;
      return {
        taskId,
        state,
        repository: jobData?.repository,
        issueNumber: jobData?.issueNumber,
        progress: job.progress,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
      };
    }

    const audit = await this.auditLogService.findByTaskId(taskId);
    if (audit) {
      return {
        taskId,
        state: audit.status === 'SUCCESS' ? 'completed' : 'failed',
        issueNumber: audit.issueNumber,
        failedReason: audit.finalValidationFeedback ?? undefined,
        fromAuditLog: true,
      };
    }

    return { taskId, state: 'unknown' };
  }

  /**
   * Stores human feedback for a task. The orchestration graph consumes this at
   * the validator retry boundary and merges it into `validationFeedback`.
   */
  async storeFeedback(taskId: string, feedback: string): Promise<void> {
    await this.feedbackService.store(taskId, feedback);
  }

  /**
   * Re-runs an already-failed task with the human feedback appended to the
   * issue body, so the pipeline sees the correction on its next attempt.
   */
  async requeueWithFeedback(
    taskId: string,
    feedback: string,
  ): Promise<string | null> {
    const job = await this.issueQueue.getJob(taskId);
    if (!job) return null;

    const original = job.data as IssueJobData;
    return this.enqueueTask({
      ...original,
      body: `${original.body ?? ''}\n\n---\n\n### Human feedback (via MCP)\n${feedback}`,
    });
  }
}

import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { JobsOptions } from 'bullmq';
import { McpTaskService } from './mcp-task.service';
import { AuditLogService } from '../orchestration/audit-log.service';
import { HumanFeedbackService } from '../feedback/human-feedback.service';
import type { IssueJobData } from '../ingestion/issue.processor';

/** Reads a recorded mock call as a typed tuple (jest.Mock defaults to `any`). */
const nthCall = <T extends unknown[]>(mock: jest.Mock, n: number): T =>
  mock.mock.calls[n] as T;

type AddCall = [string, IssueJobData, JobsOptions];

const jobData: IssueJobData = {
  repository: 'acme/widgets',
  issueNumber: 42,
  title: 'Broken thing',
  body: 'It is broken',
  action: 'mcp_trigger_issue_fix',
  installationId: 999,
  labels: ['bug'],
};

describe('McpTaskService', () => {
  let service: McpTaskService;
  let queue: { add: jest.Mock; getJob: jest.Mock };
  let auditLog: { findByTaskId: jest.Mock };
  let feedback: { store: jest.Mock };

  beforeEach(async () => {
    queue = { add: jest.fn().mockResolvedValue(undefined), getJob: jest.fn() };
    auditLog = { findByTaskId: jest.fn().mockResolvedValue(null) };
    feedback = { store: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpTaskService,
        { provide: getQueueToken('issue-processing'), useValue: queue },
        { provide: AuditLogService, useValue: auditLog },
        { provide: HumanFeedbackService, useValue: feedback },
      ],
    }).compile();

    service = module.get(McpTaskService);
  });

  describe('enqueueTask', () => {
    it('generates an mcp- prefixed task id and uses it as the BullMQ job id', async () => {
      const taskId = await service.enqueueTask(jobData);

      expect(taskId).toMatch(/^mcp-[0-9a-f-]{36}$/);
      expect(queue.add).toHaveBeenCalledWith(
        'process-issue',
        jobData,
        expect.objectContaining({ jobId: taskId }),
      );
    });

    it('retains terminal jobs long enough to be polled', async () => {
      await service.enqueueTask(jobData);

      const [, , options] = nthCall<AddCall>(queue.add, 0);
      expect(options.removeOnComplete).toEqual({ age: 86_400 });
      expect(options.removeOnFail).toEqual({ age: 86_400 });
    });

    it('adds no priority for a normal task (plain FIFO)', async () => {
      await service.enqueueTask(jobData);

      const [, , options] = nthCall<AddCall>(queue.add, 0);
      expect(options.priority).toBeUndefined();
    });

    it('sets BullMQ priority 1 for an urgent task', async () => {
      await service.enqueueTask(jobData, { urgent: true });

      const [, , options] = nthCall<AddCall>(queue.add, 0);
      expect(options.priority).toBe(1);
    });

    it('produces a unique task id per call', async () => {
      const first = await service.enqueueTask(jobData);
      const second = await service.enqueueTask(jobData);
      expect(first).not.toEqual(second);
    });
  });

  describe('getTaskStatus', () => {
    it.each(['waiting', 'active', 'completed', 'failed', 'delayed'])(
      'reports the live queue state "%s"',
      async (state) => {
        queue.getJob.mockResolvedValue({
          data: jobData,
          getState: jest.fn().mockResolvedValue(state),
          progress: 0,
          attemptsMade: 1,
        });

        const status = await service.getTaskStatus('mcp-1');

        expect(status.state).toBe(state);
        expect(status.repository).toBe('acme/widgets');
        expect(status.issueNumber).toBe(42);
        expect(status.fromAuditLog).toBeUndefined();
      },
    );

    it('surfaces the failure reason for failed jobs', async () => {
      queue.getJob.mockResolvedValue({
        data: jobData,
        getState: jest.fn().mockResolvedValue('failed'),
        failedReason: 'validation failed 3 times',
        attemptsMade: 3,
      });

      const status = await service.getTaskStatus('mcp-1');

      expect(status.failedReason).toBe('validation failed 3 times');
      expect(status.attemptsMade).toBe(3);
    });

    it('falls back to the audit log once the job is evicted from Redis', async () => {
      queue.getJob.mockResolvedValue(null);
      auditLog.findByTaskId.mockResolvedValue({
        status: 'SUCCESS',
        issueNumber: 7,
        finalValidationFeedback: null,
      });

      const status = await service.getTaskStatus('mcp-old');

      expect(status.state).toBe('completed');
      expect(status.issueNumber).toBe(7);
      expect(status.fromAuditLog).toBe(true);
    });

    it('maps a FAILED audit record to the failed state', async () => {
      queue.getJob.mockResolvedValue(null);
      auditLog.findByTaskId.mockResolvedValue({
        status: 'FAILED',
        issueNumber: 7,
        finalValidationFeedback: 'tests did not pass',
      });

      const status = await service.getTaskStatus('mcp-old');

      expect(status.state).toBe('failed');
      expect(status.failedReason).toBe('tests did not pass');
    });

    it('returns "unknown" when neither the queue nor the audit log knows the task', async () => {
      queue.getJob.mockResolvedValue(null);

      const status = await service.getTaskStatus('mcp-nope');

      expect(status.state).toBe('unknown');
    });
  });

  describe('findInFlightTask', () => {
    it('finds a queued/running job for the same issue whatever queued it', async () => {
      queue.getJobs = jest.fn().mockResolvedValue([
        { id: 'mcp-other', data: { ...jobData, issueNumber: 7 } },
        { id: 'gh-delivery-abc', data: jobData },
      ]);

      const found = await service.findInFlightTask('acme/widgets', 42);

      expect(found).toBe('gh-delivery-abc');
      expect(queue.getJobs).toHaveBeenCalledWith([
        'waiting',
        'active',
        'delayed',
        'prioritized',
      ]);
    });

    it('returns null when no in-flight job targets the issue', async () => {
      queue.getJobs = jest
        .fn()
        .mockResolvedValue([
          { id: 'mcp-other', data: { ...jobData, issueNumber: 7 } },
        ]);

      expect(await service.findInFlightTask('acme/widgets', 42)).toBeNull();
    });

    it('does not match the same issue number in a different repository', async () => {
      queue.getJobs = jest
        .fn()
        .mockResolvedValue([
          { id: 'other-repo', data: { ...jobData, repository: 'acme/other' } },
        ]);

      expect(await service.findInFlightTask('acme/widgets', 42)).toBeNull();
    });
  });

  describe('storeFeedback', () => {
    it('delegates to the shared feedback store', async () => {
      await service.storeFeedback('mcp-1', 'use a Map instead');
      expect(feedback.store).toHaveBeenCalledWith('mcp-1', 'use a Map instead');
    });
  });

  describe('requeueWithFeedback', () => {
    it('re-enqueues the original job with the feedback appended to the body', async () => {
      queue.getJob.mockResolvedValue({ data: jobData });

      const newTaskId = await service.requeueWithFeedback(
        'mcp-old',
        'use a Map instead',
      );

      expect(newTaskId).toMatch(/^mcp-/);
      expect(newTaskId).not.toBe('mcp-old');

      const [, requeued] = nthCall<AddCall>(queue.add, 0);
      expect(requeued.repository).toBe('acme/widgets');
      expect(requeued.issueNumber).toBe(42);
      expect(requeued.body).toContain('It is broken');
      expect(requeued.body).toContain('Human feedback (via MCP)');
      expect(requeued.body).toContain('use a Map instead');
    });

    it('returns null when the original job data has expired', async () => {
      queue.getJob.mockResolvedValue(null);

      expect(
        await service.requeueWithFeedback('mcp-gone', 'fix it'),
      ).toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});

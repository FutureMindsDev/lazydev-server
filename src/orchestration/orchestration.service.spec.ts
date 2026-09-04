import { Test, TestingModule } from '@nestjs/testing';
import { OrchestrationService } from './orchestration.service';
import { AuditLogService } from './audit-log.service';
import { HumanFeedbackService } from '../feedback/human-feedback.service';
import { OnboardingAgent } from './agents/onboarding.agent';
import { PlannerAgent } from './agents/planner.agent';
import { PatchGeneratorAgent } from './agents/patch-generator.agent';
import { ValidationAgent } from './agents/validation.agent';
import { GitAgent } from './agents/git.agent';
import type { AgentState } from './graph.state';

/** Reads a recorded mock call as a typed tuple (jest.Mock defaults to `any`). */
const nthCall = <T extends unknown[]>(mock: jest.Mock, n: number): T =>
  mock.mock.calls[n] as T;

/**
 * Covers the MCP human-feedback path through the compiled LangGraph: feedback
 * submitted while a task is running must reach the patcher on its retry.
 */
describe('OrchestrationService — human feedback integration', () => {
  let service: OrchestrationService;
  let patcher: { invoke: jest.Mock };
  let validator: { invoke: jest.Mock };
  let git: { invoke: jest.Mock };
  let feedbackService: { consume: jest.Mock };

  const passThrough = () => ({ invoke: jest.fn().mockResolvedValue({}) });

  const run = (payload: Record<string, unknown>) =>
    service.runPipeline(payload);

  beforeEach(async () => {
    patcher = {
      invoke: jest.fn().mockResolvedValue({ generatedPatch: 'diff' }),
    };
    git = { invoke: jest.fn().mockResolvedValue({}) };
    feedbackService = { consume: jest.fn().mockResolvedValue(null) };

    // Fail the first validation, then pass — exercising exactly one retry.
    let attempt = 0;
    validator = {
      invoke: jest.fn().mockImplementation(() => {
        attempt += 1;
        return Promise.resolve(
          attempt === 1
            ? {
                isValid: false,
                validationAttempts: 1,
                validationFeedback: 'tests failed',
              }
            : { isValid: true, validationAttempts: attempt },
        );
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrchestrationService,
        { provide: OnboardingAgent, useValue: passThrough() },
        { provide: PlannerAgent, useValue: passThrough() },
        { provide: PatchGeneratorAgent, useValue: patcher },
        { provide: ValidationAgent, useValue: validator },
        { provide: GitAgent, useValue: git },
        {
          provide: AuditLogService,
          useValue: {
            logPipelineOutcome: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: HumanFeedbackService, useValue: feedbackService },
      ],
    }).compile();

    service = module.get(OrchestrationService);
    service.onModuleInit();
  });

  it('passes human feedback to the patcher on the validation retry', async () => {
    feedbackService.consume.mockResolvedValue('Use a Map, not nested loops');

    await run({ taskId: 'mcp-1', issue: { number: 1, title: 't', body: 'b' } });

    expect(feedbackService.consume).toHaveBeenCalledWith('mcp-1');
    expect(patcher.invoke).toHaveBeenCalledTimes(2);

    const [retryState] = nthCall<[AgentState]>(patcher.invoke, 1);
    expect(retryState.validationFeedback).toContain(
      'Use a Map, not nested loops',
    );
    // The automated validation output must be preserved alongside it.
    expect(retryState.validationFeedback).toContain('tests failed');
  });

  it('leaves validation feedback untouched when no human feedback exists', async () => {
    await run({ taskId: 'mcp-1', issue: { number: 1, title: 't', body: 'b' } });

    const [retryState] = nthCall<[AgentState]>(patcher.invoke, 1);
    expect(retryState.validationFeedback).toBe('tests failed');
  });

  it('skips the feedback lookup when the run has no taskId', async () => {
    await run({ issue: { number: 1, title: 't', body: 'b' } });

    expect(feedbackService.consume).not.toHaveBeenCalled();
    expect(patcher.invoke).toHaveBeenCalledTimes(2);
  });

  it('does not block the retry loop when the feedback store errors', async () => {
    feedbackService.consume.mockRejectedValue(new Error('redis down'));

    const finalState = await run({
      taskId: 'mcp-1',
      issue: { number: 1, title: 't', body: 'b' },
    });

    expect(patcher.invoke).toHaveBeenCalledTimes(2);
    expect(finalState.isValid).toBe(true);
    expect(git.invoke).toHaveBeenCalled();
  });

  it('never consumes feedback when validation passes first time', async () => {
    validator.invoke.mockReset();
    validator.invoke.mockResolvedValue({
      isValid: true,
      validationAttempts: 1,
    });

    await run({ taskId: 'mcp-1', issue: { number: 1, title: 't', body: 'b' } });

    expect(feedbackService.consume).not.toHaveBeenCalled();
    expect(patcher.invoke).toHaveBeenCalledTimes(1);
    expect(git.invoke).toHaveBeenCalled();
  });
});

/**
 * Verifies that when the LangGraph pipeline throws (e.g.
 * GraphRecursionError, patch-generation failure, or any unhandled agent
 * exception), a FAILED audit log entry is still persisted so the dashboard
 * can surface the run with its failure reason and timestamps.
 *
 * Without this, a crashed job shows up in BullMQ's failed count but not in
 * the dashboard's runs list, throughput chart, or KPI cards — the exact
 * "0 for today" bug we're hotfixing.
 */
describe('OrchestrationService — audit log on pipeline exception', () => {
  let service: OrchestrationService;
  let auditLogService: { logPipelineOutcome: jest.Mock };

  const passThrough = () => ({ invoke: jest.fn().mockResolvedValue({}) });

  beforeEach(async () => {
    auditLogService = {
      logPipelineOutcome: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrchestrationService,
        { provide: OnboardingAgent, useValue: passThrough() },
        { provide: PlannerAgent, useValue: passThrough() },
        { provide: PatchGeneratorAgent, useValue: passThrough() },
        { provide: ValidationAgent, useValue: passThrough() },
        { provide: GitAgent, useValue: passThrough() },
        { provide: AuditLogService, useValue: auditLogService },
        {
          provide: HumanFeedbackService,
          useValue: { consume: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get(OrchestrationService);
    service.onModuleInit();
  });

  it('writes a FAILED audit log when the planner throws GraphRecursionError', async () => {
    // Make the planner node throw — simulates the recursion-limit death spiral.
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrchestrationService,
        { provide: OnboardingAgent, useValue: passThrough() },
        {
          provide: PlannerAgent,
          useValue: {
            invoke: jest
              .fn()
              .mockRejectedValue(new Error('GraphRecursionError: Recursion limit of 100 reached')),
            getTools: jest.fn().mockReturnValue([]),
          },
        },
        { provide: PatchGeneratorAgent, useValue: passThrough() },
        { provide: ValidationAgent, useValue: passThrough() },
        { provide: GitAgent, useValue: passThrough() },
        { provide: AuditLogService, useValue: auditLogService },
        {
          provide: HumanFeedbackService,
          useValue: { consume: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get(OrchestrationService);
    service.onModuleInit();

    await expect(
      service.runPipeline({
        taskId: 'gh-delivery-fd424370',
        issue: { number: 4, title: 'ai-calendar issue', body: 'b' },
        repository: { full_name: 'arkar-chanmyae/ai-calendar' },
        installation: { id: 123 },
      }),
    ).rejects.toThrow('GraphRecursionError');

    // The audit log must have been called with isValid: false (→ FAILED).
    expect(auditLogService.logPipelineOutcome).toHaveBeenCalledTimes(1);
    const [loggedState] = auditLogService.logPipelineOutcome.mock.calls[0] as [
      AgentState,
    ];
    expect(loggedState.isValid).toBe(false);
    expect(loggedState.validationFeedback).toContain('GraphRecursionError');
    expect(loggedState.issuePayload?.taskId).toBe('gh-delivery-fd424370');
    expect(loggedState.issuePayload?.issue?.number).toBe(4);
  });

  it('re-throws the original error after writing the audit log', async () => {
    const originalError = new Error('Patch generation failed: No valid code changes applied.');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrchestrationService,
        { provide: OnboardingAgent, useValue: passThrough() },
        { provide: PlannerAgent, useValue: passThrough() },
        {
          provide: PatchGeneratorAgent,
          useValue: { invoke: jest.fn().mockRejectedValue(originalError), getToolsForSession: jest.fn().mockReturnValue([]) },
        },
        { provide: ValidationAgent, useValue: passThrough() },
        { provide: GitAgent, useValue: passThrough() },
        { provide: AuditLogService, useValue: auditLogService },
        {
          provide: HumanFeedbackService,
          useValue: { consume: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get(OrchestrationService);
    service.onModuleInit();

    await expect(
      service.runPipeline({
        taskId: 'test-throw',
        issue: { number: 9, title: 't', body: 'b' },
      }),
    ).rejects.toBe(originalError);

    expect(auditLogService.logPipelineOutcome).toHaveBeenCalledTimes(1);
    const [loggedState] = auditLogService.logPipelineOutcome.mock.calls[0] as [
      AgentState,
    ];
    expect(loggedState.isValid).toBe(false);
    expect(loggedState.validationFeedback).toContain(
      'Patch generation failed',
    );
  });
});

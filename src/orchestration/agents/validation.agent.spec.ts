import { Test, TestingModule } from '@nestjs/testing';
import { ValidationAgent } from './validation.agent';
import { ValidationService } from '../../validation/validation.service';
import { SerenaMcpService } from '../../intelligence/serena-mcp.service';
import { LlmService } from '../llm.service';
import type { AgentState } from '../graph.state';

/**
 * Covers the memory-persistence fix for `historical_issues_and_lessons`:
 * memories live under `<active project>/.serena/memories/`, and the worktree
 * is deleted at the end of every job, so the log must be read/written against
 * the persistent repo-cache clone (`repoPath`), not the worktree, or every
 * "lesson learned" entry would vanish before it could ever inform a future
 * fix.
 */
describe('ValidationAgent — historical_issues_and_lessons persistence', () => {
  let agent: ValidationAgent;
  let serenaMcp: {
    activateProject: jest.Mock;
    readMemory: jest.Mock;
    writeMemory: jest.Mock;
  };
  let llmModel: { invoke: jest.Mock };

  const nthCall = <T extends unknown[]>(mock: jest.Mock, n: number): T =>
    mock.mock.calls[n] as T;

  const stateWith = (overrides: Record<string, unknown> = {}): AgentState =>
    ({
      generatedPatch: 'Applied changes:\nCREATE src/new.ts',
      implementationPlan: 'Add the handler',
      issuePayload: {
        issue: { title: 'Login button unresponsive' },
        worktreePath: '/app/worktrees/mcp-test',
        repoPath: '/app/repo-cache/acme/widgets',
        ...overrides,
      },
    }) as unknown as AgentState;

  beforeEach(async () => {
    serenaMcp = {
      activateProject: jest.fn().mockResolvedValue(undefined),
      readMemory: jest.fn().mockResolvedValue({
        isError: false,
        content: [{ text: JSON.stringify({ entries: [] }) }],
      }),
      writeMemory: jest.fn().mockResolvedValue({ isError: false }),
    };
    llmModel = {
      invoke: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          issue: 'Login button unresponsive',
          solution: 'Fixed missing onClick handler',
          lessons_learned: 'Always check event bindings first',
        }),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidationAgent,
        { provide: ValidationService, useValue: {} },
        { provide: SerenaMcpService, useValue: serenaMcp },
        { provide: LlmService, useValue: { getModel: () => llmModel } },
      ],
    }).compile();

    agent = module.get(ValidationAgent);
  });

  // Exercised directly rather than through invoke(): ValidationAgent fires
  // this fire-and-forget (`.catch(...)`, never awaited by the caller) so it
  // doesn't block returning validation state — testing it directly keeps
  // these assertions deterministic instead of racing a background promise.
  const callUpdateLessonsLearned = (
    state: AgentState,
    worktreePath: string,
    repoPath?: string,
  ): Promise<void> =>
    (
      agent as unknown as {
        updateLessonsLearned: (
          s: AgentState,
          w: string,
          r?: string,
        ) => Promise<void>;
      }
    ).updateLessonsLearned(state, worktreePath, repoPath);

  it('activates the persistent repoPath before reading/writing the log', async () => {
    await callUpdateLessonsLearned(
      stateWith(),
      '/app/worktrees/mcp-test',
      '/app/repo-cache/acme/widgets',
    );

    const [firstActivatedPath] = nthCall<[string]>(
      serenaMcp.activateProject,
      0,
    );
    expect(firstActivatedPath).toBe('/app/repo-cache/acme/widgets');
  });

  it('reads and writes with only memory_name (current Serena schema)', async () => {
    await callUpdateLessonsLearned(
      stateWith(),
      '/app/worktrees/mcp-test',
      '/app/repo-cache/acme/widgets',
    );

    expect(serenaMcp.readMemory).toHaveBeenCalledWith(
      'historical_issues_and_lessons',
    );
    const [writtenName, writtenContent] = nthCall<[string, string]>(
      serenaMcp.writeMemory,
      0,
    );
    expect(writtenName).toBe('historical_issues_and_lessons');
    const parsed = JSON.parse(writtenContent) as {
      entries: { lessons_learned: string }[];
    };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].lessons_learned).toBe(
      'Always check event bindings first',
    );
  });

  it('appends to existing entries rather than overwriting them', async () => {
    serenaMcp.readMemory.mockResolvedValue({
      isError: false,
      content: [
        {
          text: JSON.stringify({
            entries: [
              { issue: 'Old issue', solution: 'x', lessons_learned: 'y' },
            ],
          }),
        },
      ],
    });

    await callUpdateLessonsLearned(
      stateWith(),
      '/app/worktrees/mcp-test',
      '/app/repo-cache/acme/widgets',
    );

    const [, writtenContent] = nthCall<[string, string]>(
      serenaMcp.writeMemory,
      0,
    );
    const parsed = JSON.parse(writtenContent) as {
      entries: { issue: string }[];
    };
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].issue).toBe('Old issue');
  });

  it('reactivates the worktree afterward so a retry still targets the real checkout', async () => {
    await callUpdateLessonsLearned(
      stateWith(),
      '/app/worktrees/mcp-test',
      '/app/repo-cache/acme/widgets',
    );

    const calls = serenaMcp.activateProject.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(calls[calls.length - 1]).toBe('/app/worktrees/mcp-test');
  });

  it('falls back to worktreePath when repoPath is missing', async () => {
    await callUpdateLessonsLearned(
      stateWith(),
      '/app/worktrees/mcp-test',
      undefined,
    );

    const [firstActivatedPath] = nthCall<[string]>(
      serenaMcp.activateProject,
      0,
    );
    expect(firstActivatedPath).toBe('/app/worktrees/mcp-test');
  });

  it('logs a warning instead of a false success when the write actually fails', async () => {
    serenaMcp.writeMemory.mockResolvedValue({
      isError: true,
      content: [{ text: 'validation error' }],
    });
    const warnSpy = jest.spyOn(
      (agent as unknown as { logger: { warn: (...a: unknown[]) => void } })
        .logger,
      'warn',
    );

    await callUpdateLessonsLearned(
      stateWith(),
      '/app/worktrees/mcp-test',
      '/app/repo-cache/acme/widgets',
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write historical_issues_and_lessons'),
    );
  });

  it('never calls Serena when the LLM fails to produce a parseable lesson', async () => {
    llmModel.invoke.mockResolvedValue({ content: 'not json' });

    await callUpdateLessonsLearned(
      stateWith(),
      '/app/worktrees/mcp-test',
      '/app/repo-cache/acme/widgets',
    );

    expect(serenaMcp.activateProject).not.toHaveBeenCalled();
    expect(serenaMcp.writeMemory).not.toHaveBeenCalled();
  });

  describe('invoke — no-patch attempt accounting', () => {
    /**
     * Regression: the "no patch generated" early return used to omit
     * validationAttempts, leaving the counter at 0 forever. The validator's
     * retry edge (`attempts < 3`) then never terminated — an empty plan
     * looped patcher → validator → human_feedback until GraphRecursionError.
     */
    it('increments validationAttempts when no patch was generated', async () => {
      const state = {
        implementationPlan: 'Add the handler',
        issuePayload: { worktreePath: '/app/worktrees/mcp-test' },
      } as unknown as AgentState;

      const result = await agent.invoke(state);

      expect(result.isValid).toBe(false);
      expect(result.validationFeedback).toBe('No patch found.');
      expect(result.validationAttempts).toBe(1);
    });

    it('keeps counting from prior attempts so the graph aborts after 3', async () => {
      const state = {
        validationAttempts: 2,
        implementationPlan: 'Add the handler',
        issuePayload: { worktreePath: '/app/worktrees/mcp-test' },
      } as unknown as AgentState;

      const result = await agent.invoke(state);

      expect(result.validationAttempts).toBe(3);
    });
  });

  describe('invoke() gating', () => {
    it('does not trigger the lessons-learned flow at all when the feature flag is off', async () => {
      const original = process.env.ENABLE_SERENA_ISSUE_HISTORY;
      process.env.ENABLE_SERENA_ISSUE_HISTORY = 'false';

      const validationService = {
        validateWorktree: jest.fn().mockResolvedValue({
          success: true,
          language: 'NODEJS',
          stdout: 'ok',
        }),
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ValidationAgent,
          { provide: ValidationService, useValue: validationService },
          { provide: SerenaMcpService, useValue: serenaMcp },
          { provide: LlmService, useValue: { getModel: () => llmModel } },
        ],
      }).compile();
      const gatedAgent = module.get(ValidationAgent);

      await gatedAgent.invoke(stateWith());
      // Flush any stray microtasks so a false-positive async call would surface.
      await new Promise((resolve) => setImmediate(resolve));

      expect(serenaMcp.activateProject).not.toHaveBeenCalled();
      process.env.ENABLE_SERENA_ISSUE_HISTORY = original;
    });
  });
});

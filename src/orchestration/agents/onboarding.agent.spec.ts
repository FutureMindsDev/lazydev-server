import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import { OnboardingAgent } from './onboarding.agent';
import { LlmService } from '../llm.service';
import { SerenaMcpService } from '../../intelligence/serena-mcp.service';
import type { AgentState } from '../graph.state';

/**
 * Covers the memory-persistence fix: memories physically live under
 * `<active project>/.serena/memories/`, and the worktree is deleted at the
 * end of every job — so writing global_repo_structure while the worktree is
 * the active project means it's gone before the next job could ever read it.
 * OnboardingAgent must activate the persistent repoPath for the write.
 */
describe('OnboardingAgent — memory persistence', () => {
  let agent: OnboardingAgent;
  let serenaMcp: {
    activateProject: jest.Mock;
    listMemories: jest.Mock;
    writeMemory: jest.Mock;
  };
  let llmModel: { invoke: jest.Mock };

  const nthCall = <T extends unknown[]>(mock: jest.Mock, n: number): T =>
    mock.mock.calls[n] as T;

  const stateWith = (overrides: Record<string, unknown> = {}): AgentState =>
    ({
      issuePayload: {
        worktreePath: '/app/worktrees/mcp-test',
        repoPath: '/app/repo-cache/acme/widgets',
        ...overrides,
      },
    }) as unknown as AgentState;

  const originalEnableMemories = process.env.ENABLE_SERENA_MEMORIES;
  const originalEnableHistory = process.env.ENABLE_SERENA_ISSUE_HISTORY;

  beforeEach(async () => {
    process.env.ENABLE_SERENA_MEMORIES = 'true';
    process.env.ENABLE_SERENA_ISSUE_HISTORY = 'false';

    serenaMcp = {
      activateProject: jest.fn().mockResolvedValue(undefined),
      listMemories: jest.fn().mockResolvedValue({}),
      writeMemory: jest.fn().mockResolvedValue({ isError: false }),
    };
    llmModel = {
      invoke: jest.fn().mockResolvedValue({ content: 'A Next.js app.' }),
    };

    jest.spyOn(fs.promises, 'readdir').mockResolvedValue([] as never);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingAgent,
        { provide: LlmService, useValue: { getModel: () => llmModel } },
        { provide: SerenaMcpService, useValue: serenaMcp },
      ],
    }).compile();

    agent = module.get(OnboardingAgent);
  });

  afterEach(() => {
    process.env.ENABLE_SERENA_MEMORIES = originalEnableMemories;
    process.env.ENABLE_SERENA_ISSUE_HISTORY = originalEnableHistory;
    jest.restoreAllMocks();
  });

  it('activates the persistent repoPath before writing global_repo_structure', async () => {
    await agent.invoke(stateWith());

    const [firstActivatedPath] = nthCall<[string]>(
      serenaMcp.activateProject,
      0,
    );
    expect(firstActivatedPath).toBe('/app/repo-cache/acme/widgets');
  });

  it('writes with only memory_name + content (current Serena schema)', async () => {
    await agent.invoke(stateWith());

    expect(serenaMcp.writeMemory).toHaveBeenCalledWith(
      'global_repo_structure',
      'A Next.js app.',
    );
  });

  it('reactivates the worktree afterward so later agents target the real checkout', async () => {
    await agent.invoke(stateWith());

    const calls = serenaMcp.activateProject.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(calls[calls.length - 1]).toBe('/app/worktrees/mcp-test');
  });

  it('falls back to worktreePath when repoPath is missing', async () => {
    await agent.invoke(stateWith({ repoPath: undefined }));

    const [firstActivatedPath] = nthCall<[string]>(
      serenaMcp.activateProject,
      0,
    );
    expect(firstActivatedPath).toBe('/app/worktrees/mcp-test');
  });

  it('skips the write when global_repo_structure already exists', async () => {
    serenaMcp.listMemories.mockResolvedValue({
      content: [{ text: '{"memories":["global_repo_structure"]}' }],
    });

    await agent.invoke(stateWith());

    expect(serenaMcp.writeMemory).not.toHaveBeenCalled();
  });

  it('logs the failure instead of a false success when the write actually fails', async () => {
    serenaMcp.writeMemory.mockResolvedValue({
      isError: true,
      content: [{ text: 'validation error' }],
    });
    const errorSpy = jest.spyOn(
      (agent as unknown as { logger: { error: (...a: unknown[]) => void } })
        .logger,
      'error',
    );

    await agent.invoke(stateWith());

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write global_repo_structure'),
    );
  });

  it('does nothing when ENABLE_SERENA_MEMORIES is not "true"', async () => {
    process.env.ENABLE_SERENA_MEMORIES = 'false';

    await agent.invoke(stateWith());

    expect(serenaMcp.activateProject).not.toHaveBeenCalled();
  });
});

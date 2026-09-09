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

import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs/promises';
import { GitAgent } from './git.agent';
import { GitService } from '../../git/git.service';
import { GithubService } from '../../github/github.service';
import { SerenaMcpService } from '../../intelligence/serena-mcp.service';
import type { AgentState } from '../graph.state';

jest.mock('fs/promises');
const mockedFs = fs as jest.Mocked<typeof fs>;

/**
 * Guards the fix-vs-feature naming contract. The repo enforces conventional
 * commits, so a feature must commit as `feat:` — never `fix:` — and its PR must
 * not end up titled "Fix: Feature: ...".
 */
describe('GitAgent naming', () => {
  let agent: GitAgent;
  let gitService: {
    buildBranchName: jest.Mock;
    createFixBranch: jest.Mock;
    commitAndPush: jest.Mock;
  };
  let pullsCreate: jest.Mock;

  interface PrParams {
    title: string;
    body: string;
  }

  const nthCall = <T extends unknown[]>(mock: jest.Mock, n: number): T =>
    mock.mock.calls[n] as T;

  const stateFor = (
    kind?: string,
    overrides: Partial<AgentState> = {},
  ): AgentState =>
    ({
      isValid: true,
      implementationPlan: 'Add the handler',
      ...overrides,
      issuePayload: {
        issue: {
          number: 501,
          title:
            kind === 'feature'
              ? 'Feature: Add a health endpoint'
              : 'Payment times out',
        },
        repository: {
          name: 'widgets',
          owner: { login: 'acme' },
          default_branch: 'main',
        },
        installation: { id: 1 },
        worktreePath: '/tmp/wt',
        repoPath: '/repo-cache/acme/widgets',
        kind,
      },
    }) as unknown as AgentState;

  let serenaMcp: { activateProject: jest.Mock; readMemory: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    gitService = {
      buildBranchName: jest.fn().mockReturnValue('lazydev/branch'),
      createFixBranch: jest.fn().mockResolvedValue(undefined),
      commitAndPush: jest.fn().mockResolvedValue(undefined),
    };
    pullsCreate = jest.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/acme/widgets/pull/9' },
    });
    serenaMcp = {
      activateProject: jest.fn().mockResolvedValue(undefined),
      readMemory: jest.fn().mockResolvedValue({ isError: true }),
    };
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.writeFile.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitAgent,
        { provide: GitService, useValue: gitService },
        {
          provide: GithubService,
          useValue: {
            getInstallationOctokit: jest
              .fn()
              .mockResolvedValue({ rest: { pulls: { create: pullsCreate } } }),
          },
        },
        { provide: SerenaMcpService, useValue: serenaMcp },
      ],
    }).compile();

    agent = module.get(GitAgent);
  });

  describe('a fix (webhook-driven, no kind)', () => {
    beforeEach(async () => {
      await agent.invoke(stateFor());
    });

    it('builds a fix branch', () => {
      expect(gitService.buildBranchName).toHaveBeenCalledWith(
        501,
        'Payment times out',
        'fix',
      );
    });

    it('commits with the fix: conventional type', () => {
      const [, message] = nthCall<[string, string, string]>(
        gitService.commitAndPush,
        0,
      );
      expect(message).toMatch(/^fix: resolve issue #501/);
    });

    it('titles the PR with the Fix: prefix', () => {
      const [pr] = nthCall<[PrParams]>(pullsCreate, 0);
      expect(pr.title).toBe('Fix: Payment times out');
    });

    it('describes the plan as a fix approach', () => {
      const [pr] = nthCall<[PrParams]>(pullsCreate, 0);
      expect(pr.body).toContain('### Fix Approach');
    });

    it('returns branch and prUrl so AuditLogService can persist them', async () => {
      const result = await agent.invoke(stateFor());
      expect(result.branch).toBe('lazydev/branch');
      expect(result.prUrl).toBe('https://github.com/acme/widgets/pull/9');
    });
  });

  describe('a feature (MCP implement_new_feature)', () => {
    beforeEach(async () => {
      await agent.invoke(stateFor('feature'));
    });

    it('builds a feat branch', () => {
      expect(gitService.buildBranchName).toHaveBeenCalledWith(
        501,
        'Feature: Add a health endpoint',
        'feature',
      );
    });

    it('commits with the feat: conventional type, not fix:', () => {
      const [, message] = nthCall<[string, string, string]>(
        gitService.commitAndPush,
        0,
      );
      expect(message).toMatch(/^feat: implement issue #501/);
      expect(message).not.toMatch(/^fix:/);
    });

    it('does not double-prefix the PR title', () => {
      const [pr] = nthCall<[PrParams]>(pullsCreate, 0);
      expect(pr.title).toBe('Feature: Add a health endpoint');
      expect(pr.title).not.toMatch(/Fix:\s*Feature:/);
    });

    it('describes the plan as an implementation plan', () => {
      const [pr] = nthCall<[PrParams]>(pullsCreate, 0);
      expect(pr.body).toContain('### Implementation Plan');
    });
  });

  // A partially-applied patch (e.g. the LLM's MODIFY target didn't exist)
  // must not read as a fully-resolved PR.
  describe('unapplied changes', () => {
    it('appends a warning section to the PR body when some changes failed to apply', async () => {
      await agent.invoke(
        stateFor(undefined, {
          unappliedChanges:
            '- MODIFY src/router/index.js | routes: Target file "src/router/index.js" does not exist',
        }),
      );

      const [pr] = nthCall<[PrParams]>(pullsCreate, 0);
      expect(pr.body).toContain(
        '### ⚠️ Note: Some intended changes could not be applied',
      );
      expect(pr.body).toContain('src/router/index.js');
    });

    it('omits the warning section entirely when everything applied cleanly', async () => {
      await agent.invoke(stateFor(undefined, { unappliedChanges: '' }));

      const [pr] = nthCall<[PrParams]>(pullsCreate, 0);
      expect(pr.body).not.toContain('could not be applied');
    });

    it('omits the warning section when unappliedChanges was never set', async () => {
      await agent.invoke(stateFor());

      const [pr] = nthCall<[PrParams]>(pullsCreate, 0);
      expect(pr.body).not.toContain('could not be applied');
    });
  });

  // Memories physically live in the persistent repo-cache clone (repoPath),
  // not the worktree that actually gets committed — GitAgent is what bridges
  // the two, so the fix/feature PR also carries a versioned, human-readable
  // snapshot of them.
  describe('syncing memories into the committed worktree', () => {
    it('activates repoPath (not the worktree) before reading memories', async () => {
      await agent.invoke(stateFor());

      const [firstActivatedPath] = nthCall<[string]>(
        serenaMcp.activateProject,
        0,
      );
      expect(firstActivatedPath).toBe('/repo-cache/acme/widgets');
    });

    it('writes global_repo_structure.md into .lazydev/memory/ before the commit happens', async () => {
      serenaMcp.readMemory.mockResolvedValue({
        isError: false,
        content: [{ text: 'This is a Next.js app.' }],
      });

      await agent.invoke(stateFor());

      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.lazydev/memory/global_repo_structure.md'),
        expect.stringContaining('This is a Next.js app.'),
        'utf8',
      );
      // Written before createFixBranch/commitAndPush, so it rides along with
      // the same `git add .` as the actual fix.
      const writeOrder = mockedFs.writeFile.mock.invocationCallOrder[0];
      const commitOrder = gitService.commitAndPush.mock.invocationCallOrder[0];
      expect(writeOrder).toBeLessThan(commitOrder);
    });

    it('reactivates the worktree afterward', async () => {
      await agent.invoke(stateFor());

      const calls = serenaMcp.activateProject.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(calls[calls.length - 1]).toBe('/tmp/wt');
    });

    it('does not write a file when there is no memory yet', async () => {
      serenaMcp.readMemory.mockResolvedValue({ isError: true });

      await agent.invoke(stateFor());

      expect(mockedFs.writeFile).not.toHaveBeenCalled();
    });

    it('skips the whole sync (and still commits the fix) when repoPath is missing', async () => {
      const state = stateFor();
      delete (state.issuePayload as { repoPath?: string }).repoPath;

      await agent.invoke(state);

      expect(serenaMcp.activateProject).not.toHaveBeenCalled();
      expect(gitService.commitAndPush).toHaveBeenCalled();
    });

    it('does not read historical_issues_and_lessons when the feature flag is off', async () => {
      const original = process.env.ENABLE_SERENA_ISSUE_HISTORY;
      process.env.ENABLE_SERENA_ISSUE_HISTORY = 'false';

      await agent.invoke(stateFor());

      expect(serenaMcp.readMemory).not.toHaveBeenCalledWith(
        'historical_issues_and_lessons',
      );
      process.env.ENABLE_SERENA_ISSUE_HISTORY = original;
    });

    it('writes an uncapped historical_issues_and_lessons.md when the flag is on', async () => {
      const original = process.env.ENABLE_SERENA_ISSUE_HISTORY;
      process.env.ENABLE_SERENA_ISSUE_HISTORY = 'true';
      const entries = Array.from({ length: 8 }, (_, i) => ({
        issue: `Issue ${i}`,
        solution: `Solution ${i}`,
        lessons_learned: `Lesson ${i}`,
      }));
      serenaMcp.readMemory.mockImplementation((name: string) => {
        if (name === 'historical_issues_and_lessons') {
          return Promise.resolve({
            isError: false,
            content: [{ text: JSON.stringify({ entries }) }],
          });
        }
        return Promise.resolve({ isError: true });
      });

      await agent.invoke(stateFor());

      const call = mockedFs.writeFile.mock.calls.find((c) =>
        (c[0] as string).includes('historical_issues_and_lessons.md'),
      );
      expect(call).toBeDefined();
      const content = call![1] as string;
      // Uncapped — unlike PlannerAgent's prompt-context copy, both the
      // oldest and newest entries are present.
      expect(content).toContain('Issue 0');
      expect(content).toContain('Issue 7');
      process.env.ENABLE_SERENA_ISSUE_HISTORY = original;
    });

    it('still pushes the fix even if the memory sync throws entirely', async () => {
      serenaMcp.activateProject.mockRejectedValueOnce(new Error('serena down'));

      await agent.invoke(stateFor());

      expect(gitService.commitAndPush).toHaveBeenCalled();
      expect(pullsCreate).toHaveBeenCalled();
    });
  });
});

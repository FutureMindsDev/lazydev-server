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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorktreeManagerService } from './worktree-manager.service';
import { GitService } from './git.service';

/**
 * Investigates ~20 leftover worktree directories found on the live Serena
 * container spanning 2026-07-04 through 2026-08-20 (today), including one
 * from a job triggered during this session. That wide, ongoing spread rules
 * out "just early-development leftovers" — cleanup is still failing.
 *
 * `WorktreeManagerService.activeWorktrees` is a plain in-memory `Map`,
 * populated by `createJobWorktree` and consulted by `cleanupJobWorktree`. It
 * has no persistence — a process restart between those two calls (a
 * `docker compose up --build`, a crash, a `--watch` reload, an OOM kill)
 * wipes it, and `cleanupJobWorktree` then hits its "no active worktree found
 * — skipping cleanup" branch and does nothing. The directory is orphaned on
 * disk forever, silently (just a WARN log), because there is no persisted
 * record for a later reconciliation pass to find it by.
 *
 * These tests simulate that with real filesystem I/O — GitService's git
 * commands are stubbed to real mkdir/rm on the given paths (the bug is in
 * WorktreeManagerService's own bookkeeping, not in git plumbing), but nothing
 * about WorktreeManagerService itself is mocked.
 */
describe('WorktreeManagerService — orphaned worktree investigation', () => {
  let tmpRoot: string;
  let gitService: {
    createWorktree: jest.Mock;
    removeWorktree: jest.Mock;
    buildWorktreePath: jest.Mock;
  };

  const buildWorktreePath = (jobId: string) => path.join(tmpRoot, jobId);

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-worktree-test-'));

    gitService = {
      // Real directory creation/removal in place of the actual git commands —
      // sufficient to test WorktreeManagerService's own bookkeeping, which is
      // where the bug lives.
      createWorktree: jest.fn((_repoPath: string, worktreePath: string) => {
        fs.mkdirSync(worktreePath, { recursive: true });
      }),
      removeWorktree: jest.fn((_repoPath: string, worktreePath: string) => {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }),
      buildWorktreePath: jest.fn((jobId: string) => buildWorktreePath(jobId)),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('confirms the normal path works: same-instance cleanup removes the directory', async () => {
    const manager = withWorktreeManager();

    const worktreePath = await manager.createJobWorktree(
      'job-normal',
      '/fake/repo',
      'main',
    );
    expect(fs.existsSync(worktreePath)).toBe(true);

    await manager.cleanupJobWorktree('job-normal');

    expect(gitService.removeWorktree).toHaveBeenCalledWith(
      '/fake/repo',
      worktreePath,
    );
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  it('reproduces the orphan: a fresh instance (simulated restart) cannot clean up a worktree the old instance created', async () => {
    const beforeRestart = withWorktreeManager();

    const worktreePath = await beforeRestart.createJobWorktree(
      'job-restart',
      '/fake/repo',
      'main',
    );
    expect(fs.existsSync(worktreePath)).toBe(true);

    // Simulate a process restart: a brand-new instance has an empty
    // activeWorktrees map, exactly like the app does after any restart.
    const afterRestart = withWorktreeManager();

    await afterRestart.cleanupJobWorktree('job-restart');

    // The bug, proven: removeWorktree is never even attempted, and the
    // directory is left behind on disk — permanently, since nothing else in
    // the codebase ever revisits it.
    expect(gitService.removeWorktree).not.toHaveBeenCalled();
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('the orphan is invisible to the app too: listActiveWorktrees on the new instance shows nothing', async () => {
    const beforeRestart = withWorktreeManager();
    await beforeRestart.createJobWorktree(
      'job-invisible',
      '/fake/repo',
      'main',
    );

    const afterRestart = withWorktreeManager();

    // Not just cleanup — the *registry* itself has amnesia, so there's no
    // in-app way to even discover the orphan to clean it up later.
    expect(afterRestart.listActiveWorktrees()).toHaveLength(0);
    expect(afterRestart.getWorktreeHandle('job-invisible')).toBeUndefined();
  });

  function withWorktreeManager(): WorktreeManagerService {
    return new WorktreeManagerService(gitService as unknown as GitService);
  }

  describe('the fix: explicit knownPaths bypasses the registry entirely', () => {
    it('cleans up successfully on a fresh instance when the caller passes the paths itself', async () => {
      const beforeRestart = withWorktreeManager();
      const worktreePath = await beforeRestart.createJobWorktree(
        'job-explicit',
        '/fake/repo',
        'main',
      );

      const afterRestart = withWorktreeManager();
      await afterRestart.cleanupJobWorktree('job-explicit', {
        repoPath: '/fake/repo',
        worktreePath,
      });

      expect(gitService.removeWorktree).toHaveBeenCalledWith(
        '/fake/repo',
        worktreePath,
      );
      expect(fs.existsSync(worktreePath)).toBe(false);
    });

    it('still prefers the in-memory registry over explicit paths when both are available', async () => {
      const manager = withWorktreeManager();
      const worktreePath = await manager.createJobWorktree(
        'job-both',
        '/real/repo',
        'main',
      );

      await manager.cleanupJobWorktree('job-both', {
        repoPath: '/wrong/repo',
        worktreePath: '/wrong/path',
      });

      expect(gitService.removeWorktree).toHaveBeenCalledWith(
        '/real/repo',
        worktreePath,
      );
    });
  });
});

/**
 * The startup reconciliation sweep: catches whatever `cleanupJobWorktree`
 * missed because the process restarted before it could run. Uses real
 * filesystem I/O (mtimes, a real `.git` worktree-pointer file) rather than
 * mocks, since the whole point is to prove the sweep behaves correctly
 * against what's actually on disk.
 */
describe('WorktreeManagerService — startup reconciliation sweep', () => {
  let tmpBase: string;
  let originalBasePath: string | undefined;
  let originalMaxAge: string | undefined;
  let gitService: { removeWorktree: jest.Mock; createWorktree: jest.Mock };

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-sweep-test-'));
    originalBasePath = process.env.WORKTREE_BASE_PATH;
    originalMaxAge = process.env.WORKTREE_ORPHAN_MAX_AGE_HOURS;
    process.env.WORKTREE_BASE_PATH = tmpBase;
    process.env.WORKTREE_ORPHAN_MAX_AGE_HOURS = '6';

    gitService = {
      removeWorktree: jest.fn((_repoPath: string, worktreePath: string) => {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }),
      createWorktree: jest.fn(),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    process.env.WORKTREE_BASE_PATH = originalBasePath;
    process.env.WORKTREE_ORPHAN_MAX_AGE_HOURS = originalMaxAge;
  });

  const makeOldDir = (name: string, hoursOld: number, withGitFile?: string) => {
    const dir = path.join(tmpBase, name);
    fs.mkdirSync(dir, { recursive: true });
    if (withGitFile) {
      fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${withGitFile}\n`);
    }
    const oldTime = new Date(Date.now() - hoursOld * 60 * 60 * 1000);
    fs.utimesSync(dir, oldTime, oldTime);
    return dir;
  };

  it('removes a directory old enough with no in-memory record', async () => {
    const orphan = makeOldDir('orphan-job', 48);

    const manager = new WorktreeManagerService(
      gitService as unknown as GitService,
    );
    await manager.onModuleInit();

    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('leaves a recent directory alone — it may belong to a job still in flight', async () => {
    const recent = makeOldDir('recent-job', 0.1); // 6 minutes old

    const manager = new WorktreeManagerService(
      gitService as unknown as GitService,
    );
    await manager.onModuleInit();

    expect(fs.existsSync(recent)).toBe(true);
    expect(gitService.removeWorktree).not.toHaveBeenCalled();
  });

  it('leaves a directory alone if this instance actually has a live record for it', async () => {
    const manager = new WorktreeManagerService(
      gitService as unknown as GitService,
    );
    // Simulate an in-flight job registered on this same instance before sweep
    // would ever run in practice (createJobWorktree registers it).
    (
      manager as unknown as { activeWorktrees: Map<string, unknown> }
    ).activeWorktrees.set('live-job', {
      jobId: 'live-job',
      repoPath: '/x',
      worktreePath: path.join(tmpBase, 'live-job'),
      branchName: 'main',
      createdAt: new Date(),
    });
    makeOldDir('live-job', 48);

    await manager.onModuleInit();

    expect(gitService.removeWorktree).not.toHaveBeenCalled();
  });

  it('re-derives the original repo from the worktree .git file and calls git worktree remove properly', async () => {
    const fakeRepoWorktreesDir = path.join(
      tmpBase,
      'fake-repo',
      '.git',
      'worktrees',
      'orphan-with-git',
    );
    fs.mkdirSync(fakeRepoWorktreesDir, { recursive: true });
    const orphan = makeOldDir('orphan-with-git', 48, fakeRepoWorktreesDir);

    const manager = new WorktreeManagerService(
      gitService as unknown as GitService,
    );
    await manager.onModuleInit();

    expect(gitService.removeWorktree).toHaveBeenCalledWith(
      path.join(tmpBase, 'fake-repo'),
      orphan,
    );
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('falls back to a raw filesystem delete when there is no resolvable .git file', async () => {
    const orphan = makeOldDir('orphan-no-git', 48); // no .git file at all

    const manager = new WorktreeManagerService(
      gitService as unknown as GitService,
    );
    await manager.onModuleInit();

    expect(gitService.removeWorktree).not.toHaveBeenCalled();
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('falls back to a raw delete when git worktree remove itself fails', async () => {
    const fakeRepoWorktreesDir = path.join(
      tmpBase,
      'fake-repo2',
      '.git',
      'worktrees',
      'orphan-remove-fails',
    );
    fs.mkdirSync(fakeRepoWorktreesDir, { recursive: true });
    const orphan = makeOldDir('orphan-remove-fails', 48, fakeRepoWorktreesDir);
    gitService.removeWorktree.mockRejectedValueOnce(
      new Error('not a valid repo anymore'),
    );

    const manager = new WorktreeManagerService(
      gitService as unknown as GitService,
    );
    await manager.onModuleInit();

    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('does nothing when the worktree base path does not exist', async () => {
    process.env.WORKTREE_BASE_PATH = path.join(tmpBase, 'does-not-exist');

    const manager = new WorktreeManagerService(
      gitService as unknown as GitService,
    );
    await expect(manager.onModuleInit()).resolves.not.toThrow();
  });
});

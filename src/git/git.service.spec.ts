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

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from './git.service';

describe('GitService.buildBranchName', () => {
  let service: GitService;
  const originalStrategy = process.env.GIT_PUSH_STRATEGY;

  beforeEach(() => {
    service = new GitService();
    delete process.env.GIT_PUSH_STRATEGY;
  });

  afterAll(() => {
    if (originalStrategy === undefined) delete process.env.GIT_PUSH_STRATEGY;
    else process.env.GIT_PUSH_STRATEGY = originalStrategy;
  });

  it('uses the fix- prefix by default', () => {
    expect(service.buildBranchName(142, 'Payment timeout')).toBe(
      'lazydev/fix-142-payment-timeout',
    );
  });

  it('uses the feat- prefix for features', () => {
    expect(
      service.buildBranchName(501, 'Add a health endpoint', 'feature'),
    ).toBe('lazydev/feat-501-add-a-health-endpoint');
  });

  // Feature issues are titled "Feature: X" by implement_new_feature, which
  // would otherwise produce lazydev/feat-501-feature-x.
  it('strips a leading kind prefix from the title before slugging', () => {
    expect(
      service.buildBranchName(501, 'Feature: Add a health endpoint', 'feature'),
    ).toBe('lazydev/feat-501-add-a-health-endpoint');

    expect(service.buildBranchName(7, 'Fix: Broken login')).toBe(
      'lazydev/fix-7-broken-login',
    );
  });

  it('strips punctuation and collapses whitespace', () => {
    expect(service.buildBranchName(9, 'Crash in /api/users (500!)')).toBe(
      'lazydev/fix-9-crash-in-apiusers-500',
    );
  });

  it('truncates long titles without leaving a trailing dash', () => {
    const branch = service.buildBranchName(
      1,
      'a'.repeat(20) + ' ' + 'b'.repeat(40),
      'feature',
    );

    expect(branch.startsWith('lazydev/feat-1-')).toBe(true);
    expect(branch).not.toMatch(/-$/);
    expect(branch.length).toBeLessThanOrEqual('lazydev/feat-1-'.length + 40);
  });

  it('appends a timestamp under the unique_branch push strategy', () => {
    process.env.GIT_PUSH_STRATEGY = 'unique_branch';

    expect(service.buildBranchName(142, 'Payment timeout')).toMatch(
      /^lazydev\/fix-142-payment-timeout-\d+$/,
    );
  });
});

describe('GitService.commitAndPush', () => {
  const ENV_KEYS = [
    'GIT_USER_NAME',
    'GIT_USER_EMAIL',
    'GIT_PUSH_STRATEGY',
  ] as const;
  let savedEnv: Record<string, string | undefined>;
  let tmpRoot: string;
  let worktree: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.GIT_USER_NAME = 'LazyDev Test';
    process.env.GIT_USER_EMAIL = 'lazydev@example.com';
    process.env.GIT_PUSH_STRATEGY = 'force';

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lazydev-git-test-'));
    const remote = path.join(tmpRoot, 'remote.git');
    worktree = path.join(tmpRoot, 'worktree');
    execFileSync('git', ['init', '--bare', remote]);
    execFileSync('git', ['init', '-b', 'main', worktree]);
    git(worktree, 'config', 'user.email', 'lazydev@example.com');
    git(worktree, 'config', 'user.name', 'LazyDev Test');
    fs.writeFileSync(path.join(worktree, 'app.ts'), 'export const x = 1;\n');
    git(worktree, 'add', 'app.ts');
    git(worktree, 'commit', '-m', 'initial');
    git(worktree, 'remote', 'add', 'origin', remote);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('stages source changes but never Serena local metadata', async () => {
    const serenaDir = path.join(worktree, '.serena');
    fs.mkdirSync(serenaDir, { recursive: true });
    const projectYml = path.join(serenaDir, 'project.yml');
    fs.writeFileSync(projectYml, 'project: local\n', { mode: 0o600 });
    // Simulate Serena's root-owned mode-600 file: git must not try to read
    // this at all (it would fail with EACCES when the app runs as node).
    fs.chmodSync(projectYml, 0o000);
    fs.writeFileSync(path.join(worktree, 'app.ts'), 'export const x = 2;\n');

    const service = new GitService();
    await service.createFixBranch(worktree, 'lazydev/fix-1-test');
    await service.commitAndPush(worktree, 'fix: test', 'lazydev/fix-1-test');

    const tracked = git(worktree, 'ls-tree', '-r', '--name-only', 'HEAD');
    expect(tracked).toContain('app.ts');
    expect(tracked).not.toContain('.serena/project.yml');
    expect(git(worktree, 'show', 'HEAD:app.ts')).toContain('x = 2');
  });

  it('bypasses repo-local commit hooks (no dependency on pnpm/husky tooling)', async () => {
    const hooksDir = path.join(worktree, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, 'pre-commit'),
      '#!/bin/sh\necho "pnpm: not found" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(worktree, 'app.ts'), 'export const x = 3;\n');

    const service = new GitService();
    await service.createFixBranch(worktree, 'lazydev/fix-1-test');

    await expect(
      service.commitAndPush(worktree, 'fix: test', 'lazydev/fix-1-test'),
    ).resolves.toBeUndefined();
    expect(git(worktree, 'show', 'HEAD:app.ts')).toContain('x = 3');
  });
});

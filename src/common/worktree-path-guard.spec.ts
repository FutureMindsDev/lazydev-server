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

import * as path from 'path';
import { assertSafeWorktreePath } from './worktree-path-guard';

describe('assertSafeWorktreePath', () => {
  const worktree = '/app/worktrees/mcp-123';

  it('resolves a normal relative path inside the worktree', () => {
    expect(
      assertSafeWorktreePath(worktree, 'src/components/GuestRoute.tsx'),
    ).toBe(path.resolve(worktree, 'src/components/GuestRoute.tsx'));
  });

  it('strips a leading "./"', () => {
    expect(assertSafeWorktreePath(worktree, './src/a.ts')).toBe(
      path.resolve(worktree, 'src/a.ts'),
    );
  });

  it.each([
    ['.github/workflows/ci.yml', 'CI config'],
    ['.git/config', 'git internals'],
    ['.serena/project.yml', 'Serena config'],
    ['.env', 'secrets'],
    ['.env.production', 'secrets'],
    [
      '.lazydev/memory/global_repo_structure.md',
      "LazyDev's own committed memory snapshot",
    ],
  ])('rejects the restricted path %s (%s)', (relativePath) => {
    expect(() => assertSafeWorktreePath(worktree, relativePath)).toThrow(
      /restricted path/,
    );
  });

  it('rejects an absolute path', () => {
    expect(() => assertSafeWorktreePath(worktree, '/etc/passwd')).toThrow(
      /absolute path/,
    );
  });

  it('rejects path traversal that escapes the worktree', () => {
    expect(() => assertSafeWorktreePath(worktree, '../../etc/passwd')).toThrow(
      /outside the worktree/,
    );
  });

  it('does not false-positive on ".." appearing inside a legitimate filename', () => {
    expect(() =>
      assertSafeWorktreePath(worktree, 'src/utils/excellent..md'),
    ).not.toThrow();
  });

  it('allows a deeply nested new file (a directory that does not exist yet)', () => {
    expect(assertSafeWorktreePath(worktree, 'src/new/deep/path/File.tsx')).toBe(
      path.resolve(worktree, 'src/new/deep/path/File.tsx'),
    );
  });
});

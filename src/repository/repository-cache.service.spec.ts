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
import * as fs from 'fs';
import { RepositoryCacheService } from './repository-cache.service';

jest.mock('fs');
const mockedFs = fs as jest.Mocked<typeof fs>;

/**
 * `cacheBaseDir` ends up as `repoPath` in AgentState, which is passed
 * straight to Serena's `activate_project` — and Serena runs in a completely
 * separate container. A relative REPO_CACHE_DIR (e.g. the `./repo-cache`
 * default shipped in .env.example) would resolve against Serena's own
 * process cwd instead of this container's, and activate_project would fail
 * with "Project ... not found" even though the directory exists right here.
 */
describe('RepositoryCacheService — cacheBaseDir is always absolute', () => {
  const repoCacheRepo = {} as never;
  const githubService = {} as never;

  const configServiceReturning = (value?: string) => ({
    get: jest.fn().mockReturnValue(value ?? 'repo-cache'),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(true); // skip the mkdir-on-startup branch
  });

  it('resolves a relative REPO_CACHE_DIR (e.g. "./repo-cache") to an absolute path', () => {
    const configService = configServiceReturning('./repo-cache');
    const service = new RepositoryCacheService(
      repoCacheRepo,
      configService as never,
      githubService,
    );

    const cacheBaseDir = (service as unknown as { cacheBaseDir: string })
      .cacheBaseDir;
    expect(path.isAbsolute(cacheBaseDir)).toBe(true);
    expect(cacheBaseDir).toBe(path.resolve(process.cwd(), 'repo-cache'));
  });

  it('resolves a relative REPO_CACHE_DIR with no leading "./" the same way', () => {
    const configService = configServiceReturning('data/repo-cache');
    const service = new RepositoryCacheService(
      repoCacheRepo,
      configService as never,
      githubService,
    );

    const cacheBaseDir = (service as unknown as { cacheBaseDir: string })
      .cacheBaseDir;
    expect(cacheBaseDir).toBe(path.resolve(process.cwd(), 'data/repo-cache'));
  });

  it('leaves an already-absolute REPO_CACHE_DIR unchanged', () => {
    const configService = configServiceReturning('/var/lazydev/repo-cache');
    const service = new RepositoryCacheService(
      repoCacheRepo,
      configService as never,
      githubService,
    );

    const cacheBaseDir = (service as unknown as { cacheBaseDir: string })
      .cacheBaseDir;
    expect(cacheBaseDir).toBe('/var/lazydev/repo-cache');
  });

  it('defaults to an absolute path under cwd when REPO_CACHE_DIR is unset', () => {
    const configService = { get: jest.fn((_key: string, def: string) => def) };
    const service = new RepositoryCacheService(
      repoCacheRepo,
      configService as never,
      githubService,
    );

    const cacheBaseDir = (service as unknown as { cacheBaseDir: string })
      .cacheBaseDir;
    expect(cacheBaseDir).toBe(path.resolve(process.cwd(), 'repo-cache'));
  });
});

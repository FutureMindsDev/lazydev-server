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

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';
import simpleGit, { SimpleGit } from 'simple-git';
import { RepositoryCache } from './entities/repository-cache.entity';
import { GithubService } from '../github/github.service';

@Injectable()
export class RepositoryCacheService {
  private readonly logger = new Logger(RepositoryCacheService.name);
  private readonly cacheBaseDir: string;

  constructor(
    @InjectRepository(RepositoryCache)
    private readonly repoCacheRepo: Repository<RepositoryCache>,
    private readonly configService: ConfigService,
    private readonly githubService: GithubService,
  ) {
    // Always resolved to an absolute path: this ends up as `repoPath` in
    // AgentState, which OnboardingAgent/PlannerAgent/ValidationAgent/GitAgent
    // pass straight to Serena's `activate_project`. Serena runs in a
    // completely separate container, so a relative value (e.g. the
    // `REPO_CACHE_DIR=./repo-cache` default in .env.example) would resolve
    // against Serena's own process cwd instead of this container's —
    // `path.resolve` here converges both relative and already-absolute
    // config values onto this container's filesystem, which repo-cache is
    // actually bind-mounted from.
    this.cacheBaseDir = path.resolve(
      this.configService.get<string>('REPO_CACHE_DIR', 'repo-cache'),
    );

    // Ensure the base cache directory exists on startup
    if (!fs.existsSync(this.cacheBaseDir)) {
      fs.mkdirSync(this.cacheBaseDir, { recursive: true });
      this.logger.log(`Created repo cache directory: ${this.cacheBaseDir}`);
    }
  }

  /**
   * Ensures a repository is present locally.
   * - If cached: runs git fetch to pull latest refs
   * - If not cached: clones the repo using an authenticated token URL
   *
   * Returns the local path of the bare-style cache directory.
   */
  async ensureRepo(
    owner: string,
    repo: string,
    installationId: number,
  ): Promise<string> {
    const fullName = `${owner}/${repo}`;
    const localPath = path.join(this.cacheBaseDir, owner, repo);

    // Check if we already have a DB record for this repo
    let cacheEntry = await this.repoCacheRepo.findOne({
      where: { owner, repo },
    });

    if (cacheEntry && fs.existsSync(localPath)) {
      // Cache hit — but first verify the repo isn't corrupted. A Docker
      // volume write interrupted by a container kill / power loss / disk-full
      // event can leave .git/config filled with null bytes, which makes
      // every subsequent git command fail with "bad config line 1". Rather
      // than letting the error propagate and fail the job, detect it here
      // and fall through to the re-clone path below.
      if (!(await this.isGitRepoHealthy(localPath))) {
        this.logger.warn(
          `Cache hit for ${fullName} — but repo is corrupted (likely an interrupted write). Re-cloning.`,
        );
        // Delete the corrupted directory so the clone path below can proceed.
        fs.rmSync(localPath, { recursive: true, force: true });
        // Fall through to the clone branch by clearing cacheEntry's
        // localPath — we keep the DB record so it gets updated in place
        // rather than duplicated.
      } else {
        // Cache hit: just fetch latest refs
        this.logger.log(`Cache hit for ${fullName} — running git fetch`);
        const git: SimpleGit = simpleGit(localPath);

        // Update remote URL with a fresh token since GitHub App tokens expire after 1 hour
        const freshCloneUrl = await this.getAuthenticatedCloneUrl(
          owner,
          repo,
          installationId,
        );
        await git.remote(['set-url', 'origin', freshCloneUrl]);

        await git.fetch(['--all', '--prune']);
        cacheEntry.lastFetchedAt = new Date();
        await this.repoCacheRepo.save(cacheEntry);
        this.logger.log(`Fetched latest refs for ${fullName}`);
        return localPath;
      }
    } else if (fs.existsSync(localPath) && (await this.isGitRepoHealthy(localPath))) {
      // Directory exists on disk but DB record is missing (e.g. after a DB wipe or container restart).
      // Re-hydrate the cache entry from the existing repo instead of re-cloning.
      // The health check guards against the same corruption as the cache-hit
      // path above — if the repo is broken, fall through to re-clone.
      this.logger.warn(
        `Cache miss (no DB record) for ${fullName} — dir exists on disk, re-hydrating`,
      );
      const existingGit: SimpleGit = simpleGit(localPath);

      // Update remote URL with a fresh token
      const freshCloneUrl = await this.getAuthenticatedCloneUrl(
        owner,
        repo,
        installationId,
      );
      await existingGit.remote(['set-url', 'origin', freshCloneUrl]);

      await existingGit.fetch(['--all', '--prune']);

      const remoteInfo = await existingGit.remote(['show', 'origin']);
      const defaultBranchMatch = remoteInfo
        ?.toString()
        .match(/HEAD branch: (.+)/);
      const defaultBranch = defaultBranchMatch
        ? defaultBranchMatch[1].trim()
        : this.configService.get<string>('LAZYDEV_DEFAULT_BRANCH', 'main');

      cacheEntry = this.repoCacheRepo.create({
        owner,
        repo,
        fullName,
        localPath,
        defaultBranch,
        lastFetchedAt: new Date(),
      });
      await this.repoCacheRepo.save(cacheEntry);
      this.logger.log(`Re-hydrated cache entry for ${fullName}`);
    } else {
      // Cache miss: clone the repository. This branch also handles the
      // case where the directory exists on disk but is corrupted (failed
      // the health check above) — remove it before cloning so git doesn't
      // refuse to clone into a non-empty directory.
      this.logger.log(`Cache miss for ${fullName} — cloning repository`);

      // Get authenticated clone URL using installation token
      const cloneUrl = await this.getAuthenticatedCloneUrl(
        owner,
        repo,
        installationId,
      );

      // Remove any existing (possibly corrupted) directory before cloning.
      // fs.mkdirSync(recursive) is a no-op if the dir exists, and git.clone
      // refuses to clone into a non-empty directory — so we must clean up first.
      if (fs.existsSync(localPath)) {
        fs.rmSync(localPath, { recursive: true, force: true });
      }
      fs.mkdirSync(localPath, { recursive: true });

      const git: SimpleGit = simpleGit();
      await git.clone(cloneUrl, localPath, ['--no-single-branch']);
      this.logger.log(`Cloned ${fullName} to ${localPath}`);

      // Get the default branch from the cloned repo
      const clonedGit: SimpleGit = simpleGit(localPath);
      const remoteInfo = await clonedGit.remote(['show', 'origin']);
      const defaultBranchMatch = remoteInfo
        ?.toString()
        .match(/HEAD branch: (.+)/);
      const defaultBranch = defaultBranchMatch
        ? defaultBranchMatch[1].trim()
        : this.configService.get<string>('LAZYDEV_DEFAULT_BRANCH', 'main');

      // Persist the cache entry
      if (cacheEntry) {
        // DB entry existed but dir was missing — update it
        cacheEntry.localPath = localPath;
        cacheEntry.defaultBranch = defaultBranch;
        cacheEntry.lastFetchedAt = new Date();
        await this.repoCacheRepo.save(cacheEntry);
      } else {
        cacheEntry = this.repoCacheRepo.create({
          owner,
          repo,
          fullName,
          localPath,
          defaultBranch,
          lastFetchedAt: new Date(),
        });
        await this.repoCacheRepo.save(cacheEntry);
      }

      this.logger.log(
        `Repository cache entry created for ${fullName} (default branch: ${defaultBranch})`,
      );
    }

    return localPath;
  }

  /**
   * Returns the DB record for a cached repository, or null if not found.
   */
  async getCacheEntry(
    owner: string,
    repo: string,
  ): Promise<RepositoryCache | null> {
    return this.repoCacheRepo.findOne({ where: { owner, repo } });
  }

  /**
   * Quick health check on a cached repo. Runs `git rev-parse --git-dir`
   * which reads .git/config internally — if the config is corrupted (e.g.
   * null bytes from an interrupted Docker volume write), this fails fast
   * with "bad config line 1" instead of letting the error surface later
   * in a fetch or worktree operation.
   *
   * Returns true if the repo is usable, false if it needs re-cloning.
   */
  private async isGitRepoHealthy(localPath: string): Promise<boolean> {
    try {
      const git: SimpleGit = simpleGit(localPath);
      await git.raw(['rev-parse', '--git-dir']);
      return true;
    } catch (e) {
      this.logger.warn(
        `Git health check failed for ${localPath}: ${(e as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Builds an authenticated HTTPS clone URL using a GitHub App installation token.
   * Format: https://x-access-token:<token>@github.com/owner/repo.git
   */
  private async getAuthenticatedCloneUrl(
    owner: string,
    repo: string,
    installationId: number,
  ): Promise<string> {
    const octokit =
      await this.githubService.getInstallationOctokit(installationId);

    // Create a short-lived installation access token
    const { data } = await octokit.rest.apps.createInstallationAccessToken({
      installation_id: installationId,
    });

    return `https://x-access-token:${data.token}@github.com/${owner}/${repo}.git`;
  }
}

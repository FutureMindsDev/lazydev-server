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
import simpleGit, { SimpleGit } from 'simple-git';
import * as path from 'path';
import * as fs from 'fs';
import type { WorkKind } from '../common/work-kind';

@Injectable()
export class GitService {
  private readonly logger = new Logger(GitService.name);

  /**
   * Checks out an existing branch in the cached repository.
   */
  async checkoutBranch(repoPath: string, branchName: string): Promise<void> {
    const git: SimpleGit = simpleGit(repoPath);
    this.logger.log(`Checking out branch "${branchName}" in ${repoPath}`);
    // Ensure we have the remote tracking branch
    await git.fetch(['origin', branchName]);
    await git.checkout(['-B', branchName, `origin/${branchName}`]);
    this.logger.log(`Checked out branch "${branchName}"`);
  }

  /**
   * Creates an isolated git worktree for a job.
   * Each job gets its own directory so concurrent jobs cannot interfere.
   *
   * @returns The path to the newly created worktree directory
   */
  async createWorktree(
    repoPath: string,
    worktreePath: string,
    branchName: string,
  ): Promise<void> {
    const git: SimpleGit = simpleGit(repoPath);
    this.logger.log(
      `Creating worktree at ${worktreePath} based on "origin/${branchName}"`,
    );

    // We create a new local branch specific to this worktree to avoid conflicts
    // with other worktrees or the main repository checkout.
    const tempBranch = `job-worktree-${path.basename(worktreePath)}`;

    // Ensure we fetch the latest for the target branch
    await git.fetch(['origin', branchName]);

    // Cleanup any stale worktree directory from a previous failed attempt
    if (fs.existsSync(worktreePath)) {
      this.logger.warn(
        `Stale worktree directory found at ${worktreePath}, removing it`,
      );
      try {
        await git.raw(['worktree', 'remove', '--force', worktreePath]);
      } catch {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        await git.raw(['worktree', 'prune']);
      }
    }

    // Cleanup any stale local branch from a previous failed attempt
    const branches = await git.branchLocal();
    if (branches.all.includes(tempBranch)) {
      this.logger.warn(
        `Stale branch "${tempBranch}" found, deleting it before retry`,
      );
      await git.branch(['-D', tempBranch]);
    }

    await git.raw([
      'worktree',
      'add',
      '-b',
      tempBranch,
      worktreePath,
      `origin/${branchName}`,
    ]);

    this.logger.log(`Worktree created at ${worktreePath}`);
  }

  /**
   * Creates a new fix branch inside a worktree.
   * Branch naming: lazydev/fix-<issueNumber>-<slug>
   */
  async createFixBranch(
    worktreePath: string,
    fixBranchName: string,
  ): Promise<void> {
    const git: SimpleGit = simpleGit(worktreePath);
    this.logger.log(
      `Creating fix branch "${fixBranchName}" in ${worktreePath}`,
    );
    // Only use -B (reset) if the branch already exists locally to avoid resetting HEAD
    // and wiping all changes that the patch agent wrote before this step.
    const branches = await git.branchLocal();
    if (branches.all.includes(fixBranchName)) {
      this.logger.warn(`Branch "${fixBranchName}" already exists locally, resetting it with -B.`);
      await git.checkout(['-B', fixBranchName]);
    } else {
      await git.checkoutLocalBranch(fixBranchName);
    }
    this.logger.log(`Fix branch "${fixBranchName}" created`);
  }

  /**
   * Stages all changes, commits, and pushes to the remote fix branch.
   * This is built in Sprint 2 and will be called in Sprint 6 (Patch Generation).
   */
  async commitAndPush(
    worktreePath: string,
    commitMessage: string,
    fixBranchName: string,
    authUrl?: string,
  ): Promise<void> {
    const git: SimpleGit = simpleGit(worktreePath);

    // The repo-cache remote is deliberately scrubbed to a credential-free
    // HTTPS URL after fetch, so a worktree push has no credentials. When the
    // caller supplies a fresh installation-token URL, use it for exactly this
    // push and scrub it afterwards (the worktree shares the parent repo config).
    const authUrlPattern =
      /^https:\/\/x-access-token:[^@]+@github\.com\/[^/]+\/[^/]+\.git$/;
    if (authUrl && !authUrlPattern.test(authUrl)) {
      throw new Error('Invalid authenticated Git remote URL.');
    }
    const plainUrl = authUrl?.replace(/^https:\/\/[^@]+@/, 'https://');

    const userName = process.env.GIT_USER_NAME;
    const userEmail = process.env.GIT_USER_EMAIL;
    
    if (!userName || !userEmail) {
      throw new Error(
        'Git author identity is not configured. Please set GIT_USER_NAME and GIT_USER_EMAIL in your .env file.',
      );
    }
    
    await git.addConfig('user.name', userName);
    await git.addConfig('user.email', userEmail);

    const pushStrategy = process.env.GIT_PUSH_STRATEGY || 'force';
    
    this.logger.log(`Staging all changes in ${worktreePath}`);
    // Serena writes its local project metadata here. It is machine-local
    // (project.yml contains absolute paths), may be owned by the root-running
    // Serena container (mode 600), and must never be committed. Excluding it
    // from the pathspec also stops git from trying to read an unreadable file.
    await git.raw(['add', '--all', '--', '.', ':(exclude).serena']);
    
    // Explicitly prevent massive accidental lockfile commits by unstaging them
    const ignoredPaths = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
    for (const p of ignoredPaths) {
      try {
        await git.raw(['reset', 'HEAD', p]);
        await git.raw(['checkout', '--', p]);
      } catch (e) {
        // Ignored if file/folder doesn't exist in the index
      }
    }
    
    // Log the current branch and staged diff for diagnostics
    const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
    this.logger.log(`Committing on branch: ${currentBranch.trim()}`);
    
    // Use git diff --cached --stat as the definitive check for staged content
    const cachedDiff = await git.diff(['--cached', '--stat']);
    this.logger.log(`Staged diff stat:\n${cachedDiff || '(empty)'}`);
    
    if (!cachedDiff.trim()) {
      throw new Error(
        'Nothing to commit — the AI patch made no effective file changes (or only lockfile changes were staged). ' +
        'Check that PatchGeneratorAgent is writing to the correct worktreePath.'
      );
    }

    // Bypass repo-local hooks (husky/pre-commit, commitlint, etc.). This is
    // an automated bot commit: hooks assume the developer's toolchain (e.g.
    // pnpm) is installed and can fail the push for reasons unrelated to the
    // patch. CI and human review still run the repo's checks.
    await git.raw(['commit', '--no-verify', '-m', commitMessage]);
    
    // Log the resulting commit to confirm it was created
    const lastCommit = await git.log(['-1', '--oneline']);
    this.logger.log(`Commit created: ${lastCommit.latest?.hash} ${lastCommit.latest?.message}`);
    
    try {
      if (authUrl) {
        await git.remote(['set-url', 'origin', authUrl]);
      }
      if (pushStrategy === 'force') {
        this.logger.warn(`[GIT PUSH STRATEGY: force] Force pushing branch "${fixBranchName}" to overwrite any existing history.`);
        await git.push('origin', fixBranchName, ['--set-upstream', '--force']);
      } else {
        this.logger.log(`[GIT PUSH STRATEGY: ${pushStrategy}] Pushing fix branch "${fixBranchName}" to origin`);
        await git.push('origin', fixBranchName, ['--set-upstream']);
      }
      this.logger.log(`Fix branch "${fixBranchName}" pushed to origin`);
    } finally {
      if (plainUrl) {
        try {
          await git.remote(['set-url', 'origin', plainUrl]);
        } catch (e: any) {
          this.logger.warn(
            `Could not scrub install token from remote URL: ${e.message}`,
          );
        }
      }
    }
  }

  /**
   * Removes a worktree from the repository and deletes its directory.
   */
  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    if (!fs.existsSync(worktreePath)) {
      this.logger.warn(
        `Worktree path does not exist, skipping: ${worktreePath}`,
      );
      return;
    }

    const git: SimpleGit = simpleGit(repoPath);
    this.logger.log(`Removing worktree at ${worktreePath}`);
    try {
      await git.raw(['worktree', 'remove', '--force', worktreePath]);
    } catch {
      // If the worktree remove fails, prune and manually delete
      await git.raw(['worktree', 'prune']);
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    }
    this.logger.log(`Worktree removed: ${worktreePath}`);
  }

  /**
   * Builds a safe branch name from an issue number and title slug.
   *
   * The prefix reflects the kind of work so feature branches don't claim to be
   * fixes:
   *   fix     → lazydev/fix-142-payment-timeout
   *   feature → lazydev/feat-501-health-endpoint
   *
   * A leading "Feature:"/"Fix:" in the title is stripped first, otherwise a
   * feature request titled "Feature: X" would yield `lazydev/feat-501-feature-x`.
   */
  buildBranchName(
    issueNumber: number,
    issueTitle: string,
    kind: WorkKind = 'fix',
  ): string {
    const slug = issueTitle
      .replace(/^\s*(feature|feat|fix|bug|bugfix)\s*:\s*/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .substring(0, 40)
      .replace(/-+$/, '');

    const prefix = kind === 'feature' ? 'feat' : 'fix';
    const baseBranch = `lazydev/${prefix}-${issueNumber}-${slug}`;

    if (process.env.GIT_PUSH_STRATEGY === 'unique_branch') {
      return `${baseBranch}-${Date.now()}`;
    }

    return baseBranch;
  }

  /**
   * Builds a unique temporary worktree path for a job.
   *
   * Uses /app/worktrees (a named Docker volume) instead of /tmp so that the
   * directory is accessible to sibling sandbox containers via --volumes-from.
   * /tmp is ephemeral container-layer storage and is NOT shared by --volumes-from
   * on any platform. WORKTREE_BASE_PATH can be overridden via env var.
   */
  buildWorktreePath(jobId: string): string {
    const base = process.env.WORKTREE_BASE_PATH ?? '/app/worktrees';
    return path.join(base, jobId);
  }
}

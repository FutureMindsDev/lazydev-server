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
import { GithubService } from '../github/github.service';

export type BranchResolutionSource =
  | 'issue-body'
  | 'issue-label'
  | 'repo-default'
  | 'env-fallback';

export interface ResolvedBranch {
  branchName: string;
  source: BranchResolutionSource;
}

@Injectable()
export class BranchResolverService {
  private readonly logger = new Logger(BranchResolverService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly githubService: GithubService,
  ) {}

  /**
   * Resolves the target branch for a given issue using a priority chain:
   * 1. `branch: <name>` hint in the issue body
   * 2. `branch:<name>` label on the issue
   * 3. Repository's default branch (from GitHub API)
   * 4. LAZYDEV_DEFAULT_BRANCH env var (fallback)
   */
  async resolve(
    owner: string,
    repo: string,
    installationId: number,
    issueBody: string | null,
    issueLabels: string[],
  ): Promise<ResolvedBranch> {
    // 1. Check issue body for `branch: <name>`
    if (issueBody) {
      const bodyMatch = issueBody.match(/^branch:\s*(\S+)/im);
      if (bodyMatch) {
        const branchName = bodyMatch[1].trim();
        this.logger.log(`Branch resolved from issue body: ${branchName}`);
        return { branchName, source: 'issue-body' };
      }
    }

    // 2. Check issue labels for `branch:<name>`
    for (const label of issueLabels) {
      const labelMatch = label.match(/^branch:(.+)$/i);
      if (labelMatch) {
        const branchName = labelMatch[1].trim();
        this.logger.log(
          `Branch resolved from issue label "${label}": ${branchName}`,
        );
        return { branchName, source: 'issue-label' };
      }
    }

    // 3. Get repository default branch from GitHub API
    try {
      const octokit =
        await this.githubService.getInstallationOctokit(installationId);
      const { data: repoData } = await octokit.rest.repos.get({
        owner,
        repo,
      });
      const branchName = repoData.default_branch;
      this.logger.log(
        `Branch resolved from repo default branch: ${branchName}`,
      );
      return { branchName, source: 'repo-default' };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        `Could not fetch repo default branch for ${owner}/${repo}: ${err.message}`,
      );
    }

    // 4. Fall back to environment variable
    const branchName = this.configService.get<string>(
      'LAZYDEV_DEFAULT_BRANCH',
      'main',
    );
    this.logger.warn(`Branch resolved from env fallback: ${branchName}`);
    return { branchName, source: 'env-fallback' };
  }
}

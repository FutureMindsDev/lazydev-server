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

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { App } from 'octokit';

@Injectable()
export class GithubService implements OnModuleInit {
  private readonly logger = new Logger(GithubService.name);
  public app: App;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.initialize();
  }

  private async initialize() {
    const appId = this.configService.get<string>('GITHUB_APP_ID');
    // Env value only: GITHUB_PRIVATE_KEY holds the full key text (real
    // newlines, quoted in .env). No file-path mode — never bake *.pem files
    // into the Docker image.
    const privateKey = this.configService.get<string>('GITHUB_PRIVATE_KEY');

    if (!appId || !privateKey) {
      this.logger.warn(
        'GitHub App ID or Private Key is missing. GitHub integration will not work.',
      );
      return;
    }

    const octokitModule = await eval('import("octokit")');
    const AppClass = octokitModule.App;

    this.app = new AppClass({
      appId,
      privateKey,
      webhooks: {
        secret: this.configService.get<string>('GITHUB_WEBHOOK_SECRET', ''),
      },
    });

    this.logger.log('GitHub App initialized successfully');
  }

  /**
   * Retrieves an authenticated Octokit instance for a specific installation
   */
  async getInstallationOctokit(installationId: number) {
    if (!this.app) throw new Error('GitHub App not initialized');
    return await this.app.getInstallationOctokit(installationId);
  }

  /**
   * Short-lived authenticated HTTPS URL for git fetch/push on an installed
   * repo. Format: https://x-access-token:<token>@github.com/owner/repo.git
   * Callers MUST scrub the token from the remote config after use.
   */
  async getAuthenticatedRepoUrl(
    owner: string,
    repo: string,
    installationId: number,
  ): Promise<string> {
    const octokit = await this.getInstallationOctokit(installationId);
    const { data } = await octokit.rest.apps.createInstallationAccessToken({
      installation_id: installationId,
    });
    return `https://x-access-token:${data.token}@github.com/${owner}/${repo}.git`;
  }

  /**
   * Resolves the installation id for a repository. Needed by MCP tools, which
   * receive only an "owner/repo" string and have no webhook payload to read
   * `installation.id` from.
   */
  async getRepoInstallationId(owner: string, repo: string): Promise<number> {
    if (!this.app) throw new Error('GitHub App not initialized');

    try {
      const { data } = await this.app.octokit.rest.apps.getRepoInstallation({
        owner,
        repo,
      });
      return data.id;
    } catch (error: unknown) {
      const status = (error as { status?: number })?.status;
      if (status === 404) {
        throw new Error(
          `The LazyDev GitHub App is not installed on ${owner}/${repo} (or cannot see it). Install the app on that repository first.`,
        );
      }
      throw error;
    }
  }
}

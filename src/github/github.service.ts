import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { App } from 'octokit';
import * as fs from 'fs';
import * as path from 'path';

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
    let privateKey = this.configService.get<string>('GITHUB_PRIVATE_KEY');

    // Support picking up the private key from a file path
    const privateKeyPath = this.configService.get<string>(
      'GITHUB_PRIVATE_KEY_PATH',
    );
    if (!privateKey && privateKeyPath) {
      try {
        privateKey = fs.readFileSync(
          path.resolve(process.cwd(), privateKeyPath),
          'utf8',
        );
      } catch {
        this.logger.error(`Could not read private key from ${privateKeyPath}`);
      }
    }

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

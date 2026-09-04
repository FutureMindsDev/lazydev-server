import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Webhooks } from '@octokit/webhooks';
import { IngestionService } from '../ingestion/ingestion.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MCP_ISSUE_MARKER } from '../mcp-server/mcp.constants';

@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger(WebhooksService.name);
  public webhooks: Webhooks;

  constructor(
    private configService: ConfigService,
    private ingestionService: IngestionService,
    private notificationsService: NotificationsService,
  ) {}

  async onModuleInit() {
    const secret = this.configService.get<string>('GITHUB_WEBHOOK_SECRET', '');
    if (!secret) {
      this.logger.warn(
        'GITHUB_WEBHOOK_SECRET is missing. Webhooks cannot be verified securely.',
      );
    }

    const webhooksModule = await eval('import("@octokit/webhooks")');
    const WebhooksClass = webhooksModule.Webhooks;

    this.webhooks = new WebhooksClass({
      secret: secret || 'default_secret',
    });

    this.setupHandlers();
  }

  private setupHandlers() {
    this.webhooks.on('issues.opened', async ({ id, payload }) => {
      this.logger.log(`Issue opened: ${payload.issue.title}`);

      // Issues created by the MCP `implement_new_feature` tool already have a
      // job queued against them — don't run the pipeline twice.
      if (payload.issue.body?.includes(MCP_ISSUE_MARKER)) {
        this.logger.log(
          `Issue #${payload.issue.number} was created by the MCP server; skipping (already queued).`,
        );
        return;
      }

      await this.ingestionService.queueIssueEvent(payload, id);
    });

    this.webhooks.on('issues.reopened', async ({ id, payload }) => {
      this.logger.log(`Issue reopened: ${payload.issue.title}`);
      await this.ingestionService.queueIssueEvent(payload, id);
    });

    this.webhooks.onAny(({ id, name }) => {
      this.logger.log(`Received GitHub Event: ${name} (ID: ${id})`);
    });

    this.webhooks.on('check_run.completed', async ({ payload }) => {
      const branchName = payload.check_run.check_suite.head_branch;
      if (branchName && branchName.startsWith('lazydev/fix-')) {
        const status = payload.check_run.conclusion; // 'success' or 'failure'
        const issueMatch = branchName.match(/fix-(\d+)-/);
        const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : 0;

        const title =
          status === 'success'
            ? `✅ CI Passed for Issue #${issueNumber}`
            : `❌ CI Failed for Issue #${issueNumber}`;
        const color = status === 'success' ? 3066993 : 15158332;

        await this.notificationsService.sendDiscordNotification({
          title,
          description: `The CI pipeline for branch \`${branchName}\` concluded with status: **${status}**. \n[View CI Logs](${payload.check_run.html_url})`,
          color,
        });

        if (
          status === 'failure' ||
          status === 'timed_out' ||
          status === 'action_required'
        ) {
          this.logger.warn(
            `CI failed for ${branchName}. Re-queueing issue #${issueNumber} for self-healing.`,
          );
          // Re-queue the issue to trigger another orchestration pipeline
          await this.ingestionService.queueIssueEvent({
            repository: payload.repository,
            issue: {
              number: issueNumber,
              title: `Auto-restart for CI failure on ${branchName}`,
              body: 'CI failed.',
            },
            action: 'ci_failure',
            installation: payload.installation,
          });
        }
      }
    });
  }
}

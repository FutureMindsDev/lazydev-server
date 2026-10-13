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
import type { Webhooks } from '@octokit/webhooks';
import Redis from 'ioredis';
import { IngestionService } from '../ingestion/ingestion.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MCP_ISSUE_MARKER } from '../mcp-server/mcp.constants';

/** Max CI-failure auto-requeues per branch per day. Without a cap, a repo
 *  whose CI always fails becomes an infinite job loop (infinite LLM bill). */
const MAX_CI_REQUEUES = 3;
/** Counter lifetime: one day. A branch that goes green resets sooner. */
const REQUEUE_WINDOW_SECONDS = 86_400;

@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger(WebhooksService.name);
  public webhooks: Webhooks;
  private redis: Redis;

  constructor(
    private configService: ConfigService,
    private ingestionService: IngestionService,
    private notificationsService: NotificationsService,
  ) {}

  async onModuleInit() {
    const rawSecret = this.configService.get<string>('GITHUB_WEBHOOK_SECRET');
    // Trim it: a secret of only spaces is the same as no secret at all.
    // Fail closed: without a real secret anyone could forge webhooks and
    // queue free jobs (which spend your LLM money). Never fall back to a
    // default secret.
    const secret = rawSecret?.trim() ?? '';
    if (!secret) {
      throw new Error(
        'GITHUB_WEBHOOK_SECRET is missing or empty. Set it in .env to match your GitHub App webhook secret.',
      );
    }

    const webhooksModule = await eval('import("@octokit/webhooks")');
    const WebhooksClass = webhooksModule.Webhooks;

    this.webhooks = new WebhooksClass({
      secret,
    });

    // Dedicated lightweight client for the CI-requeue counter (same
    // password rules as every other Redis client — empty means none).
    this.redis = new Redis({
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD') || undefined,
      // Never hold boot hostage on a sick Redis; webhook handlers
      // fail-open to the old behavior (see below) instead.
      maxRetriesPerRequest: 2,
    });
    this.redis.on('error', (err: Error) => {
      this.logger.warn(`Requeue-counter Redis error: ${err.message}`);
    });

    this.setupHandlers();
  }

  /**
   * Count this CI failure for the branch (1 = first failure). Returns a
   * number over MAX_CI_REQUEUES when the budget is spent. On any Redis
   * trouble, returns 1 (fail OPEN to the old always-requeue behavior —
   * a stuck webhook pipeline is worse than an extra retry).
   */
  private async countCiRequeue(branchName: string): Promise<number> {
    try {
      const key = `requeue:${branchName}`;
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, REQUEUE_WINDOW_SECONDS);
      return count;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `Could not count CI requeue for ${branchName}: ${msg}. Allowing retry (fail-open).`,
      );
      return 1;
    }
  }

  /** Clear the failure counter (called when CI goes green). */
  private async resetCiRequeueCount(branchName: string): Promise<void> {
    await this.redis.del(`requeue:${branchName}`);
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

        if (status === 'success') {
          // Green again — reset the failure counter for this branch.
          await this.resetCiRequeueCount(branchName).catch(() => undefined);
        }

        if (
          status === 'failure' ||
          status === 'timed_out' ||
          status === 'action_required'
        ) {
          const attempt = await this.countCiRequeue(branchName);
          if (attempt > MAX_CI_REQUEUES) {
            this.logger.warn(
              `CI failed for ${branchName} (${attempt - 1} auto-retries already used). Stopping — needs a human.`,
            );
            await this.notificationsService.sendDiscordNotification({
              title: `Auto-retry stopped for Issue #${issueNumber}`,
              description: `CI on \`${branchName}\` failed ${attempt - 1} times in 24h. LazyDev will NOT re-queue again — a human needs to look at it.\n[View CI Logs](${payload.check_run.html_url})`,
              color: 15158332,
            });
            return;
          }
          this.logger.warn(
            `CI failed for ${branchName}. Re-queueing issue #${issueNumber} for self-healing (auto-retry ${attempt}/${MAX_CI_REQUEUES}).`,
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

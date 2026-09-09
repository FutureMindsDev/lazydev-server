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

/* eslint-disable */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AuditLogService } from '../orchestration/audit-log.service';

/**
 * Backfills FAILED audit log entries for BullMQ jobs that crashed before
 * the try/catch fix in OrchestrationService.runPipeline was deployed.
 *
 * On application startup, scans the 'issue-processing' queue for failed
 * jobs that have no corresponding audit log (by taskId) and creates a
 * FAILED entry from the job's data + failedReason. This is a one-time
 * reconciliation — once all pre-fix jobs are backfilled, subsequent
 * failures are handled by the runPipeline catch block.
 */
@Injectable()
export class AuditLogBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditLogBackfillService.name);

  constructor(
    @InjectQueue('issue-processing') private readonly issueQueue: Queue,
    private readonly auditLogService: AuditLogService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Run asynchronously so it never blocks app startup.
    this.backfill().catch((err) =>
      this.logger.error(`Backfill failed: ${err?.message ?? err}`),
    );
  }

  async backfill(): Promise<number> {
    const failedJobs = await this.issueQueue.getFailed(0, 100);
    if (failedJobs.length === 0) {
      this.logger.log('No failed jobs to backfill.');
      return 0;
    }

    let backfilled = 0;
    for (const job of failedJobs) {
      const taskId = job.id;
      if (!taskId) continue;

      // Skip if an audit log already exists for this taskId.
      const existing = await this.auditLogService.findByTaskId(taskId);
      if (existing) continue;

      // Synthesize a minimal AgentState from the BullMQ job data so
      // logPipelineOutcome can persist it. The job's failedReason becomes
      // validationFeedback (surfaced as "finalValidationFeedback" in the
      // audit log and on the dashboard Run Detail screen).
      const data = job.data || {};
      const issueNumber = data.issueNumber ?? 0;
      const issueTitle = data.title || 'Unknown';
      const repoFullName = data.repository;
      const installationId = data.installationId;

      const syntheticState: any = {
        isValid: false,
        validationFeedback: job.failedReason ?? 'Unknown failure',
        validationAttempts: 0,
        issuePayload: {
          taskId,
          issue: { number: issueNumber, title: issueTitle, body: data.body ?? '' },
          repository: repoFullName
            ? {
                full_name: repoFullName,
                name: repoFullName.split('/')[1] ?? '',
                owner: { login: repoFullName.split('/')[0] ?? '' },
              }
            : undefined,
          installation: installationId ? { id: installationId } : undefined,
        },
      };

      try {
        await this.auditLogService.logPipelineOutcome(syntheticState);
        backfilled += 1;
        this.logger.log(
          `Backfilled FAILED audit log for job ${taskId} ` +
            `(issue #${issueNumber}, repo ${repoFullName ?? 'unknown'})`,
        );
      } catch (err: any) {
        this.logger.error(
          `Failed to backfill audit log for job ${taskId}: ${err?.message}`,
        );
      }
    }

    this.logger.log(`Backfill complete: ${backfilled} audit log(s) created.`);
    return backfilled;
  }
}

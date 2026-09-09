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
import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DashboardService } from '../dashboard.service';
import { AuditLogService } from '../../orchestration/audit-log.service';
import { FeedbackRequest } from '../dashboard.dto';
import type {
  AuditLogDto,
  Paginated,
  RunDetailDto,
  FeedbackResponse,
  FeedbackStatus,
} from '../dashboard.dto';

@Controller('api/dashboard')
export class RunsController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly auditLogService: AuditLogService,
    @InjectQueue('issue-processing') private readonly issueQueue: Queue,
  ) {}

  @Get('runs')
  async listRuns(
    @Query('installationId') installationId?: number,
    @Query('repo') repo?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('status') status?: 'SUCCESS' | 'FAILED',
    @Query('search') search?: string,
  ): Promise<Paginated<AuditLogDto>> {
    return this.dashboardService.listRuns({
      installationId,
      repo,
      limit,
      offset,
      status,
      search,
    });
  }

  @Get('runs/:taskId')
  async getRun(
    @Param('taskId') taskId: string,
    @Query('installationId') _installationId?: number,
  ): Promise<RunDetailDto> {
    const run = await this.dashboardService.getRunDetail(taskId);
    if (!run) {
      throw new NotFoundException(null as any, `Run ${taskId} not found`);
    }
    return run;
  }

  @Post('runs/:taskId/feedback')
  async sendFeedback(
    @Param('taskId') taskId: string,
    @Body() body: FeedbackRequest,
    @Query('installationId') _installationId?: number,
  ): Promise<FeedbackResponse> {
    if (!body?.feedback || !body.feedback.trim()) {
      throw new BadRequestException('feedback must be a non-empty string');
    }
    return this.dashboardService.submitFeedback(taskId, body.feedback.trim());
  }

  @Get('runs/:taskId/feedback-status')
  async getFeedbackStatus(
    @Param('taskId') taskId: string,
    @Query('installationId') _installationId?: number,
  ): Promise<FeedbackStatus> {
    return this.dashboardService.getFeedbackStatus(taskId);
  }

  // ── #6 retry run ─────────────────────────────────────────────────────────
  @Post('repos/:repo/issues/:number/retry')
  async retryRun(
    @Param('repo') repo: string,
    @Param('number') issueNumber: number,
    @Query('installationId') installationId?: number,
  ): Promise<{ ok: boolean; taskId: string }> {
    // Re-enqueue the issue into the processing queue. The job data shape
    // mirrors IngestionService.queueIssueEvent so IssueProcessor handles it
    // identically. taskId is the BullMQ job id (correlated with audit logs).
    const [owner, name] = decodeURIComponent(repo).split('/');
    const taskId = `retry-${owner}-${name}-${issueNumber}-${Date.now()}`;
    await this.issueQueue.add(
      'process-issue',
      {
        repository: decodeURIComponent(repo),
        issueNumber: Number(issueNumber),
        title: '',
        body: null,
        action: 'reopened',
        installationId: installationId ?? 0,
        labels: [],
      },
      {
        jobId: taskId,
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    );
    return { ok: true, taskId };
  }
}

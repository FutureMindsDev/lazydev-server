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
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DashboardService } from '../dashboard.service';
import type { RepositoryDto, RepoIndexStats } from '../dashboard.dto';

@Controller('api/dashboard')
export class ReposController {
  constructor(
    private readonly dashboardService: DashboardService,
    @InjectQueue('issue-processing') private readonly issueQueue: Queue,
  ) {}

  @Get('repos')
  async listRepos(
    @Query('installationId') installationId?: number,
  ): Promise<RepositoryDto[]> {
    return this.dashboardService.listRepos(installationId);
  }

  @Post('repos/:id/resync')
  async resyncRepo(@Param('id') repoId: string): Promise<{ ok: boolean }> {
    // Re-trigger indexing by re-adding an onboarding job. The repo must
    // already be cached (have a RepositoryCache row); we look it up to get
    // the owner/name/installationId so the job data matches the processor's
    // expected shape. A dedicated onboard queue can replace this later.
    const ok = await this.dashboardService.resyncRepo(repoId, this.issueQueue);
    if (!ok) throw new NotFoundException(`Repo ${repoId} not found`);
    return { ok: true };
  }

  @Get('repos/:id/stats')
  async getRepoStats(@Param('id') repoId: string): Promise<RepoIndexStats> {
    return this.dashboardService.getRepoStats(repoId);
  }
}

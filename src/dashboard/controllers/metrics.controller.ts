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
import { Controller, Get } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DashboardService } from '../dashboard.service';

@Controller('api/dashboard')
export class MetricsController {
  constructor(
    @InjectQueue('issue-processing') private readonly issueQueue: Queue,
    private readonly dashboardService: DashboardService,
  ) {}

  @Get('metrics')
  async getMetrics(): Promise<Record<string, unknown>> {
    return this.dashboardService.getMetrics(this.issueQueue);
  }
}

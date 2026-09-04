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

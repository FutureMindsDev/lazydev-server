import { Controller, Get } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AuditLogService } from '../orchestration/audit-log.service';

@Controller('api/dashboard')
export class DashboardController {
  constructor(
    @InjectQueue('issue-processing') private readonly issueQueue: Queue,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get('metrics')
  async getMetrics() {
    // BullMQ stats
    const jobCounts = await this.issueQueue.getJobCounts();

    // DB stats
    const auditStats = await this.auditLogService.getMetrics();

    return {
      queues: {
        'issue-processing': jobCounts,
      },
      auditLogs: auditStats,
      status: 'operational',
      timestamp: new Date().toISOString(),
    };
  }
}

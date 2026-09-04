/* eslint-disable */
import { Controller, Get } from '@nestjs/common';
import { DashboardService } from '../dashboard.service';
import type { DashboardMeta } from '../dashboard.dto';

@Controller('api/dashboard')
export class MetaController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('meta')
  async getMeta(): Promise<DashboardMeta> {
    return this.dashboardService.getMeta();
  }
}

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

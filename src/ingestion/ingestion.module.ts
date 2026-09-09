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

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionService } from './ingestion.service';
import { IssueProcessor } from './issue.processor';
import { AuditLogBackfillService } from './audit-log-backfill.service';
import { RepositoryCacheModule } from '../repository/repository-cache.module';
import { GitModule } from '../git/git.module';
import { LockModule } from '../locks/lock.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'issue-processing',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        // Remove job data from Redis after completion/failure so stale
        // jobs don't re-queue after a container restart.
        removeOnComplete: { count: 10 }, // keep last 10 for visibility
        removeOnFail: { count: 10 },     // keep last 10 for debugging
      },
    }),
    RepositoryCacheModule,
    GitModule,
    LockModule,
    OrchestrationModule,
    IntelligenceModule,
  ],
  providers: [IngestionService, IssueProcessor, AuditLogBackfillService],
  exports: [IngestionService],
})
export class IngestionModule {}

/* eslint-disable */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { HumanFeedbackModule } from '../feedback/human-feedback.module';
import { RepositoryCacheModule } from '../repository/repository-cache.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { RepositoryCache } from '../repository/entities/repository-cache.entity';
import { DashboardService } from './dashboard.service';
import { MetaController } from './controllers/meta.controller';
import { RunsController } from './controllers/runs.controller';
import { QueuesController } from './controllers/queues.controller';
import { ReposController } from './controllers/repos.controller';
import { SettingsController } from './controllers/settings.controller';
import { EventsController } from './controllers/events.controller';
import { MetricsController } from './controllers/metrics.controller';

@Module({
  imports: [
    OrchestrationModule, // AuditLogService
    HumanFeedbackModule, // HumanFeedbackService
    RepositoryCacheModule, // RepositoryCacheService + RepositoryCache entity
    IntelligenceModule, // VectorDbService (Qdrant stats)
    TypeOrmModule.forFeature([RepositoryCache]), // direct repo lookup for stats/resync
    BullModule.registerQueue({ name: 'issue-processing' }),
  ],
  providers: [DashboardService],
  controllers: [
    MetaController,
    MetricsController,
    RunsController,
    QueuesController,
    ReposController,
    SettingsController,
    EventsController,
  ],
})
export class DashboardModule {}

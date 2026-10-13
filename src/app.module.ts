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
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GithubModule } from './github/github.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { RepositoryCacheModule } from './repository/repository-cache.module';
import { GitModule } from './git/git.module';
import { LockModule } from './locks/lock.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { ValidationModule } from './validation/validation.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { OrchestrationModule } from './orchestration/orchestration.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AuthModule } from './auth/auth.module';
import { McpServerModule } from './mcp-server/mcp-server.module';

@Module({
  imports: [
    GithubModule,
    WebhooksModule,
    IngestionModule,
    RepositoryCacheModule,
    GitModule,
    LockModule,
    SandboxModule,
    ValidationModule,
    IntelligenceModule,
    OrchestrationModule,
    NotificationsModule,
    DashboardModule,
    AuthModule,
    McpServerModule,
    // Environment Variables
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // PostgreSQL Database Integration
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT', 5432),
        username: configService.get<string>('DB_USER', 'postgres'),
        password: configService.get<string>('DB_PASSWORD', 'postgres'),
        database: configService.get<string>('DB_NAME', 'lazy_issue_resolver'),
        autoLoadEntities: true,
        // Never auto-migrate production: synchronize lets the app
        // create or alter tables on every restart, so one bad entity
        // change could eat real data. Local dev keeps it on for speed.
        synchronize:
          configService.get<string>('NODE_ENV', 'development') !== 'production',
      }),
    }),

    // Redis / BullMQ Integration
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          // Empty REDIS_PASSWORD (local dev) = no password sent. Set it and
          // every client sends it — avoids NOAUTH outages where the server
          // requires a password but a client forgot to send one.
          password: configService.get<string>('REDIS_PASSWORD') || undefined,
        },
      }),
    }),

    // Security (Rate Limiting)
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),

    // Observability (Metrics)
    PrometheusModule.register(),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Rate limiting is the ONLY guard here (there is no auth system in this
    // repo). It must be registered or the ThrottlerModule above never blocks
    // anything — public routes (webhooks, MCP) need DoS / LLM-burn cover.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}

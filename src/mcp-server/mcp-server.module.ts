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
import { GithubModule } from '../github/github.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { HumanFeedbackModule } from '../feedback/human-feedback.module';
import { McpServerService } from './mcp-server.service';
import { McpTaskService } from './mcp-task.service';
import { McpController } from './mcp.controller';

/**
 * Exposes LazyDev as an MCP *Server* so external MCP clients (Hermes, OpenClaw)
 * can drive the orchestration pipeline.
 *
 * This is entirely independent of the MCP *client* used to talk to the Serena
 * sidecar (`IntelligenceModule` / `SerenaMcpService`).
 */
@Module({
  imports: [
    // Tools enqueue jobs rather than running pipelines synchronously.
    BullModule.registerQueue({ name: 'issue-processing' }),
    // Resolving installation ids, reading issues, creating feature issues.
    GithubModule,
    // AuditLogService — status fallback for jobs already evicted from Redis.
    OrchestrationModule,
    // Shared feedback store; the orchestration graph is the reader.
    HumanFeedbackModule,
  ],
  controllers: [McpController],
  providers: [McpServerService, McpTaskService],
  exports: [McpTaskService],
})
export class McpServerModule {}

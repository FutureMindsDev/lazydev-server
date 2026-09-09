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
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { GitModule } from '../git/git.module';
import { ValidationModule } from '../validation/validation.module';
import { GithubModule } from '../github/github.module';
import { HumanFeedbackModule } from '../feedback/human-feedback.module';
import { OrchestrationService } from './orchestration.service';
import { LlmService } from './llm.service';
import { OnboardingAgent } from './agents/onboarding.agent';
import { PlannerAgent } from './agents/planner.agent';
import { PatchGeneratorAgent } from './agents/patch-generator.agent';
import { ValidationAgent } from './agents/validation.agent';
import { GitAgent } from './agents/git.agent';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { AuditLogService } from './audit-log.service';
import { LlmConfig } from './entities/llm-config.entity';
import { LlmProviderConfig } from './entities/llm-provider-config.entity';
import { LlmConfigService } from './llm-config.service';
import { LlmProviderConfigService } from './llm-provider-config.service';

@Module({
  imports: [
    IntelligenceModule,
    SandboxModule,
    GitModule,
    ValidationModule,
    GithubModule,
    HumanFeedbackModule,
    TypeOrmModule.forFeature([AuditLog, LlmConfig, LlmProviderConfig]),
  ],
  providers: [
    OrchestrationService,
    LlmService,
    LlmConfigService,
    LlmProviderConfigService,
    OnboardingAgent,
    PlannerAgent,
    PatchGeneratorAgent,
    ValidationAgent,
    GitAgent,
    AuditLogService,
  ],
  exports: [OrchestrationService, AuditLogService, LlmService, LlmConfigService, LlmProviderConfigService],
})
export class OrchestrationModule {}

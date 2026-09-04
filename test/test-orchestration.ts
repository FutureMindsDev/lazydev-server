import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { OrchestrationService } from '../src/orchestration/orchestration.service';
import { LlmService } from '../src/orchestration/llm.service';
import { OnboardingAgent } from '../src/orchestration/agents/onboarding.agent';
import { PlannerAgent } from '../src/orchestration/agents/planner.agent';
import { PatchGeneratorAgent } from '../src/orchestration/agents/patch-generator.agent';
import { ValidationAgent } from '../src/orchestration/agents/validation.agent';
import { GitAgent } from '../src/orchestration/agents/git.agent';
import { SearchService } from '../src/intelligence/search.service';
import { VectorDbService } from '../src/intelligence/vector-db.service';
import { SerenaMcpService } from '../src/intelligence/serena-mcp.service';
import { SandboxService } from '../src/sandbox/sandbox.service';
import { GitService } from '../src/git/git.service';
import { GithubService } from '../src/github/github.service';
import { ValidationService } from '../src/validation/validation.service';
import { AuditLogService } from '../src/orchestration/audit-log.service';
import { HumanFeedbackService } from '../src/feedback/human-feedback.service';

// Mock Services
class MockSearchService {
  async search() { return [{ file: 'mock.ts', line: 1, content: 'function mock() {}' }]; }
}
class MockVectorDbService {
  async onModuleInit() {}
}
class MockSerenaMcpService {
  async onModuleInit() {}
  async onModuleDestroy() {}
  async callTool() { return { content: 'Mocked Serena response' }; }
}
class MockSandboxService {
  async executeCommand() {
    return { stdout: 'Mock build success', stderr: '', durationMs: 100 };
  }
}
class MockGitService {
  buildBranchName() { return 'fix/mock-branch'; }
  async createFixBranch() {}
  async commitAndPush() {}
}
class MockGithubService {
  async onModuleInit() {}
}
class MockValidationService {
  async validate() {
    return { isValid: true, feedback: '' };
  }
}
class MockAuditLogService {
  async logPipelineOutcome(state: any) {
    console.log(`[AuditLogService] Audit log saved for issue with status: ${state.isValid ? 'SUCCESS' : 'FAILED'}`);
  }
}
class MockHumanFeedbackService {
  async consume() { return null; }
}

class MockLlmService {
  getModel() {
    return {
      invoke: async (messages) => {
        return { content: 'Mocked LLM Response' };
      }
    };
  }
}

@Module({
  providers: [
    OrchestrationService,
    OnboardingAgent,
    PlannerAgent,
    PatchGeneratorAgent,
    ValidationAgent,
    GitAgent,
    { provide: LlmService, useClass: MockLlmService },
    { provide: SearchService, useClass: MockSearchService },
    { provide: VectorDbService, useClass: MockVectorDbService },
    { provide: SerenaMcpService, useClass: MockSerenaMcpService },
    { provide: SandboxService, useClass: MockSandboxService },
    { provide: GitService, useClass: MockGitService },
    { provide: GithubService, useClass: MockGithubService },
    { provide: ValidationService, useClass: MockValidationService },
    { provide: AuditLogService, useClass: MockAuditLogService },
    { provide: HumanFeedbackService, useClass: MockHumanFeedbackService },
  ]
})
class TestModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(TestModule, { logger: ['log', 'error', 'warn'] });
  const orchestrationService = app.get(OrchestrationService);

  const mockPayload = {
    issue: {
      title: 'Fix typo in validation service',
      body: 'There is a typo in the validation error message. Please fix it.',
    }
  };

  console.log('--- Starting Multi-Agent Pipeline ---');

  try {
    const state = await orchestrationService.runPipeline(mockPayload);

    console.log('\\n--- Pipeline Complete ---');
    console.log('IsValid:', state.isValid);
    console.log('Validation Feedback:', state.validationFeedback);
    console.log('\\nGenerated Patch Preview:\\n', state.generatedPatch);

  } catch (err) {
    console.error('Pipeline failed:', err);
  }

  await app.close();
}

bootstrap();

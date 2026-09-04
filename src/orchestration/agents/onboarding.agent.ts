/* eslint-disable */
import { Injectable, Logger } from '@nestjs/common';
import { AgentState } from '../graph.state';
import { LlmService } from '../llm.service';
import { SerenaMcpService } from '../../intelligence/serena-mcp.service';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class OnboardingAgent {
  private readonly logger = new Logger(OnboardingAgent.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly serenaMcp: SerenaMcpService,
  ) {}

  async invoke(state: AgentState): Promise<Partial<AgentState>> {
    if (process.env.ENABLE_SERENA_MEMORIES !== 'true') {
      this.logger.log('Serena memories onboarding is disabled. Skipping.');
      return {};
    }

    const worktreePath = state.issuePayload?.worktreePath;
    if (!worktreePath) {
      this.logger.warn('No worktreePath found in state. Skipping onboarding.');
      return {};
    }

    // Memories physically live under `<active project>/.serena/memories/`.
    // The worktree is deleted at the end of this job, so any memory written
    // while it is the active project is lost with it. `repoPath` — the
    // shared repo-cache clone, reused across every job for this repo — is
    // the only path that actually survives, so memory reads/writes target
    // that instead. (Falls back to worktreePath if repoPath is ever missing,
    // so onboarding still works — just without cross-job persistence.)
    const memoryProjectPath = state.issuePayload?.repoPath || worktreePath;

    this.logger.log(`Starting onboarding for project at: ${worktreePath}`);

    try {
      // 0. Activate the persistent project for the memory operations below.
      await this.serenaMcp.activateProject(memoryProjectPath);

      // 1. List existing memories to avoid redundant operations
      const listResponse = await this.serenaMcp.listMemories();
      const listString = JSON.stringify(listResponse);

      const hasGlobalRepoStructure = listString.includes('global_repo_structure');
      const hasHistoricalIssues = listString.includes('historical_issues_and_lessons');

      // 2. Initialize global_repo_structure if missing
      if (!hasGlobalRepoStructure) {
        this.logger.log('Initializing global_repo_structure memory...');
        // The tree must reflect the actual checked-out branch/commit for this
        // job, so it is read from the ephemeral worktree even though the
        // resulting memory is stored against the persistent repo path.
        const treeStr = await this.buildRepoTree(worktreePath);
        const summary = await this.summarizeTree(
          treeStr,
          state.issuePayload?.installation?.id,
        );

        const writeResult = await this.serenaMcp.writeMemory('global_repo_structure', summary);
        if (writeResult?.isError) {
          this.logger.error(
            `Failed to write global_repo_structure memory: ${writeResult.content?.[0]?.text ?? 'unknown error'}`,
          );
        } else {
          this.logger.log('Successfully created global_repo_structure memory.');
        }
      } else {
        this.logger.log('global_repo_structure memory already exists. Skipping.');
      }

      // 3. Initialize historical_issues_and_lessons if missing
      if (process.env.ENABLE_SERENA_ISSUE_HISTORY === 'true') {
        if (!hasHistoricalIssues) {
          this.logger.log('Initializing historical_issues_and_lessons memory...');
          const template = JSON.stringify({
            description: "Running log of historical issues, methods used, and lessons learned during automated fix attempts.",
            entries: []
          }, null, 2);

          const writeResult = await this.serenaMcp.writeMemory('historical_issues_and_lessons', template);
          if (writeResult?.isError) {
            this.logger.error(
              `Failed to write historical_issues_and_lessons memory: ${writeResult.content?.[0]?.text ?? 'unknown error'}`,
            );
          } else {
            this.logger.log('Successfully created historical_issues_and_lessons memory.');
          }
        } else {
          this.logger.log('historical_issues_and_lessons memory already exists. Skipping.');
        }
      }

      // Reactivate the ephemeral worktree so any agent running right after
      // this one (without its own activateProject call) still targets the
      // real checkout rather than the persistent repo-cache clone.
      await this.serenaMcp.activateProject(worktreePath);
    } catch (e: any) {
      this.logger.error('Failed during Serena onboarding:', e);
    }

    return {};
  }

  private async buildRepoTree(dir: string, depth: number = 0, maxDepth: number = 3): Promise<string> {
    if (depth > maxDepth) return '...';
    let result = '';
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (['node_modules', '.git', 'dist', 'build', 'coverage'].includes(entry.name)) continue;
        
        result += '  '.repeat(depth) + (entry.isDirectory() ? '📂 ' : '📄 ') + entry.name + '\n';
        if (entry.isDirectory()) {
          result += await this.buildRepoTree(path.join(dir, entry.name), depth + 1, maxDepth);
        }
      }
    } catch (e: any) {
      this.logger.warn(`Could not read directory ${dir}: ${e.message}`);
    }
    return result;
  }

  private async summarizeTree(
    tree: string,
    installationId?: number | null,
  ): Promise<string> {
    const systemPrompt = new SystemMessage(
      `You are an expert software architect. Analyze the provided directory structure and provide a concise architectural overview of the project. Focus on identifying the main components, where the business logic resides, where tests are, and the overall tech stack implied by the files. Return ONLY the summary.`
    );
    const userPrompt = new HumanMessage(`Directory Structure:\n${tree}`);

    const response = await this.llmService
      .getModel('onboarding', installationId)
      .invoke([systemPrompt, userPrompt]);
    return response.content.toString();
  }
}

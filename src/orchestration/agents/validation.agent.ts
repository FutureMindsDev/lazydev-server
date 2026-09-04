/* eslint-disable */
import { Injectable, Logger } from '@nestjs/common';
import { AgentState } from '../graph.state';
import { ValidationService } from '../../validation/validation.service';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { SerenaMcpService } from '../../intelligence/serena-mcp.service';
import { LlmService } from '../llm.service';
import { extractMcpText } from '../../common/mcp-text';

@Injectable()
export class ValidationAgent {
  private readonly logger = new Logger(ValidationAgent.name);

  constructor(
    private readonly validationService: ValidationService,
    private readonly serenaMcp: SerenaMcpService,
    private readonly llmService: LlmService,
  ) {}

  async invoke(state: AgentState): Promise<Partial<AgentState>> {
    this.logger.log('Validating generated patch...');

    // Count every visit, including the early return below: the validator's
    // retry edge aborts at 3 attempts, and an early return that skips the
    // increment leaves the counter frozen at 0. That is exactly what fueled
    // the empty-plan death spiral — "No patch found" never counted as an
    // attempt, so the retry edge looped until GraphRecursionError.
    const attempts = (state.validationAttempts || 0) + 1;

    if (!state.generatedPatch) {
      this.logger.warn('No patch generated to validate.');
      return {
        isValid: false,
        validationFeedback: 'No patch found.',
        validationAttempts: attempts,
      };
    }

    const worktreePath = state.issuePayload?.worktreePath;

    if (!worktreePath) {
      this.logger.warn('No worktreePath in state — skipping sandbox validation, marking as valid.');
      return { isValid: true, validationFeedback: 'Skipped (no worktree path).', validationAttempts: attempts };
    }

    try {
      this.logger.log(`Running validation sandbox (Attempt ${attempts})...`);

      // ValidationService auto-detects the project language (Node.js, Python, Go,
      // Rust, PHP, Java, C#) from the worktree and runs the correct install + test
      // command in the appropriate Docker image. No hardcoded language assumptions.
      const result = await this.validationService.validateWorktree(worktreePath);

      if (result.success) {
        this.logger.log(`Patch validation passed (language: ${result.language}).`);
        
        // Asynchronously update lessons learned (non-blocking for returning the state)
        if (process.env.ENABLE_SERENA_ISSUE_HISTORY === 'true') {
          const repoPath = state.issuePayload?.repoPath;
          this.updateLessonsLearned(state, worktreePath, repoPath).catch(err => {
            this.logger.error('Failed to update historical_issues_and_lessons:', err);
          });
        }

        return {
          isValid: true,
          validationFeedback: `All tests passed.\n${result.stdout}`,
          validationAttempts: attempts,
          messages: [new SystemMessage('Validation successful.')],
        };
      } else {
        const feedback = result.stderr || result.stdout || 'Unknown validation error.';
        this.logger.warn(`Validation failed (language: ${result.language}): ${feedback}`);
        return {
          isValid: false,
          validationFeedback: feedback,
          validationAttempts: attempts,
          messages: [new SystemMessage(`Validation failed:\n${feedback}`)],
        };
      }
    } catch (e: any) {
      this.logger.warn(`Validation failed: ${e.message}`);
      return {
        isValid: false,
        validationFeedback: e.message,
        validationAttempts: attempts,
        messages: [new SystemMessage(`Validation failed:\n${e.message}`)],
      };
    }
  }

  private async updateLessonsLearned(
    state: AgentState,
    worktreePath: string,
    repoPath?: string,
  ) {
    this.logger.log('Generating lessons learned from this fix...');
    const issueTitle = state.issuePayload?.issue?.title || state.issuePayload?.title || 'Unknown Issue';
    const plan = state.implementationPlan || 'No plan available';
    const patch = state.generatedPatch || 'No patch available';

    const prompt = `You are a senior software engineer reflecting on a recently resolved issue.
Please write a short JSON object containing a summary of the issue, the solution approach taken, and any lessons learned.
Do not wrap it in markdown block quotes, return strictly valid JSON matching this schema:
{
  "issue": "...",
  "solution": "...",
  "lessons_learned": "..."
}

Context:
Issue Title: ${issueTitle}
Plan: ${plan}
Patch:
${patch}
`;

    let newEntry: any;
    try {
      const response = await this.llmService
        .getModel('validation', state.issuePayload?.installation?.id)
        .invoke([new HumanMessage(prompt)]);
      let content = response.content.toString().trim();
      if (content.startsWith('\`\`\`json')) {
        content = content.replace(/^\`\`\`json/, '').replace(/\`\`\`$/, '').trim();
      }
      newEntry = JSON.parse(content);
    } catch (e) {
      this.logger.warn('Failed to generate or parse lessons learned from LLM:', e);
      return;
    }

    try {
      // Memories physically live under `<active project>/.serena/memories/`,
      // and this ephemeral worktree is deleted when the job ends — so this
      // log must be read/written against the persistent repo-cache clone
      // (repoPath), not the worktree, or every entry would vanish with it.
      const memoryProjectPath = repoPath || worktreePath;
      await this.serenaMcp.activateProject(memoryProjectPath);

      const readRes = await this.serenaMcp.readMemory('historical_issues_and_lessons');
      const memoryText = extractMcpText(readRes) ?? '';

      let parsedMemory: any;
      try {
        parsedMemory = JSON.parse(memoryText);
      } catch (e) {
        // If not parseable, default to a new template
        parsedMemory = {
          description: "Running log of historical issues, methods used, and lessons learned during automated fix attempts.",
          entries: []
        };
      }

      if (!Array.isArray(parsedMemory.entries)) {
        parsedMemory.entries = [];
      }

      parsedMemory.entries.push(newEntry);

      const writeResult = await this.serenaMcp.writeMemory(
        'historical_issues_and_lessons',
        JSON.stringify(parsedMemory, null, 2),
      );

      // Restore the worktree as the active project so anything else in this
      // job (e.g. a retry attempt) still targets the real checkout.
      await this.serenaMcp.activateProject(worktreePath);

      if (writeResult?.isError) {
        this.logger.warn(
          `Failed to write historical_issues_and_lessons memory: ${writeResult.content?.[0]?.text ?? 'unknown error'}`,
        );
      } else {
        this.logger.log('Successfully updated historical_issues_and_lessons memory.');
      }
    } catch (e) {
      this.logger.warn('Failed to read or write historical_issues_and_lessons memory:', e);
    }
  }
}

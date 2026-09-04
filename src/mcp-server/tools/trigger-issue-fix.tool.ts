import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpTaskService } from '../mcp-task.service';
import { GithubService } from '../../github/github.service';
import {
  errorResult,
  parseRepository,
  sanitizeUserText,
  textResult,
} from './tool-utils';

/**
 * `trigger_issue_fix` — points the pipeline at an existing GitHub issue.
 */
export function registerTriggerIssueFixTool(
  server: McpServer,
  taskService: McpTaskService,
  githubService: GithubService,
) {
  server.registerTool(
    'trigger_issue_fix',
    {
      title: 'Trigger issue fix',
      description:
        'Tell the LazyDev agent to fix a specific GitHub issue. Returns a task_id that can be polled with get_pipeline_status.',
      inputSchema: {
        repository: z
          .string()
          .describe('Full repository name, e.g. "owner/repo"'),
        issue_number: z
          .number()
          .int()
          .positive()
          .describe('The GitHub issue number'),
        priority: z
          .enum(['normal', 'urgent'])
          .optional()
          .describe(
            'Queue priority. "urgent" runs this issue ahead of everything already waiting; it cannot interrupt a job that is already running. Defaults to "normal".',
          ),
      },
    },
    async ({ repository, issue_number, priority }) => {
      try {
        const { owner, repo } = parseRepository(repository);

        // The issues.opened webhook may already have queued this exact issue.
        // Re-running it would duplicate the work and fight over the fix branch.
        const inFlight = await taskService.findInFlightTask(
          repository,
          issue_number,
        );
        if (inFlight) {
          return textResult(
            `${repository}#${issue_number} is already queued or running — LazyDev picks up new issues automatically.\ntask_id: ${inFlight}\nPoll it with get_pipeline_status, or send guidance with provide_human_feedback.`,
          );
        }

        const installationId = await githubService.getRepoInstallationId(
          owner,
          repo,
        );
        const octokit =
          await githubService.getInstallationOctokit(installationId);

        const { data: issue } = await octokit.rest.issues.get({
          owner,
          repo,
          issue_number,
        });

        if (issue.pull_request) {
          throw new Error(
            `${repository}#${issue_number} is a pull request, not an issue.`,
          );
        }

        const urgent = priority === 'urgent';
        const taskId = await taskService.enqueueTask(
          {
            repository,
            issueNumber: issue_number,
            title: issue.title,
            body: sanitizeUserText(issue.body ?? ''),
            action: 'mcp_trigger_issue_fix',
            installationId,
            labels: (issue.labels ?? []).map((label) =>
              typeof label === 'string' ? label : (label.name ?? ''),
            ),
            kind: 'fix',
          },
          { urgent },
        );

        return textResult(
          `Queued fix for ${repository}#${issue_number} ("${issue.title}")${
            urgent ? ' — jumping the queue' : ''
          }.\ntask_id: ${taskId}\nPoll progress with get_pipeline_status.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

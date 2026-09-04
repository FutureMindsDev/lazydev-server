import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpTaskService } from '../mcp-task.service';
import { MCP_ISSUE_MARKER } from '../mcp.constants';
import { GithubService } from '../../github/github.service';
import {
  errorResult,
  parseRepository,
  sanitizeUserText,
  textResult,
} from './tool-utils';

/**
 * Labels applied to AI-created feature issues so they are filterable in the
 * GitHub issue list. GitHub creates any that don't exist yet; repositories that
 * reject unknown labels fall back to an unlabelled issue.
 */
const FEATURE_ISSUE_LABELS = ['enhancement', 'lazydev'];

/** Uses the first non-empty line of the description as the issue title. */
function deriveTitle(description: string): string {
  const firstLine =
    description
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? 'Untitled feature';

  const trimmed =
    firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  return `Feature: ${trimmed}`;
}

/**
 * `implement_new_feature` — writes net-new code from a raw chat prompt.
 *
 * A real GitHub issue is created first so the resulting PR is traceable. The
 * issue body carries `MCP_ISSUE_MARKER`, which the webhook handler uses to avoid
 * queueing the same work twice when `issues.opened` fires.
 */
export function registerImplementFeatureTool(
  server: McpServer,
  taskService: McpTaskService,
  githubService: GithubService,
) {
  server.registerTool(
    'implement_new_feature',
    {
      title: 'Implement new feature',
      description:
        'Tell the LazyDev agent to write entirely new code or scaffold components from a description, bypassing existing GitHub issues. Creates a tracking issue, then returns a task_id.',
      inputSchema: {
        repository: z
          .string()
          .describe('Full repository name, e.g. "owner/repo"'),
        feature_description: z
          .string()
          .min(10)
          .describe('What to implement, in plain language'),
      },
    },
    async ({ repository, feature_description }) => {
      try {
        const { owner, repo } = parseRepository(repository);
        const description = sanitizeUserText(feature_description);

        if (description.length < 10) {
          throw new Error(
            'feature_description is too short after sanitization to be actionable.',
          );
        }

        const installationId = await githubService.getRepoInstallationId(
          owner,
          repo,
        );
        const octokit =
          await githubService.getInstallationOctokit(installationId);

        const title = deriveTitle(description);
        const body = [
          description,
          '',
          '---',
          '_Requested via the LazyDev MCP server (`implement_new_feature`)._',
          MCP_ISSUE_MARKER,
        ].join('\n');

        let issueNumber: number;
        let issueUrl: string;
        try {
          const { data: issue } = await octokit.rest.issues.create({
            owner,
            repo,
            title,
            body,
            labels: FEATURE_ISSUE_LABELS,
          });
          issueNumber = issue.number;
          issueUrl = issue.html_url;
        } catch (error: unknown) {
          const status = (error as { status?: number })?.status;

          if (status === 403 || status === 404) {
            throw new Error(
              `Could not create a tracking issue on ${repository}. The LazyDev GitHub App needs the "Issues: write" permission.`,
            );
          }

          // Some repositories reject unknown labels (422). The labels are a
          // convenience, not a requirement — retry without them.
          if (status === 422) {
            const { data: issue } = await octokit.rest.issues.create({
              owner,
              repo,
              title,
              body,
            });
            issueNumber = issue.number;
            issueUrl = issue.html_url;
          } else {
            throw error;
          }
        }

        const taskId = await taskService.enqueueTask({
          repository,
          issueNumber,
          title,
          body: description,
          action: 'mcp_implement_new_feature',
          installationId,
          labels: [],
          // Drives `lazydev/feat-*` branch, `feat:` commit and a PR title
          // without the "Fix:" prefix.
          kind: 'feature',
        });

        return textResult(
          `Queued feature implementation for ${repository}.\ntracking issue: ${issueUrl}\ntask_id: ${taskId}\nPoll progress with get_pipeline_status.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

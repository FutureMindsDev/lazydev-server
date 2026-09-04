import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpTaskService, type TaskStatus } from '../mcp-task.service';
import { errorResult, textResult } from './tool-utils';

const STATE_DESCRIPTIONS: Record<string, string> = {
  waiting: 'Queued — waiting for a free pipeline worker.',
  delayed: 'Scheduled for a retry after an earlier failure.',
  active: 'Running — the multi-agent pipeline is working on it.',
  completed: 'Succeeded — the pipeline finished and pushed its changes.',
  failed: 'Failed — see the reason below.',
  unknown:
    'Unknown task_id. It may have expired (results are kept for 24h), or the id may be incorrect.',
};

function formatStatus(status: TaskStatus): string {
  const lines = [
    `task_id: ${status.taskId}`,
    `status: ${status.state} — ${STATE_DESCRIPTIONS[status.state] ?? ''}`.trim(),
  ];

  if (status.repository) {
    const issueRef = status.issueNumber ? `#${status.issueNumber}` : '';
    lines.push(`target: ${status.repository}${issueRef}`);
  }
  if (status.attemptsMade) lines.push(`attempts: ${status.attemptsMade}`);

  const { progress } = status;
  if (typeof progress === 'number' && progress > 0) {
    lines.push(`progress: ${progress}%`);
  } else if (typeof progress === 'string' && progress) {
    lines.push(`progress: ${progress}`);
  } else if (progress && typeof progress === 'object') {
    lines.push(`progress: ${JSON.stringify(progress)}`);
  }

  if (status.failedReason) lines.push(`reason: ${status.failedReason}`);
  if (status.fromAuditLog) {
    lines.push('(recovered from the audit log — the queue entry has expired)');
  }
  if (status.state === 'failed') {
    lines.push(
      'You can send a correction with provide_human_feedback to re-run this task.',
    );
  }

  return lines.join('\n');
}

/**
 * `get_pipeline_status` — polls the state of a queued or finished task.
 */
export function registerGetPipelineStatusTool(
  server: McpServer,
  taskService: McpTaskService,
) {
  server.registerTool(
    'get_pipeline_status',
    {
      title: 'Get pipeline status',
      description:
        'Check whether a LazyDev task is queued, running, failed, or succeeded.',
      inputSchema: {
        task_id: z
          .string()
          .describe(
            'The task ID returned by trigger_issue_fix or implement_new_feature',
          ),
      },
    },
    async ({ task_id }) => {
      try {
        const status = await taskService.getTaskStatus(task_id);
        return textResult(formatStatus(status));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

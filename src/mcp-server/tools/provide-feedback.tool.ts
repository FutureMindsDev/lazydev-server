import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpTaskService } from '../mcp-task.service';
import { errorResult, sanitizeUserText, textResult } from './tool-utils';

/**
 * `provide_human_feedback` — injects a human correction into a task.
 *
 * The pipeline runs in-process (LangGraph, no checkpointing), so feedback is
 * applied at one of two points:
 *  - the task is still queued/running → stored in Redis and merged into
 *    `validationFeedback` the next time the validator sends work back to the
 *    patcher;
 *  - the task has already failed → re-queued with the feedback appended to the
 *    issue body, returning a new task_id.
 */
export function registerProvideFeedbackTool(
  server: McpServer,
  taskService: McpTaskService,
) {
  server.registerTool(
    'provide_human_feedback',
    {
      title: 'Provide human feedback',
      description:
        'Inject human feedback or a correction into a LazyDev task. Running tasks pick it up on their next validation retry; already-failed tasks are re-run with the feedback applied.',
      inputSchema: {
        task_id: z.string().describe('The task ID to attach feedback to'),
        feedback: z
          .string()
          .min(1)
          .describe('Human feedback or correction for the agent'),
      },
    },
    async ({ task_id, feedback }) => {
      try {
        const status = await taskService.getTaskStatus(task_id);

        if (status.state === 'unknown') {
          throw new Error(
            `Unknown task_id "${task_id}". It may have expired (results are kept for 24h) or the id may be incorrect.`,
          );
        }

        const sanitized = sanitizeUserText(feedback, 4000);
        await taskService.storeFeedback(task_id, sanitized);

        if (status.state === 'failed') {
          const newTaskId = await taskService.requeueWithFeedback(
            task_id,
            sanitized,
          );

          if (!newTaskId) {
            return textResult(
              `Feedback stored for ${task_id}, but the original job data has expired so it could not be re-run. Start a new task with trigger_issue_fix.`,
            );
          }

          return textResult(
            `Task ${task_id} had already failed, so it was re-queued with your feedback applied.\nnew task_id: ${newTaskId}`,
          );
        }

        if (status.state === 'completed') {
          return textResult(
            `Task ${task_id} has already completed successfully, so the feedback was stored but will not change that run. Use trigger_issue_fix or implement_new_feature to act on it.`,
          );
        }

        return textResult(
          `Feedback stored for ${task_id} (currently ${status.state}). The agent will apply it on its next validation retry.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

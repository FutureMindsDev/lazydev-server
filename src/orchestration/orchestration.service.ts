/* eslint-disable */
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { StateGraph, END, START } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { AgentState, agentStateChannels } from './graph.state';
import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';

import { OnboardingAgent } from './agents/onboarding.agent';
import { PlannerAgent } from './agents/planner.agent';
import { PatchGeneratorAgent } from './agents/patch-generator.agent';
import { ValidationAgent } from './agents/validation.agent';
import { GitAgent } from './agents/git.agent';
import { LlmService } from './llm.service';
import { AuditLogService } from './audit-log.service';
import { HumanFeedbackService } from '../feedback/human-feedback.service';
import {
  checkBatchDispatch,
  DispatchCheckerConfig,
} from '../common/tool-call-tracker';

/**
 * Hard caps for the tool-loop conditional edges — pure backstops.
 *
 * The primary stop condition is the model's own signal (no tool_calls = done),
 * same as Claude Code and OpenAI Codex. The dispatch-boundary repeat detection
 * (see tool-call-tracker.ts) catches spinning loops by refusing duplicate tool
 * calls as ToolMessage results. These hard caps are the last line of defense:
 * if the LLM somehow still produces tool_calls at this cap (e.g. hallucinated
 * tool calls without bindTools), the conditional edge force-breaks the loop.
 *
 * Following the bounded agentic loop pattern: the model's end_turn is the
 * primary exit, budget/refusal is the secondary exit, and this is the
 * tertiary "stop/escalate" exit.
 */
const HARD_CAP_PLANNER_MESSAGES = 60;
const HARD_CAP_PATCHER_MESSAGES = 80;

/**
 * Dispatch-boundary config for the planner's read-only tools.
 * maxRepeatPerTool=1 means a second identical call is refused.
 * maxTotalCalls is the global tool-call budget (separate from message count).
 */
const PLANNER_DISPATCH_CONFIG: DispatchCheckerConfig = {
  maxRepeatPerTool: 1,
  maxTotalCalls: 40,
};

/**
 * Dispatch-boundary config for the patcher's read/edit tools.
 * Higher total budget because multi-file edits need more calls.
 */
const PATCHER_DISPATCH_CONFIG: DispatchCheckerConfig = {
  maxRepeatPerTool: 1,
  maxTotalCalls: 60,
};

@Injectable()
export class OrchestrationService implements OnModuleInit {
  private readonly logger = new Logger(OrchestrationService.name);
  private graph: any; // We use 'any' temporarily as CompiledStateGraph has complex typings

  constructor(
    private readonly onboardingAgent: OnboardingAgent,
    private readonly plannerAgent: PlannerAgent,
    private readonly patchGenerator: PatchGeneratorAgent,
    private readonly validationAgent: ValidationAgent,
    private readonly gitAgent: GitAgent,
    private readonly auditLogService: AuditLogService,
    private readonly humanFeedbackService: HumanFeedbackService,
    // Optional so unit tests can construct OrchestrationService without the
    // DB-backed LLM service (BYOK priming is skipped when absent).
    @Optional() private readonly llmService?: LlmService,
  ) {}

  onModuleInit() {
    this.logger.log('Initializing Multi-Agent LangGraph...');
    this.buildGraph();
  }

  private buildGraph() {
    const workflow = new StateGraph<AgentState>({
      channels: agentStateChannels,
    }) as any;

    // Add nodes
    workflow.addNode('onboarding', async (state: any) =>
      this.onboardingAgent.invoke(state),
    );

    // Merged planner node: does both research (read-only tool loop) and
    // planning (writes implementationPlan) in one LLM conversation,
    // eliminating the lossy prose handoff between the former
    // ResearchAgent and PlanningAgent. The tool loop is handled by the
    // `planner_tools` node + conditional edges below.
    workflow.addNode('planner', async (state: any) =>
      this.plannerAgent.invoke(state),
    );
    // Tools node for the planner's read-only tool loop.
    //
    // Dispatch-boundary repeat detection: before executing tool calls, check
    // each one against the rolling window of prior calls. If a call is a
    // duplicate (same tool + same args), return a refusal as a ToolMessage
    // instead of executing it. The model sees the refusal as the tool's output
    // and must adjust — this is mechanically enforced, not a prompt-level rule.
    //
    // Only non-duplicate calls are dispatched to the actual ToolNode.
    workflow.addNode('planner_tools', async (state: any) => {
      const worktreePath = state.issuePayload?.worktreePath;
      const repoPath = state.issuePayload?.repoPath;
      const tools = this.plannerAgent.getTools(worktreePath, repoPath);
      const plannerMessages = (state.plannerMessages || []) as BaseMessage[];

      // Check all tool calls from the last AIMessage against the rolling window.
      const { refusals, allowedCallIds } = checkBatchDispatch(
        plannerMessages,
        PLANNER_DISPATCH_CONFIG,
      );

      if (refusals.size > 0) {
        this.logger.warn(
          `[planner_tools] Refused ${refusals.size} repeated tool call(s). ` +
            `${allowedCallIds.size} call(s) will be dispatched normally.`,
        );
      }

      // If all calls were refused, return just the refusal messages.
      if (allowedCallIds.size === 0) {
        const refusalMessages = Array.from(refusals.values());
        return {
          plannerMessages: [...plannerMessages, ...refusalMessages],
        };
      }

      // Build a filtered AIMessage that only contains the allowed tool calls,
      // so ToolNode only executes those. We replace the last AIMessage in the
      // history with the filtered version.
      const lastAIMessage = plannerMessages[
        plannerMessages.length - 1
      ] as AIMessage;
      const lastToolCalls = lastAIMessage.tool_calls || [];
      const filteredAIMessage = new AIMessage({
        content: lastAIMessage.content,
        tool_calls: lastToolCalls.filter((tc: any) =>
          allowedCallIds.has(tc.id),
        ),
      });
      const filteredMessages = [
        ...plannerMessages.slice(0, -1),
        filteredAIMessage,
      ];

      // Execute only the allowed tool calls.
      const toolNode = new ToolNode(tools);
      const executedToolMessages = await toolNode.invoke(filteredMessages);

      // Combine executed results + refusals, preserving tool_call_id ordering.
      const allToolMessages: ToolMessage[] = [];
      for (const tc of lastToolCalls) {
        const tcId = tc.id ?? '';
        if (refusals.has(tcId)) {
          allToolMessages.push(refusals.get(tcId)!);
        } else {
          const executed = (executedToolMessages as BaseMessage[]).find(
            (m) => m instanceof ToolMessage && (m as ToolMessage).tool_call_id === tcId,
          );
          if (executed) allToolMessages.push(executed as ToolMessage);
        }
      }

      return {
        plannerMessages: [...plannerMessages, ...allToolMessages],
      };
    });

    workflow.addNode('patcher', async (state: any) =>
      this.patchGenerator.invoke(state),
    );
    // Tools node for the patcher's own tool loop.
    //
    // Same dispatch-boundary repeat detection as planner_tools: duplicate
    // tool calls are refused as ToolMessages instead of being executed.
    workflow.addNode('patcher_tools', async (state: any) => {
      const worktreePath = state.issuePayload?.worktreePath;
      const tools = this.patchGenerator.getToolsForSession(worktreePath);
      const patchMessages = (state.patchMessages || []) as BaseMessage[];

      const { refusals, allowedCallIds } = checkBatchDispatch(
        patchMessages,
        PATCHER_DISPATCH_CONFIG,
      );

      if (refusals.size > 0) {
        this.logger.warn(
          `[patcher_tools] Refused ${refusals.size} repeated tool call(s). ` +
            `${allowedCallIds.size} call(s) will be dispatched normally.`,
        );
      }

      if (allowedCallIds.size === 0) {
        const refusalMessages = Array.from(refusals.values());
        return {
          patchMessages: [...patchMessages, ...refusalMessages],
        };
      }

      const lastAIMessage = patchMessages[
        patchMessages.length - 1
      ] as AIMessage;
      const lastToolCalls = lastAIMessage.tool_calls || [];
      const filteredAIMessage = new AIMessage({
        content: lastAIMessage.content,
        tool_calls: lastToolCalls.filter((tc: any) =>
          allowedCallIds.has(tc.id),
        ),
      });
      const filteredMessages = [
        ...patchMessages.slice(0, -1),
        filteredAIMessage,
      ];

      const toolNode = new ToolNode(tools);
      const executedToolMessages = await toolNode.invoke(filteredMessages);

      const allToolMessages: ToolMessage[] = [];
      for (const tc of lastToolCalls) {
        const tcId = tc.id ?? '';
        if (refusals.has(tcId)) {
          allToolMessages.push(refusals.get(tcId)!);
        } else {
          const executed = (executedToolMessages as BaseMessage[]).find(
            (m) => m instanceof ToolMessage && (m as ToolMessage).tool_call_id === tcId,
          );
          if (executed) allToolMessages.push(executed as ToolMessage);
        }
      }

      return {
        patchMessages: [...patchMessages, ...allToolMessages],
      };
    });
    workflow.addNode('validator', async (state: any) =>
      this.validationAgent.invoke(state),
    );
    workflow.addNode('git', async (state) => this.gitAgent.invoke(state));

    // Sits on the retry path only: pulls any human feedback submitted via the
    // MCP server and folds it into the feedback the patcher already receives.
    workflow.addNode('human_feedback', async (state: AgentState) =>
      this.mergeHumanFeedback(state),
    );

    // Define edges
    workflow.addEdge(START, 'onboarding');
    workflow.addEdge('onboarding', 'planner');

    // Tool loop conditional edge for the planner:
    //   - If the LLM made tool calls → route to 'planner_tools'
    //   - If the LLM produced the final plan (no tool calls) → route to
    //     'patcher'
    // This mirrors the patcher ⇄ patcher_tools loop but operates on the
    // dedicated `plannerMessages` channel.
    //
    // Plan invariant: on the no-tool-calls path, PlannerAgent guarantees a
    // non-empty implementationPlan — it re-prompts empty/reasoning-only
    // responses (DeepSeek thinking mode can emit reasoning_content with an
    // empty content body) and throws rather than returning an empty plan,
    // failing the run cleanly through runPipeline's catch. The hard-cap
    // force-route below is a backstop for hallucinated tool_calls; if it
    // ever fires without a plan, the patcher throws its own clear error
    // instead of silently entering the validator retry loop.
    workflow.addConditionalEdges(
      'planner',
      (state: AgentState) => {
        const lastMessage =
          state.plannerMessages?.[state.plannerMessages.length - 1];
        // Hard cap: if the planner has been looping for too long, force-break
        // to patcher regardless of tool_calls. The planner's own soft limit
        // should have already stopped it, but this catches edge cases where
        // the LLM hallucinates tool_calls without tools bound.
        if (
          (state.plannerMessages?.length ?? 0) > HARD_CAP_PLANNER_MESSAGES
        ) {
          this.logger.warn(
            `Planner hard cap reached (${state.plannerMessages?.length} messages). ` +
              `Force-routing to patcher.`,
          );
          return 'patcher';
        }
        if (lastMessage && (lastMessage as any).tool_calls?.length > 0) {
          return 'planner_tools';
        }
        return 'patcher';
      },
      {
        planner_tools: 'planner_tools',
        patcher: 'patcher',
      },
    );

    // planner_tools executes the requested searches/reads, then loops
    // back to planner so the LLM can inspect the results and decide
    // whether to call more tools or write the final plan.
    workflow.addEdge('planner_tools', 'planner');

    // Tool loop conditional edge for the patcher:
    //   - If the generator LLM made tool calls → route to 'patcher_tools'
    //   - If the generator LLM produced a final summary (no tool calls) →
    //     route to 'validator'
    // This mirrors the research ⇄ tools loop but operates on the dedicated
    // `patchMessages` channel so the patcher's edit conversation never
    // pollutes the research/planning `messages` timeline.
    workflow.addConditionalEdges(
      'patcher',
      (state: AgentState) => {
        const lastMessage =
          state.patchMessages?.[state.patchMessages.length - 1];
        // Hard cap: if the patcher has been looping for too long, force-break
        // to validator regardless of tool_calls. The patcher's own soft limit
        // should have already stopped it, but this catches edge cases.
        if (
          (state.patchMessages?.length ?? 0) > HARD_CAP_PATCHER_MESSAGES
        ) {
          this.logger.warn(
            `Patcher hard cap reached (${state.patchMessages?.length} messages). ` +
              `Force-routing to validator.`,
          );
          return 'validator';
        }
        if (lastMessage && (lastMessage as any).tool_calls?.length > 0) {
          return 'patcher_tools';
        }
        return 'validator';
      },
      {
        patcher_tools: 'patcher_tools',
        validator: 'validator',
      },
    );

    // patcher_tools executes the requested reads/edits, then loops back to
    // patcher so the LLM can inspect the results (including gate-rejection
    // messages) and self-correct within the same attempt.
    workflow.addEdge('patcher_tools', 'patcher');

    // Conditional edges based on validation
    workflow.addConditionalEdges(
      'validator',
      (state: AgentState) => {
        if (state.isValid) {
          return 'git';
        }
        if ((state.validationAttempts || 0) < 3) {
          this.logger.warn(`Validation failed (Attempt ${state.validationAttempts}). Retrying patch generation...`);
          return 'human_feedback';
        }
        this.logger.error(`Validation failed 3 times. Aborting workflow.`);
        return END;
      },
      {
        git: 'git',
        human_feedback: 'human_feedback',
        [END]: END,
      },
    );

    // Retry path: validator -> human_feedback -> patcher
    workflow.addEdge('human_feedback', 'patcher');
    workflow.addEdge('git', END);

    this.graph = workflow.compile();
  }

  /**
   * Folds human feedback submitted through the MCP `provide_human_feedback`
   * tool into `validationFeedback`, so the patcher sees it alongside the
   * automated validation output on its next attempt.
   *
   * Feedback is consumed (deleted) so it is applied at most once per submission.
   */
  private async mergeHumanFeedback(
    state: AgentState,
  ): Promise<Partial<AgentState>> {
    const taskId = state.issuePayload?.taskId;
    if (!taskId) return {};

    let feedback: string | null = null;
    try {
      feedback = await this.humanFeedbackService.consume(taskId);
    } catch (e: any) {
      // Never block the retry loop on a feedback-store hiccup.
      this.logger.warn(`Could not read human feedback: ${e.message}`);
      return {};
    }

    if (!feedback) return {};

    this.logger.log(`Applying human feedback to task ${taskId}`);
    const existing = state.validationFeedback
      ? `${state.validationFeedback}\n\n`
      : '';

    return {
      validationFeedback: `${existing}### Human feedback (must be addressed)\n${feedback}`,
      // Reset the patcher's tool-loop conversation so the retry starts a
      // fresh attempt: the previous attempt's stale tool-call history
      // (including any half-applied edits or rejected gate messages) would
      // otherwise bleed into the new attempt and confuse the LLM.
      patchMessages: [],
    };
  }

  async runPipeline(issuePayload: any): Promise<AgentState> {
    this.logger.log('Starting multi-agent pipeline...');

    // Prime the BYOK (installation-scoped) LLM config BEFORE any agent node
    // runs — getModel() resolves installation configs synchronously from the
    // cache this populates. Without a primed config (or without the LlmConfig
    // service at all), agents fall back to the env-configured provider.
    if (this.llmService) {
      await this.llmService.primeForInstallation(
        issuePayload?.installation?.id ?? null,
      );
    }

    // Initial state
    const initialState = {
      messages: [],
      issuePayload,
    };

    // recursionLimit is raised from the default (25) to 100 to accommodate
    // the research ⇄ tools loop, which can legitimately iterate several times
    // as the LLM pivots between search terms before producing its summary.
    //
    // Wrapped in try/catch so that a thrown exception (GraphRecursionError,
    // patch-generation failure, or any unhandled error from an agent node)
    // still produces a FAILED audit log entry. Without this, the dashboard
    // shows zero runs for any job that crashed — the audit log was only
    // written on the success path below.
    let finalState: AgentState;
    try {
      finalState = await this.graph.invoke(initialState, {
        recursionLimit: 100,
      });
    } catch (err: any) {
      this.logger.error(
        `Pipeline threw before completing: ${err?.message ?? err}`,
        err?.stack,
      );

      // Clean up the patcher session even on failure so gate-tracking
      // state doesn't leak into the next run on the same worktree.
      const worktreePath = issuePayload?.worktreePath;
      if (worktreePath) {
        try {
          this.patchGenerator.clearSession(worktreePath);
        } catch {
          // Non-fatal — best-effort cleanup.
        }
      }

      // Persist a FAILED audit log so the dashboard can surface the run,
      // its failure reason, and timestamps. We synthesize a minimal
      // AgentState from the initial payload + the error message.
      const failedState: AgentState = {
        ...initialState,
        isValid: false,
        validationFeedback: err?.message ?? String(err),
      };
      try {
        await this.auditLogService.logPipelineOutcome(failedState);
      } catch (auditErr: any) {
        this.logger.error(
          `Failed to save FAILED audit log: ${auditErr?.message}`,
        );
      }

      // Re-throw so BullMQ can retry or move to the dead-letter queue.
      throw err;
    }
    this.logger.log('Pipeline finished.');

    // Clean up the patcher's per-worktree gate-tracking session so the
    // read-history gates don't leak across pipeline runs on the same
    // worktree (e.g. in tests or when re-running against the same repo).
    const worktreePath = issuePayload?.worktreePath;
    if (worktreePath) {
      this.patchGenerator.clearSession(worktreePath);
    }

    // Save execution audit log
    await this.auditLogService.logPipelineOutcome(finalState);

    return finalState;
  }
}

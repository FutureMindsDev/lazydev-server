/* eslint-disable */
/**
 * Dispatch-boundary tool-loop detection.
 *
 * Design based on the "Typed Tool-Loop Failure Detector" pattern from the
 * Agent Patterns Catalog and the bounded agentic loop pattern from aiarch.dev.
 *
 * Key principle: detection happens at the dispatch boundary (before the tool
 * runs), not after the fact. When a repeat is detected, the tool is NOT
 * executed — instead a refusal is returned as a ToolMessage result. The model
 * sees the refusal in its next turn and must adjust. This is mechanically
 * enforced: the model cannot skip it the way it can ignore a prompt-level rule.
 *
 * This module is a pure utility — no state of its own. The caller owns the
 * rolling window of tool calls and passes it in.
 */

import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';

/**
 * A single entry in the rolling window of tool calls.
 */
export interface ToolCallEntry {
  toolName: string;
  argsHash: string;
  timestamp: number;
}

/**
 * A typed refusal returned when a tool-loop failure is detected.
 * Modeled after the Typed Tool-Loop Failure Detector pattern.
 */
export interface ToolLoopRefusal {
  mode: 'generic_repeat' | 'global_breaker';
  toolName: string;
  message: string;
}

/**
 * Configuration for the dispatch-boundary check.
 * Per-tool overrides allow known-bursty tools to have different caps.
 */
export interface DispatchCheckerConfig {
  /** Max times the same (tool, args) pair can be called before refusal.
   * Default 1 — a second identical call is a repeat. */
  maxRepeatPerTool?: number;
  /** Global cap on total tool calls across the loop. */
  maxTotalCalls?: number;
}

const DEFAULT_MAX_REPEAT = 1;

/**
 * Creates a stable hash of a tool call's arguments for deduplication.
 * Two calls with the same tool name and same args produce the same hash.
 */
export function argsHash(args: Record<string, unknown>): string {
  return Object.keys(args)
    .sort()
    .map((k) => `${k}:${JSON.stringify(args[k])}`)
    .join('|');
}

/**
 * Full signature: tool name + args hash. Used as a unique key.
 */
export function toolCallKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}(${argsHash(args)})`;
}

/**
 * Extracts tool calls from the last AIMessage in a message list.
 * Returns the calls in the order they appear.
 */
export function extractToolCallsFromLastAIMessage(
  messages: BaseMessage[],
): { id: string; name: string; args: Record<string, unknown> }[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg instanceof AIMessage) {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        return msg.tool_calls.map((tc) => ({
          id: tc.id ?? '',
          name: tc.name,
          args: tc.args as Record<string, unknown>,
        }));
      }
      return [];
    }
  }
  return [];
}

/**
 * Builds the rolling window of tool calls from the message history.
 * Scans all AIMessages for tool_calls and records each one.
 */
export function buildToolCallWindow(messages: BaseMessage[]): ToolCallEntry[] {
  const entries: ToolCallEntry[] = [];
  for (const msg of messages) {
    if (msg instanceof AIMessage && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        entries.push({
          toolName: tc.name,
          argsHash: argsHash(tc.args as Record<string, unknown>),
          timestamp: Date.now(),
        });
      }
    }
  }
  return entries;
}

/**
 * Checks a single tool call against the rolling window.
 * Returns a refusal if the call is a repeat or the global cap is hit,
 * or null if the call should be dispatched normally.
 */
export function checkDispatch(
  toolName: string,
  args: Record<string, unknown>,
  window: ToolCallEntry[],
  config: DispatchCheckerConfig = {},
): ToolLoopRefusal | null {
  const maxRepeat = config.maxRepeatPerTool ?? DEFAULT_MAX_REPEAT;

  // Check for generic repeat: same (tool, args) pair called too many times.
  // maxRepeatPerTool=1 means the first call is allowed, a second identical
  // call is refused (priorCount >= maxRepeat).
  const priorCount = window.filter(
    (e) => e.toolName === toolName && e.argsHash === argsHash(args),
  ).length;

  if (priorCount >= maxRepeat) {
    return {
      mode: 'generic_repeat',
      toolName,
      message:
        `You already called ${toolName} with these exact arguments ` +
        `(${priorCount} time${priorCount === 1 ? '' : 's'}). The result is in ` +
        `your conversation history — re-read it instead of calling the tool again. ` +
        `If you need different information, use different arguments or a different tool.`,
    };
  }

  // Check global breaker: total tool calls exceeded.
  if (config.maxTotalCalls && window.length >= config.maxTotalCalls) {
    return {
      mode: 'global_breaker',
      toolName,
      message:
        `Total tool call budget exhausted (${window.length}/${config.maxTotalCalls}). ` +
        `Stop calling tools and produce your final response based on what you have learned so far.`,
    };
  }

  return null;
}

/**
 * Creates a ToolMessage containing a refusal, to be returned to the LLM
 * instead of the actual tool result. The model sees this as the tool's output.
 */
export function createRefusalToolMessage(
  toolCallId: string,
  toolName: string,
  refusal: ToolLoopRefusal,
): ToolMessage {
  return new ToolMessage({
    tool_call_id: toolCallId,
    content: refusal.message,
    name: toolName,
  });
}

/**
 * Processes a batch of tool calls from the last AIMessage: checks each one
 * against the rolling window of prior calls, and returns either ToolMessages
 * with refusals (for rejected calls) or marks them as allowed (for calls
 * that should be dispatched normally).
 *
 * The window is built from all messages EXCEPT the last AIMessage — the last
 * AIMessage's calls are the ones being checked, not prior calls.
 */
export function checkBatchDispatch(
  messages: BaseMessage[],
  config: DispatchCheckerConfig = {},
): {
  refusals: Map<string, ToolMessage>;
  allowedCallIds: Set<string>;
} {
  const latestCalls = extractToolCallsFromLastAIMessage(messages);
  if (latestCalls.length === 0) {
    return { refusals: new Map(), allowedCallIds: new Set() };
  }

  // Build the window from all messages except the last AIMessage.
  // Find the index of the last AIMessage.
  let lastAIMsgIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof AIMessage) {
      lastAIMsgIdx = i;
      break;
    }
  }
  const priorMessages =
    lastAIMsgIdx >= 0 ? messages.slice(0, lastAIMsgIdx) : messages;
  const priorWindow = buildToolCallWindow(priorMessages);

  const refusals = new Map<string, ToolMessage>();
  const allowedCallIds = new Set<string>();

  for (const call of latestCalls) {
    const refusal = checkDispatch(call.name, call.args, priorWindow, config);
    if (refusal) {
      refusals.set(
        call.id,
        createRefusalToolMessage(call.id, call.name, refusal),
      );
    } else {
      allowedCallIds.add(call.id);
    }
  }

  return { refusals, allowedCallIds };
}

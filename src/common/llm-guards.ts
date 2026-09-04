/* eslint-disable */
import { AIMessage, HumanMessage } from '@langchain/core/messages';

/**
 * Provider-agnostic guards for LLM input/output at the agent boundary.
 *
 * Two failure modes observed in production that generic OpenAI-compat
 * clients neither prevent nor clean up:
 *
 * 1. DeepSeek thinking mode leaking raw DSML tool-calling markup into
 *    `response.content` (e.g. when the model wants to call tools but none
 *    are bound, or the tool-call parser misses a START token at long
 *    context — see vllm#48931). Unstripped, this markup ends up in the
 *    implementation plan and propagates into later prompts.
 *
 * 2. Gemini rejecting a request whose message list ends with a text-only
 *    assistant message: 400 "Requests ending with a model turn are not
 *    supported" — enforced by both the native generateContent API and the
 *    OpenAI-compat endpoint (see litellm#38537, langchainjs#11444).
 */

/** U+FF5C FULLWIDTH VERTICAL LINE — the delimiter in DeepSeek DSML tags. */
const FULLWIDTH_BAR = '｜';

/**
 * Strips leaked DeepSeek DSML tool-calling markup from model output text.
 *
 * Handles complete `<｜DSML｜…>…</｜DSML｜…>` blocks (single- or double-bar
 * delimiters, as seen across DeepSeek V3.2/V4 tokenizer generations) plus
 * any stray leftover tags starting with a fullwidth bar. Returns the input
 * unchanged when no fullwidth-bar markup is present, so it is a cheap
 * no-op for every other provider.
 */
export function stripDsmlTokens(text: string): string {
  if (!text || !text.includes(FULLWIDTH_BAR)) return text;
  let out = text;
  // Complete DSML blocks, non-greedy so multiple blocks are each removed.
  out = out.replace(
    /<｜+DSML｜+[\s\S]*?<\/｜+DSML｜+[^>]*>/g,
    '',
  );
  // Stray opening/closing tags left behind (unbalanced blocks, parser
  // partial-emits), e.g. <｜DSML｜invoke …> or </｜｜DSML｜｜>.
  out = out.replace(/<\/?｜+[^>]*>/g, '');
  return out;
}

/**
 * Opening delimiter of the inline reasoning blocks some providers return
 * inside `response.content`. Built by concatenation so the raw tag never
 * appears as a bare literal in this source file.
 */
const THINK_OPEN = '<' + 'think' + '>';
const THINK_CLOSE = '</' + 'think' + '>';

/**
 * Strips inline reasoning blocks that some providers return inside
 * `response.content` instead of a separate reasoning field — most notably
 * MiniMax M2.x interleaved thinking, and DeepSeek-R1/Qwen3-style models on
 * hosts that don't split the reasoning out of content.
 *
 * The full assistant message (including the reasoning markup) must still be
 * sent back for multi-turn tool loops — LangChain preserves content
 * verbatim, so that round-trip is unaffected; this guard is for the
 * *downstream text* (implementation plans, final summaries) so reasoning
 * doesn't leak into prompts and PR descriptions.
 *
 * Returns the input unchanged when no reasoning markup is present, so it is
 * a cheap no-op for every other provider.
 */
export function stripThinkTokens(text: string): string {
  if (!text || !text.includes(THINK_OPEN)) return text;
  let out = text;
  // Complete blocks, non-greedy so multiple blocks are each removed.
  out = out.replace(new RegExp(THINK_OPEN + '[\\s\\S]*?' + THINK_CLOSE, 'g'), '');
  // Unterminated block — opening tag with no closing tag, e.g. a
  // hard-truncated response. Strip from the stray opening tag to EOL.
  out = out.replace(new RegExp(THINK_OPEN + '[\\s\\S]*$'), '');
  // Stray closing tags left behind (parser partial-emits).
  out = out.replace(new RegExp('<' + '\\/?' + 'think' + '>', 'g'), '');
  return out;
}

/**
 * Ensures a message list is safe to send to Gemini: if it ends with a
 * text-only assistant message (no tool calls), appends a synthetic user
 * turn so the converted `contents` end with a user role. Gemini rejects
 * model-turn-ending requests with a 400; other providers accept both
 * shapes, and the appended turn is a standard "continue" nudge.
 *
 * Tool-call tails and ToolMessage tails are left alone — tool responses
 * map to user-role turns already.
 */
export function ensureEndsWithUserTurn(messages: unknown[]): unknown[] {
  const last = messages[messages.length - 1];
  const isAIMessage = AIMessage.isInstance
    ? AIMessage.isInstance(last)
    : last instanceof AIMessage;
  if (isAIMessage && !(last as AIMessage).tool_calls?.length) {
    return [...messages, new HumanMessage('Continue.')];
  }
  return messages;
}

/**
 * Copyright (c) 2026 FutureMindsDev. All rights reserved.
 *
 * LazyDev™ is a trademark of FutureMindsDev.
 * Organization : https://github.com/FutureMindsDev
 *
 * Authors:
 *   Arkar Chan Myae  <https://github.com/arkar-chanmyae>
 *   Khin Me Me Latt  <https://github.com/KhinMeMeLatt>
 *
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 */

import { AIMessage } from '@langchain/core/messages';

/**
 * Clone an AIMessage, replacing only its tool_calls, while preserving every
 * piece of provider metadata: additional_kwargs (DeepSeek reasoning_content,
 * Gemini/OpenAI raw tool_calls), response_metadata, id, name, invalid tool
 * calls, and usage metadata.
 *
 * Reconstructing with `new AIMessage({ content, tool_calls })` silently drops
 * those fields, which breaks provider round-trips (e.g. DeepSeek thinking mode
 * requires reasoning_content on assistant turns; Gemini thought_signature
 * lives on the raw tool calls). Use this at every filtered/replayed-message
 * reconstruction site instead.
 */
export function cloneAIMessageWithToolCalls(
  message: AIMessage,
  toolCalls: AIMessage['tool_calls'],
): AIMessage {
  return new AIMessage({
    content: message.content,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    tool_calls: toolCalls,
    invalid_tool_calls: message.invalid_tool_calls,
    usage_metadata: message.usage_metadata,
    id: message.id,
    name: message.name,
  });
}

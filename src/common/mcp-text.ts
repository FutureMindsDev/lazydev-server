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

/** MCP result envelope shape shared by SerenaMcpService calls. */
interface McpToolResult {
  isError?: boolean;
  content?: { text?: string }[];
}

/**
 * Extracts the plain-text payload from an MCP tool result, e.g. Serena's
 * `read_memory` response. Returns `null` for an error result or anything
 * unrecognized, so callers can treat "no usable content" uniformly instead of
 * each re-implementing this same content-array unwrapping.
 */
export function extractMcpText(result: unknown): string | null {
  if (!result) return null;
  if (typeof result === 'string') return result;

  const typed = result as McpToolResult;
  if (typed.isError) return null;
  if (Array.isArray(typed.content)) {
    return typed.content.map((c) => c?.text ?? '').join('');
  }
  return null;
}

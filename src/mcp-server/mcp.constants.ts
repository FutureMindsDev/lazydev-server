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

/** HTTP path the Streamable HTTP transport is served on. */
export const MCP_ENDPOINT = '/mcp';

/**
 * Marker embedded in the body of issues created by the `implement_new_feature`
 * tool. The webhook handler uses it to skip `issues.opened` events for issues
 * the MCP server has already queued work for.
 */
export const MCP_ISSUE_MARKER = '<!-- lazydev:mcp -->';

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

/**
 * What kind of work a pipeline run represents.
 *
 * Issues arriving from GitHub webhooks are always `fix`. `feature` is set by the
 * MCP `implement_new_feature` tool, which asks for net-new code rather than a
 * repair — so the branch prefix, commit type and PR title must differ (the repo
 * enforces conventional commits, where a feature is `feat:` and not `fix:`).
 *
 * Lives in its own module because it is shared by the git, ingestion,
 * orchestration and mcp-server layers.
 */
export type WorkKind = 'fix' | 'feature';

/** Conventional-commit type for a work kind. */
export function commitTypeFor(kind: WorkKind = 'fix'): string {
  return kind === 'feature' ? 'feat' : 'fix';
}

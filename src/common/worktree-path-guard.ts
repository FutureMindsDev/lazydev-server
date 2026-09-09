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

import * as path from 'path';

/**
 * Files/directories the LLM must never create, modify, delete or rename, per
 * the "Restricted File Scope" guardrail in
 * docs/sprint-plan/additional_features.md §2. Matched against the
 * project-relative path (POSIX-style, no leading "./").
 */
const RESTRICTED_PATH_PATTERNS: RegExp[] = [
  /^\.github\//i, // CI workflows — must not be able to grant itself more CI power
  /^\.git\//i, // repo internals
  /^\.serena\//i, // Serena's own project config
  /^\.env(\..+)?$/i, // secrets
  /^\.lazydev\//i, // LazyDev's own committed memory snapshot (GitAgent-managed)
];

function normalize(relativePath: string): string {
  return relativePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
}

/**
 * Throws if `relativePath` names a file the agent is not allowed to touch, or
 * resolves outside of `worktreePath` (path traversal). On success, returns the
 * absolute path — callers that fall back to raw `fs` calls should write there.
 */
export function assertSafeWorktreePath(
  worktreePath: string,
  relativePath: string,
): string {
  const normalized = normalize(relativePath);

  if (path.isAbsolute(normalized)) {
    throw new Error(
      `Refusing to write to an absolute path: "${relativePath}". Paths must be relative to the repository root.`,
    );
  }

  if (RESTRICTED_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new Error(
      `Refusing to modify restricted path "${relativePath}" (CI config, git internals, Serena config, and secrets are off-limits).`,
    );
  }

  const root = path.resolve(worktreePath) + path.sep;
  const resolved = path.resolve(worktreePath, normalized);
  if (!resolved.startsWith(root)) {
    throw new Error(
      `Refusing to write outside the worktree: "${relativePath}" resolves to ${resolved}.`,
    );
  }

  return resolved;
}

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Full repo name, e.g. "owner/repo". */
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export interface ParsedRepo {
  owner: string;
  repo: string;
}

/** Validates and splits an "owner/repo" string. */
export function parseRepository(repository: string): ParsedRepo {
  if (!REPO_PATTERN.test(repository)) {
    throw new Error(
      `Invalid repository "${repository}". Expected the form "owner/repo".`,
    );
  }
  const [owner, repo] = repository.split('/');
  return { owner, repo };
}

/**
 * Neutralizes prompt-injection attempts in free text that will later be fed to
 * an LLM (see additional_features.md §2 "LLM Guardrails").
 *
 * This is defence in depth, not a complete solution: the agent additionally
 * runs inside an ephemeral worktree with a restricted file scope.
 */
export function sanitizeUserText(text: string, maxLength = 8000): string {
  const injectionPatterns: RegExp[] = [
    // Role / turn markers that could break out of the system-prompt boundary.
    /^\s*(system|assistant|user|developer)\s*:/gim,
    /<\|[^>]*\|>/g,
    /\[\/?(INST|SYS)\]/gi,
    // Classic jailbreak phrasings. The optional article/qualifier group keeps
    // variants like "disregard the above instructions" from slipping through.
    /(ignore|disregard|override)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|preceding|earlier|foregoing)\s+(\w+\s+)?(instructions?|prompts?|rules?|directions?)/gi,
    /you\s+are\s+now\s+(a|an)\s+/gi,
    /forget\s+(everything|all)\s+(you|above)/gi,
  ];

  let sanitized = text.slice(0, maxLength);
  for (const pattern of injectionPatterns) {
    sanitized = sanitized.replace(pattern, '[redacted]');
  }
  return sanitized.trim();
}

/** Wraps text in the MCP tool result envelope. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Wraps an error in the MCP tool result envelope (tools never throw raw). */
export function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

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

/* eslint-disable */
import { Injectable, Logger } from '@nestjs/common';
import { AgentState } from '../graph.state';
import { LlmService } from '../llm.service';
import { SearchService } from '../../intelligence/search.service';
import { VectorDbService } from '../../intelligence/vector-db.service';
import { EmbeddingService } from '../../intelligence/embedding.service';
import { SerenaMcpService } from '../../intelligence/serena-mcp.service';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import * as fs from 'fs/promises';
import * as path from 'path';
import { extractMcpText } from '../../common/mcp-text';
import { formatLessonsEntries } from '../../common/lessons-learned-formatter';

/**
 * Extensions RAG may surface that never carry LSP-analyzable symbols (data,
 * docs, config). Calling `get_symbols_overview` on these always throws
 * (`Cannot extract symbols from file ...`); the get_file_symbols tool skips
 * the round trip and returns a helpful message instead of logging an MCP
 * error for every single one.
 */
const NON_SYMBOLIC_FILE_EXTENSIONS = [
  '.md',
  '.mdx',
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  '.txt',
  '.csv',
  '.lock',
];

@Injectable()
export class ResearchAgent {
  private readonly logger = new Logger(ResearchAgent.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly searchService: SearchService,
    private readonly vectorDbService: VectorDbService,
    private readonly embeddingService: EmbeddingService,
    private readonly serenaMcp: SerenaMcpService,
  ) { }

  // ─────────────────────────────────────────────────────────────────────────
  // ReAct tools — exposed to the LLM via bindTools so it can iteratively
  // search, read files, get symbols, and read memories on demand.
  //
  // `repoPath` is the persistent repo-cache clone (survives across jobs);
  // `worktreePath` is the ephemeral per-job checkout (deleted after the job).
  // Memory reads use repoPath; file/symbol reads use worktreePath.
  // ─────────────────────────────────────────────────────────────────────────
  getTools(worktreePath: string, repoPath?: string) {
    const memoryProjectPath = repoPath || worktreePath;

    return [
      new DynamicStructuredTool({
        name: 'search_codebase',
        description:
          'Search the codebase using vector similarity (RAG). Use this to find relevant files based on a concept or feature description. Falls back to ripgrep if vector search returns nothing.',
        schema: z.object({
          query: z
            .string()
            .describe(
              'The search query (e.g. "navbar", "authentication logic")',
            ),
          repoFullName: z
            .string()
            .describe(
              'The full repository name (e.g. "FutureMindsDev/lazydev-server")',
            ),
        }),
        func: async ({ query, repoFullName }: { query: string; repoFullName: string }) => {
          this.logger.log(`Searching for "${query}" in ${repoFullName}...`);

          const keywords = query
            .replace(/[^a-zA-Z0-9 ]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length > 2);

          if (keywords.length === 0) {
            return 'Query too short or invalid.';
          }

          const safeKeyword = keywords.slice(0, 3).join(' ');
          let allResults: any[] = [];

          try {
            const collectionName = repoFullName.replace(/[^a-zA-Z0-9_]/g, '_');

            // Chunk keywords into groups of 3 and run RAG for all chunks
            for (let i = 0; i < keywords.length; i += 3) {
              const chunk = keywords.slice(i, i + 3).join(' ');
              try {
                const vector =
                  await this.embeddingService.getEmbedding(chunk);
                const chunkResults =
                  await this.vectorDbService.searchSimilar(
                    collectionName,
                    vector,
                    2,
                  );
                if (chunkResults && chunkResults.length > 0) {
                  allResults.push(...chunkResults);
                }
              } catch (e: any) {
                this.logger.warn(
                  `Vector search failed for chunk "${chunk}": ${e.message}`,
                );
              }
            }

            // Deduplicate by payload.filePath or point id
            const uniqueMap = new Map();
            for (const res of allResults) {
              const key = res.payload?.filePath || res.id;
              if (!uniqueMap.has(key)) {
                uniqueMap.set(key, res);
              }
            }
            const finalResults = Array.from(uniqueMap.values());

            if (finalResults.length === 0) {
              this.logger.warn(
                `Vector search returned empty. Falling back to ripgrep with safeKeyword: "${safeKeyword}"`,
              );
              const fallback = await this.searchService.search(
                safeKeyword,
                worktreePath,
              );
              return JSON.stringify(fallback, null, 2);
            }
            return JSON.stringify(finalResults, null, 2);
          } catch (e: any) {
            this.logger.warn(
              `Vector search failed entirely: ${e.message}. Falling back to ripgrep with safeKeyword: "${safeKeyword}"`,
            );
            const fallback = await this.searchService.search(
              safeKeyword,
              worktreePath,
            );
            return JSON.stringify(fallback, null, 2);
          }
        },
      }),

      new DynamicStructuredTool({
        name: 'read_serena_memory',
        description:
          'Read a core memory from Serena MCP (e.g., "global_repo_structure" or "historical_issues_and_lessons") to understand architectural conventions. Memories are stored against the persistent repo-cache clone, not the ephemeral worktree.',
        schema: z.object({
          memoryName: z
            .string()
            .describe('The name of the memory to fetch.'),
        }),
        func: async ({ memoryName }: { memoryName: string }) => {
          this.logger.log(`Fetching memory ${memoryName}...`);
          try {
            // Use repoPath (persistent clone) — memories physically live
            // under <active project>/.serena/memories/ and the worktree is
            // deleted at the end of this job, so reading from worktreePath
            // would find nothing after the first run.
            await this.serenaMcp.activateProject(memoryProjectPath);
            const result = await this.serenaMcp.readMemory(memoryName);
            const text = extractMcpText(result);
            return text || JSON.stringify(result, null, 2);
          } catch (e: any) {
            return `Error fetching memory: ${e.message}`;
          }
        },
      }),

      new DynamicStructuredTool({
        name: 'get_file_symbols',
        description:
          'Get an overview of all classes, functions, and interfaces in a specific file. Use this after finding candidate files with search_codebase. Skips non-code files (md, json, yml, etc.) since they have no LSP symbols.',
        schema: z.object({
          filePath: z
            .string()
            .describe(
              'The absolute or relative path to the file (relative to repo root).',
            ),
        }),
        func: async ({ filePath }: { filePath: string }) => {
          // Non-symbolic files — Serena's language servers can't extract
          // symbols from these and always throw. Skip the round trip.
          if (
            NON_SYMBOLIC_FILE_EXTENSIONS.some((ext) => filePath.endsWith(ext))
          ) {
            return `${filePath} is a non-code file (matched a non-symbolic extension). Use read_code_file to read its contents directly.`;
          }

          this.logger.log(`Fetching symbols for ${filePath}...`);
          try {
            await this.serenaMcp.activateProject(worktreePath);
            const result = await this.serenaMcp.getSymbolsOverview(filePath);
            return JSON.stringify(result, null, 2);
          } catch (e: any) {
            return `Error fetching symbols: ${e.message}`;
          }
        },
      }),

      new DynamicStructuredTool({
        name: 'read_code_file',
        description:
          'Read the complete contents of a specific file. Use this AFTER finding the correct file with search_codebase to inspect the exact code.',
        schema: z.object({
          filePath: z
            .string()
            .describe(
              'The absolute or relative path to the file (relative to repo root).',
            ),
        }),
        func: async ({ filePath }: { filePath: string }) => {
          this.logger.log(`Reading file content for ${filePath}...`);
          try {
            const fullPath = path.isAbsolute(filePath)
              ? filePath
              : path.join(worktreePath, filePath);
            const content = await fs.readFile(fullPath, 'utf-8');
            return content;
          } catch (e: any) {
            return `Error reading file: ${e.message}`;
          }
        },
      }),

      new DynamicStructuredTool({
        name: 'list_dir',
        description:
          'List the contents of a directory in the repository to explore the file structure. Use this when search_codebase does not find the exact file you are looking for.',
        schema: z.object({
          dirPath: z
            .string()
            .describe(
              'The relative path to the directory (e.g., "src/components" or "." for root).',
            ),
        }),
        func: async ({ dirPath }: { dirPath: string }) => {
          this.logger.log(`Listing directory ${dirPath}...`);
          try {
            const fullPath = path.join(worktreePath, dirPath);
            const files = await fs.readdir(fullPath, { withFileTypes: true });
            const result = files.map(
              (f) => `${f.isDirectory() ? '[DIR]' : '[FILE]'} ${f.name}`,
            );
            return JSON.stringify(result, null, 2);
          } catch (e: any) {
            return `Error listing directory: ${e.message}`;
          }
        },
      }),
    ];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // invoke — the hybrid approach:
  //
  //   1. PROACTIVE MEMORY INJECTION (from our branch):
  //      Read ALL Serena memories first and embed them in the system prompt
  //      so the LLM always sees conventions and past lessons — it never has
  //      to "remember" to call read_serena_memory.
  //
  //   2. ReAct TOOL LOOP (from develop):
  //      The LLM gets tools (search_codebase, get_file_symbols, read_code_file,
  //      list_dir, read_serena_memory) and iteratively decides which files to
  //      investigate. It can pivot when initial results are wrong.
  //
  // The orchestration service handles the tool loop via a ToolNode + conditional
  // edges (research ⇄ tools → planner). This invoke() runs once per loop visit:
  // it returns an AIMessage with tool_calls (→ tools node) or without (→ planner).
  // ─────────────────────────────────────────────────────────────────────────
  async invoke(state: AgentState): Promise<Partial<AgentState>> {
    this.logger.log('Running Research node (hybrid: memories + ReAct)...');

    const { issuePayload, messages } = state;

    if (!issuePayload || !issuePayload.worktreePath) {
      this.logger.warn('No issue payload or worktree path found in state.');
      return {};
    }

    const worktreePath = issuePayload.worktreePath;
    const repoPath = issuePayload.repoPath;
    const tools = this.getTools(worktreePath, repoPath);
    const modelWithTools = (this.llmService.getModel('research') as any).bindTools(tools);

    let currentMessages = [...messages];
    let injectedMessages: any[] = [];

    // Check if we need to add the initial prompt (first visit to research node).
    // We look for our own system prompt marker, not just any SystemMessage —
    // the issue analyzer also emits a SystemMessage, which would falsely
    // trigger this check and skip memory injection + ReAct instructions.
    const hasResearchSystemPrompt = currentMessages.some(
      (m) =>
        m instanceof SystemMessage &&
        typeof m.content === 'string' &&
        m.content.includes('expert autonomous software researcher'),
    );

    if (!hasResearchSystemPrompt) {
      // ── Step 1: Proactive memory injection ──────────────────────────────
      // Read ALL memories from the persistent repo-cache clone so the LLM
      // always has conventions and past lessons in context — it never has
      // to "remember" to call read_serena_memory. The on-demand tool is
      // still available for re-reading a specific memory mid-investigation.
      let memoryContext = '';
      const memoryProjectPath = repoPath || worktreePath;
      try {
        this.logger.log(
          `Proactively fetching core memories for ${memoryProjectPath}...`,
        );
        await this.serenaMcp.activateProject(memoryProjectPath);

        const repoStructureMemory =
          await this.serenaMcp.readMemory('global_repo_structure');
        const repoStructureText = extractMcpText(repoStructureMemory);
        if (repoStructureText) {
          memoryContext += `\n--- Global Project Conventions & Memories ---\n${repoStructureText}\n---------------------------------------------\n\n`;
        }

        if (process.env.ENABLE_SERENA_ISSUE_HISTORY === 'true') {
          const lessonsMemory =
            await this.serenaMcp.readMemory(
              'historical_issues_and_lessons',
            );
          // Capped to keep the prompt from growing unboundedly.
          const lessonsText = formatLessonsEntries(lessonsMemory, 5);
          if (lessonsText) {
            memoryContext += `\n--- Lessons From Past Fixes ---\n${lessonsText}\n-------------------------------\n\n`;
          }
        }
      } catch (e) {
        this.logger.warn(
          `Could not proactively fetch memories for ${memoryProjectPath}: ${(e as Error).message}`,
        );
      }

      // ── Step 2: Build the system prompt with memories + ReAct instructions ─
      const title =
        issuePayload.issue?.title || issuePayload.title || 'Unknown Issue';
      const body = issuePayload.issue?.body || issuePayload.body || '';
      const repoFullName =
        issuePayload.repository?.full_name || 'unknown_repo';

      // Use triageContext if the analyzer produced it, otherwise use the
      // analyzer's message output as the seed for search terms.
      const triageStr = state.triageContext
        ? JSON.stringify(state.triageContext, null, 2)
        : 'None (use the issue title/body to derive search terms)';

      const systemPrompt = new SystemMessage(
        `You are an expert autonomous software researcher. Your goal is to gather code context for an issue and then STOP.

CRITICAL INSTRUCTIONS:
1. You have been given Serena memories (project conventions and past lessons) below — use them to guide your investigation. However, memories may be outdated or incomplete. You MUST verify by exploring the actual codebase.
2. You have been given a Triage Context that suggests search terms and likely directories. Use them as a starting point.
3. You MUST call at least list_dir on the root directory (".") and at least one search_codebase call before producing your summary. Memories alone are NOT sufficient — the Planner needs to know the actual file structure and the exact contents of files that will be modified.
4. Use search_codebase to find files relevant to the issue. Pass repoFullName: "${repoFullName}".
5. Use get_file_symbols to inspect the structure of candidate files, and read_code_file to read their exact contents. You MUST read_code_file on every file that will be modified or created adjacent to, so the Planner has exact line-level context.
6. Use list_dir to explore the file structure when search_codebase does not find the exact file.
7. If initial search results seem wrong, PIVOT — try different search terms. You are not limited to one search.
8. You can call read_serena_memory to re-read a specific memory if you need to double-check a convention.
9. DO NOT write the implementation plan yourself. Just gather the context.
10. Once you have read the relevant files and are confident you have gathered enough code context for the Planner Agent to do its job, output a single message summarizing your findings and STOP calling tools.
11. Your final message must be a comprehensive summary of the files you investigated and the key findings. This will be passed to the Planner Agent.

${memoryContext ? `SERENA MEMORIES (already injected — no need to re-read unless you need to double-check):\n${memoryContext}` : '(No Serena memories were available for this repo.)'}`,
      );

      const userPrompt = new HumanMessage(
        `Issue Title: ${title}\nIssue Body: ${body}\n\nTriage Strategy:\n${triageStr}`,
      );
      injectedMessages = [systemPrompt, userPrompt];
      // NOTE: the user prompt is appended AFTER the existing messages (which
      // end with the IssueAnalyzer's AIMessage) so the request ends with a
      // user turn. Gemini's OpenAI-compatible endpoint rejects requests that
      // end with a model/assistant turn with a 400 "Requests ending with a
      // model turn are not supported" — DeepSeek and OpenAI tolerate this,
      // but Gemini does not.
      currentMessages = [systemPrompt, ...currentMessages, userPrompt];
    }

    // ── Step 3: Invoke the LLM with tools ──────────────────────────────────
    const response = (await modelWithTools.invoke(currentMessages)) as AIMessage;

    this.logger.log(
      `LLM responded with ${response.tool_calls?.length || 0} tool calls.`,
    );

    // If no tool calls, it's the final research summary → set researchContext
    // for the Planner Agent. The tool loop (research ⇄ tools) is handled by
    // the orchestration service's conditional edges.
    let patcherState: Partial<AgentState> = {};
    if (!response.tool_calls || response.tool_calls.length === 0) {
      patcherState.researchContext = response.content as string;
    }

    return {
      ...patcherState,
      messages: [...injectedMessages, response],
    };
  }
}

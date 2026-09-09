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
import {
  HumanMessage,
  SystemMessage,
  AIMessage,
} from '@langchain/core/messages';
import * as fs from 'fs/promises';
import * as path from 'path';
import { extractMcpText } from '../../common/mcp-text';
import { formatLessonsEntries } from '../../common/lessons-learned-formatter';
import {
  stripDsmlTokens,
  stripThinkTokens,
  ensureEndsWithUserTurn,
} from '../../common/llm-guards';

/**
 * Extensions that never carry LSP-analyzable symbols (data, docs, config).
 * Calling get_symbols_overview on these always throws; the get_file_symbols
 * tool skips the round trip and returns a helpful message instead.
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

/**
 * Hard safety-net cap on planner messages — a pure backstop.
 *
 * The primary stop condition is the model's own signal (no tool_calls = done),
 * same as Claude Code and OpenAI Codex. The dispatch-boundary repeat detection
 * in the orchestration service's planner_tools node catches spinning loops by
 * refusing duplicate tool calls. This hard cap only fires if the LLM keeps
 * making unique tool calls without converging, which is rare.
 *
 * 50 messages ≈ 17 iterations. Following the bounded agentic loop pattern:
 * the model's end_turn is the primary exit, dispatch refusals are the
 * secondary exit, and this is the tertiary backstop.
 */
const MAX_PLANNER_TOOL_MESSAGES = 50;

/**
 * Bounded re-prompt budget when a "final" planner response carries no plan
 * text.
 *
 * Production failure this guards against (DeepSeek thinking mode): after the
 * hard-cap backstop unbinds tools, the model can return a response whose
 * entire output is `reasoning_content` with an EMPTY `content` body. The old
 * code accepted that as "the plan", so `implementationPlan` ended up falsy —
 * the patcher warned "No implementation plan found", the validator's retry
 * edge never saw its attempt counter move, and the graph looped until
 * GraphRecursionError. Instead: re-prompt with an explicit "write the plan
 * now" user turn, and if the budget is exhausted, throw a clear error so
 * the job fails fast with an actionable message.
 */
const MAX_PLAN_REPROMPTS = 2;

/** The user-turn nudge appended when a response carries no plan text. */
const PLAN_REPROMPT_TEXT =
  'Your previous response contained no implementation plan text — the response body was empty ' +
  '(all output was internal reasoning). Write the complete step-by-step implementation plan now, ' +
  'as plain text in your response body. Do not call any tools.';

/**
 * Extracts the text from an AIMessage content body, which is a plain string
 * for text responses but an array of content blocks for multimodal shapes.
 */
function extractResponseText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : (part as { text?: string })?.text ?? '',
      )
      .join('');
  }
  return '';
}

/**
 * Merged planner agent — replaces the former IssueAnalyzerAgent +
 * ResearchAgent + PlanningAgent trio.
 *
 * The old three-agent pipeline had a lossy prose handoff: ResearchAgent
 * explored the codebase with tools, then wrote a free-text summary
 * (`researchContext`); PlanningAgent read that summary and wrote an
 * implementation plan. Symbol names and file contents were summarized
 * twice by two different LLM calls, and the plan was built on the
 * research agent's prose — not on the actual file contents the research
 * agent had read. This caused the original bug: the plan said `Home`
 * when the file actually had `HomePage`, because the research agent's
 * summary used the wrong name and the planning agent had no way to
 * verify.
 *
 * This agent does both jobs in one tool loop: it explores the codebase
 * with read-only tools (search, read_file, get_symbols_overview,
 * find_symbol, list_dir, read_serena_memory) and writes the
 * implementation plan directly — seeing actual file contents and symbol
 * names, not a summary. The plan's symbol names are therefore
 * first-hand, not second-hand.
 *
 * The orchestration graph handles the tool loop via a `planner_tools`
 * node + conditional edges (planner ⇄ planner_tools → patcher), mirroring
 * the patcher's own tool loop. This invoke() runs once per loop visit.
 */
@Injectable()
export class PlannerAgent {
  private readonly logger = new Logger(PlannerAgent.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly searchService: SearchService,
    private readonly vectorDbService: VectorDbService,
    private readonly embeddingService: EmbeddingService,
    private readonly serenaMcp: SerenaMcpService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Read-only tools — exposed to the LLM via bindTools so it can iteratively
  // search, read files, get symbols, and read memories on demand.
  //
  // `repoPath` is the persistent repo-cache clone (survives across jobs);
  // `worktreePath` is the ephemeral per-job checkout (deleted after the job).
  // Memory reads use repoPath; file/symbol reads use worktreePath.
  // ─────────────────────────────────────────────────────────────────────────
  getTools(worktreePath: string, repoPath?: string): DynamicStructuredTool[] {
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
        func: async ({
          query,
          repoFullName,
        }: {
          query: string;
          repoFullName: string;
        }) => {
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
            const collectionName = repoFullName.replace(
              /[^a-zA-Z0-9_]/g,
              '_',
            );

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
          'Get an overview of all classes, functions, and interfaces in a specific file. Use this after finding candidate files with search_codebase to see the exact symbol names before writing the plan. Skips non-code files (md, json, yml, etc.) since they have no LSP symbols.',
        schema: z.object({
          filePath: z
            .string()
            .describe(
              'The absolute or relative path to the file (relative to repo root).',
            ),
        }),
        func: async ({ filePath }: { filePath: string }) => {
          if (
            NON_SYMBOLIC_FILE_EXTENSIONS.some((ext) => filePath.endsWith(ext))
          ) {
            return `${filePath} is a non-code file (matched a non-symbolic extension). Use read_code_file to read its contents directly.`;
          }

          this.logger.log(`Fetching symbols for ${filePath}...`);
          try {
            await this.serenaMcp.activateProject(worktreePath);
            const result =
              await this.serenaMcp.getSymbolsOverview(filePath);
            return JSON.stringify(result, null, 2);
          } catch (e: any) {
            return `Error fetching symbols: ${e.message}`;
          }
        },
      }),

      new DynamicStructuredTool({
        name: 'read_code_file',
        description:
          'Read the complete contents of a specific file. Use this AFTER finding the correct file with search_codebase to inspect the exact code. You MUST read every file that the plan will modify or create adjacent to, so the plan references real symbol names and real line-level context.',
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
            const files = await fs.readdir(fullPath, {
              withFileTypes: true,
            });
            const result = files.map(
              (f) => `${f.isDirectory() ? '[DIR]' : '[FILE]'} ${f.name}`,
            );
            return JSON.stringify(result, null, 2);
          } catch (e: any) {
            return `Error listing directory: ${e.message}`;
          }
        },
      }),

      new DynamicStructuredTool({
        name: 'find_symbol',
        description:
          'Search for a symbol DEFINITION by name, project-wide or in one file. ' +
          'ONLY finds top-level definitions: functions, classes, interfaces, types, constants, exported variables. ' +
          'Does NOT find: imports (e.g. `import { motion } from "framer-motion"` — motion is an import, not a definition), ' +
          'interface/object properties (e.g. `isMobile` inside `interface Props { isMobile: boolean }`), ' +
          'or local variables inside function bodies. ' +
          'If find_symbol returns empty for a name you see in code, that name is likely an import or a property — ' +
          'use read_code_file to see it in context instead of retrying find_symbol with different names. ' +
          'Leave substringMatching on (the default) to find close matches. ' +
          'Use this to verify a symbol name actually exists before writing it into the plan, or to resolve a name you are unsure about.',
        schema: z.object({
          namePattern: z
            .string()
            .describe('The symbol name (or partial name) to search for.'),
          filePath: z
            .string()
            .optional()
            .describe(
              'Restrict the search to this file (recommended once you know which file).',
            ),
          substringMatching: z
            .boolean()
            .default(true)
            .describe(
              'If true (default), matches symbols whose name contains namePattern.',
            ),
        }),
        func: async ({
          namePattern,
          filePath,
          substringMatching,
        }: {
          namePattern: string;
          filePath?: string;
          substringMatching?: boolean;
        }) => {
          this.logger.log(
            `Finding symbol "${namePattern}" in ${filePath || 'project'}...`,
          );
          try {
            await this.serenaMcp.activateProject(worktreePath);
            const result = await this.serenaMcp.findSymbol(namePattern, {
              relativePath: filePath,
              substringMatching: substringMatching ?? true,
            });
            const text = extractMcpText(result);
            return text || JSON.stringify(result, null, 2);
          } catch (e: any) {
            return `Error finding symbol: ${e.message}`;
          }
        },
      }),
    ];
  }

  async invoke(state: AgentState): Promise<Partial<AgentState>> {
    this.logger.log('Running Planner node (research + planning)...');

    const { issuePayload } = state;

    if (!issuePayload || !issuePayload.worktreePath) {
      this.logger.warn('No issue payload or worktree path found in state.');
      return {};
    }

    const worktreePath = issuePayload.worktreePath;
    const repoPath = issuePayload.repoPath;
    // Scopes getModel/getProviderKind to the installation's BYOK config when
    // one exists (falls back to env defaults otherwise).
    const installationId = issuePayload.installation?.id;
    const tools = this.getTools(worktreePath, repoPath);
    const modelWithTools = (
      this.llmService.getModel('planner', installationId) as any
    ).bindTools(tools);

    let currentMessages: unknown[] = [...(state.plannerMessages || [])];

    // Check if this is the first visit to the planner node (no prior
    // plannerMessages). On first visit, inject memories and build the
    // system+user prompts. On subsequent visits (returning from
    // planner_tools), the plannerMessages already contain the full
    // conversation including tool results — just invoke the LLM again.
    const isFreshAttempt =
      !state.plannerMessages || state.plannerMessages.length === 0;

    if (isFreshAttempt) {
      // ── Proactive memory injection ───────────────────────────────────
      // Read ALL memories from the persistent repo-cache clone so the LLM
      // always has conventions and past lessons in context.
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

      // ── Build the system prompt ──────────────────────────────────────
      const title =
        issuePayload.issue?.title || issuePayload.title || 'Unknown Issue';
      const body = issuePayload.issue?.body || issuePayload.body || '';
      const repoFullName =
        issuePayload.repository?.full_name || 'unknown_repo';

      const systemPrompt = new SystemMessage(
        `You are an expert autonomous software engineer. Your goal is to investigate the codebase and write a precise implementation plan for the issue below.

CRITICAL INSTRUCTIONS:
1. You have been given Serena memories (project conventions and past lessons) below — use them to guide your investigation. However, memories may be outdated or incomplete. You MUST verify by exploring the actual codebase.
2. You MUST call at least list_dir on the root directory (".") and at least one search_codebase call before writing the plan. Memories alone are NOT sufficient — you need to know the actual file structure and the exact contents of files that will be modified.
3. Use search_codebase to find files relevant to the issue. Pass repoFullName: "${repoFullName}".
4. Use get_file_symbols to inspect the structure of candidate files and see the EXACT symbol names. Use find_symbol to verify a symbol name if you are unsure.
5. Use read_code_file to read the exact contents of every file that the plan will modify or create adjacent to. The plan must reference real symbol names and real code patterns — not guesses.
6. Use list_dir to explore the file structure when search_codebase does not find the exact file.
7. If initial search results seem wrong, PIVOT — try different search terms. You are not limited to one search.
8. You can call read_serena_memory to re-read a specific memory if you need to double-check a convention.
9. Once you have read the relevant files and are confident you have enough context, write a step-by-step implementation plan and STOP calling tools. The full plan MUST appear as plain text in your final response body — never leave the response body empty.
10. The plan must use the EXACT file paths and EXACT symbol names you found in the codebase — do not invent paths or symbol names. The engineer implementing this plan will re-read each file before editing, but the names in the plan must be correct.
11. For each step, specify: which file, which symbol (if modifying), and what the change should be. Be specific about the code pattern to follow (e.g. "match the existing error-handling pattern in handleRequest").

${memoryContext ? `SERENA MEMORIES (already injected — no need to re-read unless you need to double-check):\n${memoryContext}` : '(No Serena memories were available for this repo.)'}`,
      );

      const userPrompt = new HumanMessage(
        `Issue Title: ${title}\nIssue Body: ${body}`,
      );

      currentMessages = [systemPrompt, userPrompt];
      this.logger.log('[Planner] Starting new research+planning attempt.');
    }

    // ── Invoke the LLM (with a bounded empty-plan re-prompt loop) ────────
    // One normal invocation, then up to MAX_PLAN_REPROMPTS re-prompts when
    // a "final" response carries no plan text. Two failure shapes land in
    // the re-prompt path:
    //
    //   a) No tool calls but empty content — DeepSeek thinking mode can put
    //      the ENTIRE output into reasoning_content and return an empty
    //      content body (observed in production after the hard-cap backstop
    //      unbinds tools).
    //   b) Tool calls while over the cap — hallucinated calls from a model
    //      with no tools bound, which must not route back to planner_tools.
    //
    // Both are re-prompted with an explicit "write the plan now" user turn;
    // if the budget is exhausted, throw a clear error so the job fails fast
    // instead of leaking an empty implementationPlan into the patcher →
    // validator retry loop (the GraphRecursionError death spiral).
    let conversation: unknown[] = currentMessages;
    let repromptsUsed = 0;

    for (;;) {
      // ── Hard cap backstop ────────────────────────────────────────────
      // The primary stop is the model's own signal (no tool_calls = done).
      // The dispatch-boundary repeat detection in planner_tools catches
      // spinning loops. This hard cap is a pure backstop for the rare case
      // where the LLM keeps making unique calls without converging.
      // Following Claude Code's max_turns pattern: unbind tools and let the
      // model produce a final text response.
      const overCap = conversation.length > MAX_PLANNER_TOOL_MESSAGES;
      if (overCap) {
        this.logger.warn(
          `[Planner] Hard cap reached (${conversation.length} > ` +
            `${MAX_PLANNER_TOOL_MESSAGES} messages). Unbinding tools for final response.`,
        );
      }

      // When over the cap, call the bare model (no tools bound) so it must
      // produce a text response. Otherwise, bind tools normally.
      const model = overCap
        ? (this.llmService.getModel('planner', installationId) as any)
        : modelWithTools;

      // Gemini rejects request payloads that end with a text-only assistant
      // turn: 400 "Requests ending with a model turn are not supported". The
      // normal tool loop never produces that shape (tool-call turns are
      // always followed by ToolMessage results), but the hard-cap backstop
      // and the re-prompt replay below can — guard defensively, Gemini only.
      const invokeMessages =
        this.llmService.getProviderKind('planner', installationId) === 'gemini'
          ? ensureEndsWithUserTurn(conversation)
          : conversation;
      const response = (await model.invoke(invokeMessages)) as AIMessage;

      this.llmService.logTokenUsage('planner', response);

      // DeepSeek thinking mode can leak raw DSML tool-calling markup into
      // response.content (e.g. when it wants to call tools but none are
      // bound, or the tool parser misses a START token at long context).
      // Reasoning models with interleaved thinking (MiniMax M2.x, DeepSeek-R1
      // on some hosts) similarly leak <think> blocks inline. Strip both so
      // neither the plan text nor the replayed conversation history carries
      // the markup downstream. No-op for every other provider.
      const rawText = extractResponseText(response.content);
      const cleanText = stripThinkTokens(stripDsmlTokens(rawText));
      if (cleanText !== rawText) {
        this.logger.warn(
          '[Planner] Stripped leaked reasoning/tool-calling markup (DSML / <think>) from LLM output.',
        );
        response.content = cleanText;
      }
      const planText = cleanText.trim();

      const hasToolCalls = (response.tool_calls?.length ?? 0) > 0;
      this.logger.log(
        `[Planner] LLM responded with ${response.tool_calls?.length || 0} tool call(s).`,
      );

      if (hasToolCalls && !overCap) {
        // LLM wants to call more tools — route to planner_tools via the
        // orchestration graph's conditional edge.
        return { plannerMessages: [...conversation, response] };
      }

      if (!hasToolCalls && planText) {
        // No tool calls and real text — the LLM has produced the plan.
        this.logger.log(
          `[Planner] Final plan:\n${'─'.repeat(60)}\n${planText}\n${'─'.repeat(60)}`,
        );

        return {
          implementationPlan: planText,
          // Explicitly reset the patcher's tool-loop message history so a fresh
          // plan always starts a fresh patch-generation attempt, never
          // continuing a previous attempt's (possibly stale) conversation.
          patchMessages: [],
          plannerMessages: [...conversation, response],
          messages: [
            new SystemMessage('Implementation plan drafted.'),
          ],
        };
      }

      // ── No-plan response — re-prompt or fail ─────────────────────────
      if (repromptsUsed >= MAX_PLAN_REPROMPTS) {
        throw new Error(
          `Planner failed to produce an implementation plan: after ` +
            `${repromptsUsed} re-prompt(s) the model kept returning ` +
            (hasToolCalls
              ? 'tool calls even with tools unbound'
              : 'empty content (reasoning-only output)') +
            '. Check the PLANNER_MODEL configuration — reasoning models can ' +
            'emit their whole output as reasoning_content with an empty content body.',
        );
      }
      repromptsUsed += 1;
      this.logger.warn(
        `[Planner] Response carried no plan text ` +
          `(${hasToolCalls ? 'tool calls with tools unbound' : 'empty content'}) — ` +
          `re-prompting for the plan (${repromptsUsed}/${MAX_PLAN_REPROMPTS}).`,
      );

      // Replay the unusable response WITHOUT its tool_calls (no ToolMessages
      // will follow them, and replaying tool_calls without results is a 400
      // on OpenAI/DeepSeek), preserving additional_kwargs so DeepSeek's
      // reasoning_content still round-trips in thinking mode. Then nudge.
      const replay = new AIMessage({
        content: response.content,
        additional_kwargs: response.additional_kwargs,
      });
      conversation = [
        ...conversation,
        replay,
        new HumanMessage(PLAN_REPROMPT_TEXT),
      ];
    }
  }
}

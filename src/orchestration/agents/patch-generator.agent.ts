/* eslint-disable */
import { Injectable, Logger } from '@nestjs/common';
import { AgentState } from '../graph.state';
import { LlmService } from '../llm.service';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { SerenaMcpService } from '../../intelligence/serena-mcp.service';
import { assertSafeWorktreePath } from '../../common/worktree-path-guard';
import { extractMcpText } from '../../common/mcp-text';
import {
  stripDsmlTokens,
  stripThinkTokens,
  ensureEndsWithUserTurn,
} from '../../common/llm-guards';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Per-job gate-tracking state for the tool loop below. Keyed by worktreePath
 * (unique per job) rather than held per-getTools() call, because getTools()
 * is invoked fresh every time the orchestration graph's `patcher_tools` node
 * runs (mirroring ResearchAgent's pattern), but the gates below — most
 * importantly "was this file actually read before it was edited" — must
 * persist across every iteration of one patch-generation attempt, not just
 * one tool call.
 */
interface PatchSession {
  /** Files the model has read via read_file this attempt. Editing tools
   * refuse to touch a file that is not in this set. */
  readPaths: Set<string>;
  /** Human-readable log of edits actually applied, surfaced as
   * `generatedPatch`. */
  appliedActions: string[];
  /** Gate rejections and tool errors encountered this attempt, surfaced as
   * `unappliedChanges`. Not necessarily permanent failures — the model
   * often self-corrects and retries successfully within the same loop; this
   * is diagnostic friction, not a guaranteed list of missed changes. */
  blockedActions: string[];
}

/**
 * Hard safety-net cap on patcher messages — a pure backstop.
 *
 * The primary stop is the model's own signal (no tool_calls = done).
 * The dispatch-boundary repeat detection in patcher_tools catches spinning
 * loops. This hard cap only fires if the LLM keeps making unique calls
 * without converging. 60 messages ≈ 20 iterations — generous for
 * multi-file edits.
 */
const MAX_PATCHER_TOOL_MESSAGES = 60;

/** Pulls the raw text out of an MCP tool result regardless of isError, for
 * building a useful error message back to the model. `extractMcpText`
 * (shared with other agents) deliberately returns null for error results,
 * which is the wrong behavior here — we want the error text specifically. */
function extractAnyMcpText(result: unknown): string {
  if (!result) return 'Unknown error';
  const typed = result as { content?: { text?: string }[] };
  if (Array.isArray(typed.content)) {
    return typed.content.map((c) => c?.text ?? '').join('') || 'Unknown error';
  }
  return JSON.stringify(result);
}

@Injectable()
export class PatchGeneratorAgent {
  private readonly logger = new Logger(PatchGeneratorAgent.name);
  private readonly sessions = new Map<string, PatchSession>();

  constructor(
    private readonly llmService: LlmService,
    private readonly serenaMcp: SerenaMcpService,
  ) {}

  /**
   * Clears a job's gate-tracking session. Must be called once the job's
   * graph run has finished (success or failure) — the sessions map is keyed
   * by worktreePath and otherwise grows unboundedly across jobs for the
   * lifetime of this singleton service. Safe to call even if no session was
   * ever created (e.g. the job never reached the patcher).
   */
  clearSession(worktreePath: string): void {
    this.sessions.delete(worktreePath);
  }

  /**
   * Returns this job's tool set, bound to its gate-tracking session. Public
   * so the orchestration graph's `patcher_tools` node (mirroring
   * ResearchAgent.getTools()'s pattern) can execute the generator's tool
   * calls without reaching into private state.
   */
  getToolsForSession(worktreePath: string): DynamicStructuredTool[] {
    return this.getTools(worktreePath, this.getOrCreateSession(worktreePath));
  }

  private getOrCreateSession(worktreePath: string): PatchSession {
    let session = this.sessions.get(worktreePath);
    if (!session) {
      session = { readPaths: new Set(), appliedActions: [], blockedActions: [] };
      this.sessions.set(worktreePath, session);
    }
    return session;
  }

  async invoke(state: AgentState): Promise<Partial<AgentState>> {
    if (!state.implementationPlan) {
      // The plan can only come from the planner upstream — no retry of this
      // node can conjure it. The old silent {} return routed straight into
      // validator → human_feedback → patcher, an unrecoverable loop that
      // spun until the graph recursion limit; fail fast and clearly instead.
      this.logger.error(
        'No implementation plan in state — the planner did not produce a plan.',
      );
      throw new Error(
        'Patch generation failed: no implementation plan in state — the planner did not produce a plan.',
      );
    }

    // The worktree is the isolated git checkout for this job. All reads and
    // writes must target it — NOT repo-cache/repo — so the ValidationAgent
    // sandbox and GitAgent both see the patched files.
    const worktreePath = state.issuePayload?.worktreePath;
    // Scopes getModel/getProviderKind to the installation's BYOK config when
    // one exists (falls back to env defaults otherwise).
    const installationId = state.issuePayload?.installation?.id;
    if (!worktreePath) {
      this.logger.warn(
        'No worktreePath in state — cannot read source files or write patches.',
      );
      return {};
    }

    // `planner` and `human_feedback` both explicitly reset `patchMessages`
    // to [] before routing here, so an empty array means this is a fresh
    // attempt rather than a mid-loop continuation. Reset the gate session
    // too — the worktree may have changed since a previous failed attempt,
    // so stale read/blocked state should not carry forward.
    const isFreshAttempt = !state.patchMessages || state.patchMessages.length === 0;
    if (isFreshAttempt) {
      // activate_project re-initializes Serena's language server and
      // re-scans the project — expensive and redundant on mid-loop
      // iterations, where the project is already activated from the
      // first iteration and nothing deactivates it between tool calls.
      // Only activate once per fresh attempt.
      await this.serenaMcp.activateProject(worktreePath);
      this.sessions.delete(worktreePath);
    }
    const session = this.getOrCreateSession(worktreePath);

    let currentMessages: unknown[] = [...(state.patchMessages || [])];

    if (isFreshAttempt) {
      const systemPrompt = new SystemMessage(
        `You are an autonomous AI coding agent. Implement the plan below by calling tools to read and edit files — you have no other way to make changes.\n\n` +
          `RULES:\n` +
          `1. You MUST call read_file on a file before editing it with replace_symbol_body, insert_after_symbol, insert_before_symbol, rename_symbol, or safe_delete_symbol. Editing an unread file is rejected.\n` +
          `2. The plan's file paths and symbol names are a hypothesis, not verified fact — they were written before anyone confirmed them against the real file. If a symbol name from the plan doesn't match what you find, use the ACTUAL name from the file (use find_symbol to resolve it). NEVER rename or restructure existing code just to make it match the plan.\n` +
          `3. For files the plan says to create, the plan's path is the decision — use create_text_file. It fails if the path already exists; use an edit tool instead in that case.\n` +
          `4. Match the existing code's style, exports, and patterns. Do not rewrite working code beyond what the plan asks for.\n` +
          `5. When every change from the plan has been applied, respond with a short plain-text summary and stop calling tools.`,
      );

      let userPromptContent =
        `Implementation Plan:\n${state.implementationPlan}\n\n` +
        `Research Context:\n${state.researchContext ?? '(none)'}`;
      if (state.validationFeedback) {
        userPromptContent += `\n\nPrevious Validation Feedback (fix these):\n${state.validationFeedback}`;
      }
      currentMessages = [systemPrompt, new HumanMessage(userPromptContent)];
      this.logger.log('[PatchGenerator] Starting new patch-generation attempt.');
    }

    const tools = this.getTools(worktreePath, session);

    // ── Hard cap backstop ────────────────────────────────────────────────
    // The primary stop is the model's own signal (no tool_calls = done).
    // The dispatch-boundary repeat detection in patcher_tools catches
    // spinning loops. This hard cap is a pure backstop.
    const overCap = currentMessages.length > MAX_PATCHER_TOOL_MESSAGES;
    if (overCap) {
      this.logger.warn(
        `[PatchGenerator] Hard cap reached (${currentMessages.length} > ` +
          `${MAX_PATCHER_TOOL_MESSAGES} messages). Unbinding tools for final response. ` +
          `${session.appliedActions.length} change(s) applied so far.`,
      );
    }

    // When over the cap, call the bare model (no tools bound).
    const model = overCap
      ? (this.llmService.getModel('patch_generator', installationId) as any)
      : ((this.llmService.getModel('patch_generator', installationId) as any).bindTools(tools) as any);

    // Gemini rejects request payloads that end with a text-only assistant
    // turn: 400 "Requests ending with a model turn are not supported". The
    // normal tool loop never produces that shape, but the hard-cap backstop
    // and any future message-merging path can — guard defensively, Gemini only.
    const invokeMessages =
      this.llmService.getProviderKind('patch_generator', installationId) ===
      'gemini'
        ? ensureEndsWithUserTurn(currentMessages)
        : currentMessages;
    const response = (await model.invoke(invokeMessages)) as AIMessage;

    this.llmService.logTokenUsage('patch_generator', response);

    // DeepSeek thinking mode can leak raw DSML tool-calling markup into
    // response.content (e.g. when it wants to read files but no tools are
    // bound — the hard-cap unbind path). Reasoning models with interleaved
    // thinking (MiniMax M2.x, DeepSeek-R1 on some hosts) similarly leak
    // <think> blocks inline. Strip both so neither the final summary nor the
    // replayed conversation history carries the markup. No-op for every
    // other provider.
    const rawContent = response.content as string;
    const cleanContent = stripThinkTokens(stripDsmlTokens(rawContent));
    if (cleanContent !== rawContent) {
      this.logger.warn(
        '[PatchGenerator] Stripped leaked reasoning/tool-calling markup (DSML / <think>) from LLM output.',
      );
      response.content = cleanContent;
    }

    const newMessages = [...currentMessages, response];

    if (response.tool_calls && response.tool_calls.length > 0) {
      this.logger.log(
        `[PatchGenerator] LLM requested ${response.tool_calls.length} tool call(s).`,
      );
      return { patchMessages: newMessages };
    }

    // No tool calls — the model considers the patch complete.
    this.logger.log(
      `[PatchGenerator] LLM final response:\n${'─'.repeat(60)}\n${response.content}\n${'─'.repeat(60)}`,
    );

    if (session.appliedActions.length === 0) {
      this.logger.error(
        '[PatchGenerator] No changes were successfully applied. Aborting pipeline.',
      );
      throw new Error(
        'Patch generation failed: No valid code changes applied.',
      );
    }

    return {
      generatedPatch: `Applied changes:\n${session.appliedActions.join('\n')}`,
      unappliedChanges: session.blockedActions.join('\n'),
      patchMessages: newMessages,
      messages: [
        new SystemMessage(
          `Patch generated and applied (${session.appliedActions.length} change${
            session.appliedActions.length === 1 ? '' : 's'
          }${session.blockedActions.length ? `, ${session.blockedActions.length} blocked attempt(s) along the way` : ''}).`,
        ),
      ],
    };
  }

  /**
   * The generator's tool set. Deliberately small (9 tools) — larger tool
   * sets measurably degrade tool-selection accuracy in agentic loops.
   * Notably absent: a whole-file delete tool. Combining "delete an existing
   * file" with "create a file at that same path" is exactly the pattern
   * that silently drops unrelated code (observed in production: an entire
   * `app/layout.tsx` deleted and rewritten from scratch instead of
   * modified). Removing the capability entirely is simpler and safer than
   * policing the combination after the fact; rare genuine whole-file
   * rewrites can go through `replace_symbol_body` on the file's top-level
   * symbol, or be added back later as a reviewed, more restricted tool if a
   * real need shows up.
   */
  private getTools(
    worktreePath: string,
    session: PatchSession,
  ): DynamicStructuredTool[] {
    const readFile = new DynamicStructuredTool({
      name: 'read_file',
      description:
        'Read the exact current contents of a file. You MUST call this on a file before editing it with replace_symbol_body, insert_after_symbol, insert_before_symbol, rename_symbol, or safe_delete_symbol.',
      schema: z.object({
        filePath: z
          .string()
          .describe('Relative path to the file, e.g. "app/page.tsx".'),
      }),
      func: async ({ filePath }: { filePath: string }) => {
        try {
          assertSafeWorktreePath(worktreePath, filePath);
          const result = await this.serenaMcp.readFile(filePath);
          const text = extractMcpText(result);
          if (text === null) {
            return `Error reading "${filePath}": ${extractAnyMcpText(result)}`;
          }
          session.readPaths.add(filePath);
          return text;
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          return `Error reading "${filePath}": ${message}`;
        }
      },
    });

    const getSymbolsOverview = new DynamicStructuredTool({
      name: 'get_symbols_overview',
      description:
        'List the top-level classes/functions/interfaces in a file, without their bodies. Useful for a quick check of what a file exports before deciding whether to read_file it in full.',
      schema: z.object({
        filePath: z.string().describe('Relative path to the file.'),
      }),
      func: async ({ filePath }: { filePath: string }) => {
        try {
          const result = await this.serenaMcp.getSymbolsOverview(filePath);
          const text = extractMcpText(result);
          return text !== null
            ? text
            : `Error: ${extractAnyMcpText(result)}. If this file does not exist yet, use create_text_file instead.`;
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          return `Error: ${message}. If this file does not exist yet, use create_text_file instead.`;
        }
      },
    });

    const findSymbolTool = new DynamicStructuredTool({
      name: 'find_symbol',
      description:
        "Search for a symbol by name, project-wide or in one file. Use this to verify a symbol name from the plan actually exists, or to resolve a 'No symbol matching' error from an edit tool — leave substringMatching on (the default) to find close matches, e.g. searching \"Home\" finds \"HomePage\".",
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
        try {
          const result = await this.serenaMcp.findSymbol(namePattern, {
            relativePath: filePath,
            substringMatching: substringMatching ?? true,
          });
          const text = extractMcpText(result);
          return text !== null ? text : `Error: ${extractAnyMcpText(result)}`;
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          return `Error: ${message}`;
        }
      },
    });

    /** Gate 1 (read-before-edit): returns a rejection message if `filePath`
     * has not been read via read_file this attempt, else null. */
    const requireRead = (filePath: string): string | null => {
      if (!session.readPaths.has(filePath)) {
        return (
          `Blocked: you must call read_file("${filePath}") before editing it — ` +
          `this tool cannot know what the file currently contains, and editing it blind ` +
          `risks discarding unrelated code. Call read_file first, then retry this edit.`
        );
      }
      return null;
    };

    /** Shared wrapper for every symbol-mutating Serena tool: enforces the
     * read-before-edit gate, retries a "no symbol matching" failure with a
     * find_symbol suggestion so the model can self-correct in the same
     * loop, and records the outcome for the final summary. */
    const runSymbolEdit = async (
      filePath: string,
      symbolName: string,
      apply: () => Promise<any>,
      summary: string,
    ): Promise<string> => {
      const blocked = requireRead(filePath);
      if (blocked) {
        session.blockedActions.push(`${summary}: not read before edit`);
        return blocked;
      }
      try {
        assertSafeWorktreePath(worktreePath, filePath);
        const result = await apply();
        if (result?.isError) {
          const errText = extractAnyMcpText(result);
          if (/no symbol matching/i.test(errText)) {
            const suggestionResult = await this.serenaMcp
              .findSymbol(symbolName, {
                relativePath: filePath,
                substringMatching: true,
              })
              .catch(() => null);
            const suggestion = suggestionResult
              ? extractMcpText(suggestionResult)
              : null;
            session.blockedActions.push(`${summary}: symbol not found`);
            return (
              `Error: ${errText}. ` +
              (suggestion && suggestion !== '[]'
                ? `Found in this file: ${suggestion}. Retry with the correct name.`
                : 'Call find_symbol to locate the correct name, or read_file to inspect the file.')
            );
          }
          session.blockedActions.push(`${summary}: ${errText}`);
          return `Error: ${errText}`;
        }
        session.appliedActions.push(summary);
        return `OK: ${summary}`;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        session.blockedActions.push(`${summary}: ${message}`);
        return `Error: ${message}`;
      }
    };

    const replaceSymbolBody = new DynamicStructuredTool({
      name: 'replace_symbol_body',
      description:
        'Replace the entire body of an existing function/class/etc with new code. Requires read_file on this file first. Provide the COMPLETE new body — do not omit unrelated lines.',
      schema: z.object({
        filePath: z.string(),
        symbolName: z
          .string()
          .describe(
            'Exact symbol name as it appears in the file (verify with read_file or find_symbol — do not guess).',
          ),
        newBody: z.string().describe('The complete replacement source for this symbol.'),
      }),
      func: async ({
        filePath,
        symbolName,
        newBody,
      }: {
        filePath: string;
        symbolName: string;
        newBody: string;
      }) =>
        runSymbolEdit(
          filePath,
          symbolName,
          () => this.serenaMcp.replaceSymbolBody(filePath, symbolName, newBody),
          `MODIFY ${filePath} | ${symbolName}`,
        ),
    });

    const insertAfterSymbol = new DynamicStructuredTool({
      name: 'insert_after_symbol',
      description:
        'Insert new code immediately after an existing symbol (e.g. adding a new function next to a related one). Requires read_file on this file first.',
      schema: z.object({
        filePath: z.string(),
        symbolName: z.string(),
        newBody: z.string(),
      }),
      func: async ({
        filePath,
        symbolName,
        newBody,
      }: {
        filePath: string;
        symbolName: string;
        newBody: string;
      }) =>
        runSymbolEdit(
          filePath,
          symbolName,
          () => this.serenaMcp.insertAfterSymbol(filePath, symbolName, newBody),
          `INSERT_AFTER ${filePath} | ${symbolName}`,
        ),
    });

    const insertBeforeSymbol = new DynamicStructuredTool({
      name: 'insert_before_symbol',
      description:
        'Insert new code immediately before an existing symbol (e.g. adding a new import block before the first declaration). Requires read_file on this file first.',
      schema: z.object({
        filePath: z.string(),
        symbolName: z.string(),
        newBody: z.string(),
      }),
      func: async ({
        filePath,
        symbolName,
        newBody,
      }: {
        filePath: string;
        symbolName: string;
        newBody: string;
      }) =>
        runSymbolEdit(
          filePath,
          symbolName,
          () => this.serenaMcp.insertBeforeSymbol(filePath, symbolName, newBody),
          `INSERT_BEFORE ${filePath} | ${symbolName}`,
        ),
    });

    const renameSymbolTool = new DynamicStructuredTool({
      name: 'rename_symbol',
      description:
        'Rename a symbol across its definition and all references via the language server. Requires read_file on this file first.',
      schema: z.object({
        filePath: z.string(),
        symbolName: z.string(),
        newName: z.string(),
      }),
      func: async ({
        filePath,
        symbolName,
        newName,
      }: {
        filePath: string;
        symbolName: string;
        newName: string;
      }) =>
        runSymbolEdit(
          filePath,
          symbolName,
          () => this.serenaMcp.renameSymbol(filePath, symbolName, newName),
          `RENAME ${filePath} | ${symbolName} -> ${newName}`,
        ),
    });

    const safeDeleteSymbol = new DynamicStructuredTool({
      name: 'safe_delete_symbol',
      description:
        'Delete a symbol, but only if nothing else references it. If references exist, this refuses and tells you where they are — that is expected behavior, not an error to retry blindly. Requires read_file on this file first.',
      schema: z.object({
        filePath: z.string(),
        symbolName: z.string(),
      }),
      func: async ({
        filePath,
        symbolName,
      }: {
        filePath: string;
        symbolName: string;
      }) =>
        runSymbolEdit(
          filePath,
          symbolName,
          () => this.serenaMcp.safeDeleteSymbol(filePath, symbolName),
          `DELETE ${filePath} | ${symbolName}`,
        ),
    });

    const createTextFile = new DynamicStructuredTool({
      name: 'create_text_file',
      description:
        'Create a brand-new file with the given content. Fails if the file already exists — use replace_symbol_body (or another edit tool, after read_file) to change an existing file instead.',
      schema: z.object({
        filePath: z.string(),
        content: z.string().describe('The complete content of the new file.'),
      }),
      func: async ({
        filePath,
        content,
      }: {
        filePath: string;
        content: string;
      }) => {
        const summary = `CREATE ${filePath}`;
        let absolutePath: string;
        try {
          absolutePath = assertSafeWorktreePath(worktreePath, filePath);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          session.blockedActions.push(`${summary}: ${message}`);
          return `Error: ${message}`;
        }

        // Gate 2: never silently overwrite an existing file via "create".
        const alreadyExists = await fs
          .access(absolutePath)
          .then(() => true)
          .catch(() => false);
        if (alreadyExists) {
          session.blockedActions.push(`${summary}: file already exists`);
          return (
            `Error: "${filePath}" already exists. Use replace_symbol_body ` +
            `(after read_file) to modify it instead of create_text_file.`
          );
        }

        try {
          const result = await this.serenaMcp.createTextFile(filePath, content);
          if (result?.isError) {
            throw new Error(extractAnyMcpText(result));
          }
          session.appliedActions.push(summary);
          return `OK: ${summary}`;
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          // Fall back to a direct filesystem write if Serena's own tool
          // fails for a reason unrelated to the file already existing
          // (e.g. the MCP round trip itself errors) — mirrors the
          // resilience the previous non-agentic CREATE path had.
          try {
            await fs.mkdir(path.dirname(absolutePath), { recursive: true });
            await fs.writeFile(absolutePath, content, 'utf8');
            session.appliedActions.push(summary);
            return `OK: ${summary} (via direct filesystem write — Serena create_text_file failed: ${message})`;
          } catch (e2: unknown) {
            const message2 = e2 instanceof Error ? e2.message : String(e2);
            session.blockedActions.push(`${summary}: ${message2}`);
            return `Error: ${message2}`;
          }
        }
      },
    });

    return [
      readFile,
      getSymbolsOverview,
      findSymbolTool,
      replaceSymbolBody,
      insertAfterSymbol,
      insertBeforeSymbol,
      renameSymbolTool,
      safeDeleteSymbol,
      createTextFile,
    ];
  }
}

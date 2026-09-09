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

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

@Injectable()
export class SerenaMcpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SerenaMcpService.name);
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;

  async onModuleInit() {
    this.logger.log('Initializing Serena MCP Client via Streamable HTTP...');

    // In docker-compose, the serena service is named lazydev-serena, exposing port 3333
    const SERENA_URL =
      process.env.SERENA_URL || 'http://lazydev-serena:3333/mcp';

    try {
      this.transport = new StreamableHTTPClientTransport(new URL(SERENA_URL));
      this.client = new Client(
        {
          name: 'lazydev-orchestrator',
          version: '1.0.0',
        },
        {
          capabilities: {},
        },
      );

      await this.client.connect(this.transport);
      this.logger.log('Successfully connected to Serena MCP Server');
    } catch (error) {
      this.logger.error('Failed to connect to Serena MCP Server:', error);
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      this.logger.log('Closing Serena MCP connection...');
      try {
        await this.client.close();
      } catch (e) {
        this.logger.error('Error while closing client:', e);
      }
    }
  }

  // MCP Wrapper Methods
  async activateProject(worktreePath: string): Promise<any> {
    return this.callTool('activate_project', { project: worktreePath });
  }

  async getSymbolsOverview(filePath: string): Promise<any> {
    return this.callTool('get_symbols_overview', { relative_path: filePath });
  }

  async findReferencingSymbols(
    filePath: string,
    symbolName: string,
  ): Promise<any> {
    return this.callTool('find_referencing_symbols', {
      name_path: symbolName,
      relative_path: filePath,
    });
  }

  async replaceSymbolBody(
    filePath: string,
    symbolName: string,
    newBody: string,
  ): Promise<any> {
    return this.callTool('replace_symbol_body', {
      name_path: symbolName,
      relative_path: filePath,
      body: newBody,
    });
  }

  async insertAfterSymbol(
    filePath: string,
    symbolName: string,
    newBody: string,
  ): Promise<any> {
    return this.callTool('insert_after_symbol', {
      name_path: symbolName,
      relative_path: filePath,
      body: newBody,
    });
  }

  async insertBeforeSymbol(
    filePath: string,
    symbolName: string,
    newBody: string,
  ): Promise<any> {
    return this.callTool('insert_before_symbol', {
      name_path: symbolName,
      relative_path: filePath,
      body: newBody,
    });
  }

  /**
   * Reads a slice (or the whole) of a file's raw text via Serena, so the
   * PatchGeneratorAgent's tool loop can ground itself in the exact current
   * contents of a file before editing it — the same file view the LSP-backed
   * tools (get_symbols_overview, replace_symbol_body) are reasoning about.
   */
  async readFile(
    filePath: string,
    startLine?: number,
    endLine?: number,
  ): Promise<any> {
    const args: Record<string, unknown> = { relative_path: filePath };
    if (startLine !== undefined) args.start_line = startLine;
    if (endLine !== undefined) args.end_line = endLine;
    return this.callTool('read_file', args);
  }

  /**
   * Project-wide (or file-scoped) symbol lookup by name pattern. Verified
   * live against Serena 1.28.1: `substring_matching: true` resolves a
   * truncated/hallucinated name like "Home" to the real symbol ("HomePage")
   * without any fuzzy-matching logic on our side — this is the primary
   * defense against the LLM guessing symbol names it never actually read.
   */
  async findSymbol(
    namePathPattern: string,
    options?: { relativePath?: string; substringMatching?: boolean },
  ): Promise<any> {
    return this.callTool('find_symbol', {
      name_path_pattern: namePathPattern,
      relative_path: options?.relativePath ?? '',
      substring_matching: options?.substringMatching ?? false,
    });
  }

  /**
   * LSP diagnostics for a file. `minSeverity` follows Serena's convention
   * (1=Error, 2=Warning, 3=Information, 4=Hint; lower numbers are more
   * severe and are always included alongside anything at or below the
   * requested threshold) — callers doing correctness checks should pass 1
   * to see only Errors.
   *
   * IMPORTANT: node_modules is not installed in the worktree until the
   * ValidationAgent's sandbox runs `npm install` *after* the patch is
   * generated, so diagnostics taken during generation will always include
   * "Cannot find module" (TS2307) noise for every external (non-`@/`
   * aliased) import — verified live against this project's own worktree.
   * Callers MUST diff against a pre-edit baseline snapshot of the same file
   * rather than treating any non-empty diagnostics result as a failure;
   * repositories can also have pre-existing type errors unrelated to any
   * patch.
   */
  async getDiagnosticsForFile(
    filePath: string,
    minSeverity: number = 4,
  ): Promise<any> {
    return this.callTool('get_diagnostics_for_file', {
      relative_path: filePath,
      min_severity: minSeverity,
    });
  }

  /**
   * Creates or overwrites a whole file. Used for the `create` patch action —
   * `replaceSymbolBody` requires the target symbol (and therefore the file) to
   * already exist, so it cannot be used to scaffold new files.
   */
  async createTextFile(filePath: string, content: string): Promise<any> {
    return this.callTool('create_text_file', {
      relative_path: filePath,
      content,
    });
  }

  /**
   * Deletes a symbol only if it is safe to do so (no remaining references).
   * If references exist, Serena returns them instead of deleting — this is a
   * deliberate refusal, not a failure, so callers should surface the message
   * rather than treat it as an error to retry.
   */
  async safeDeleteSymbol(filePath: string, symbolName: string): Promise<any> {
    return this.callTool('safe_delete_symbol', {
      name_path_pattern: symbolName,
      relative_path: filePath,
    });
  }

  /** Renames a symbol across its definition and all references via the LSP. */
  async renameSymbol(
    filePath: string,
    symbolName: string,
    newName: string,
  ): Promise<any> {
    return this.callTool('rename_symbol', {
      name_path: symbolName,
      relative_path: filePath,
      new_name: newName,
    });
  }

  // Memory Methods
  //
  // Verified against Serena's live tool schema: `list_memories` takes only an
  // optional `topic`, `read_memory` takes only `memory_name`, and
  // `write_memory` takes `memory_name` + `content` (+ optional `max_chars`) —
  // none of them accept a project-path argument. Which project a memory
  // belongs to is determined entirely by whichever project was most recently
  // `activate_project`'d in this session; memories physically live at
  // `<project_root>/.serena/memories/<name>.md`. Callers that need a memory
  // to persist beyond one ephemeral worktree must `activateProject()` a
  // durable path (e.g. the shared repo-cache clone) before calling these, and
  // reactivate the worktree afterward if they still need code-level tools.
  //
  // The previous versions of these wrappers sent `{ name, project_path }` —
  // `project_path` was silently ignored and `name` is not a recognized key
  // (the tool requires `memory_name`), so every write/read call failed with
  // `isError: true`. None of the callers checked `isError`, so this was
  // invisible in the logs — every previously "successful" memory write never
  // actually wrote anything.
  async listMemories(): Promise<any> {
    return this.callTool('list_memories', {});
  }

  async readMemory(name: string): Promise<any> {
    return this.callTool('read_memory', { memory_name: name });
  }

  async writeMemory(name: string, content: string): Promise<any> {
    return this.callTool('write_memory', { memory_name: name, content });
  }

  private async callTool(toolName: string, args: any): Promise<any> {
    if (!this.client) {
      this.logger.error(
        `Cannot call tool ${toolName}, MCP client is not connected.`,
      );
      throw new Error('Serena MCP client disconnected.');
    }
    this.logger.log(
      `Calling MCP tool: ${toolName} with args: ${JSON.stringify(args)}`,
    );
    try {
      const response = await this.client.callTool({
        name: toolName,
        arguments: args,
      });
      return response;
    } catch (e) {
      this.logger.error(`Error calling ${toolName}:`, e);
      throw e;
    }
  }
}

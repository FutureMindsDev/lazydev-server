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

import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs/promises';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { PatchGeneratorAgent } from './patch-generator.agent';
import { LlmService } from '../llm.service';
import { SerenaMcpService } from '../../intelligence/serena-mcp.service';
import type { AgentState } from '../graph.state';

jest.mock('fs/promises');
const mockedFs = fs as jest.Mocked<typeof fs>;

const ok = () => ({ isError: false, content: [{ text: 'ok' }] });
const mcpError = (text: string) => ({ isError: true, content: [{ text }] });
const mcpText = (text: string) => ({ isError: false, content: [{ text }] });

/** Mock LLM model that supports bindTools(). Returns queued responses in order. */
class MockLlmModel {
  private responses: AIMessage[];
  public invoke: jest.Mock;
  public bindTools: jest.Mock;

  constructor(responses: AIMessage[]) {
    this.responses = responses;
    this.invoke = jest.fn().mockImplementation(() => {
      const next = this.responses.shift();
      return Promise.resolve(next);
    });
    this.bindTools = jest.fn().mockReturnThis();
  }
}

/** Builds an AIMessage with tool_calls (simulating the LLM requesting tools). */
const aiWithToolCalls = (toolCalls: any[], content = '') =>
  new AIMessage({ content, tool_calls: toolCalls });

/** Builds an AIMessage with no tool calls (simulating the LLM's final summary). */
const aiFinal = (content: string) => new AIMessage({ content, tool_calls: [] });

describe('PatchGeneratorAgent', () => {
  let agent: PatchGeneratorAgent;
  let serenaMcp: {
    activateProject: jest.Mock;
    readFile: jest.Mock;
    getSymbolsOverview: jest.Mock;
    findSymbol: jest.Mock;
    replaceSymbolBody: jest.Mock;
    insertAfterSymbol: jest.Mock;
    insertBeforeSymbol: jest.Mock;
    renameSymbol: jest.Mock;
    safeDeleteSymbol: jest.Mock;
    createTextFile: jest.Mock;
  };
  let llmService: { getModel: jest.Mock; logTokenUsage: jest.Mock; getProviderKind: jest.Mock };
  const worktreePath = '/app/worktrees/mcp-test';

  const stateWith = (overrides: Partial<AgentState> = {}): AgentState =>
    ({
      implementationPlan: '### Step 1\nDo stuff.',
      researchContext: 'context',
      issuePayload: { worktreePath },
      patchMessages: [],
      ...overrides,
    }) as unknown as AgentState;

  beforeEach(async () => {
    serenaMcp = {
      activateProject: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockResolvedValue(mcpText('file contents here')),
      getSymbolsOverview: jest.fn().mockResolvedValue(
        mcpText('{"Function": ["handleRequest"]}'),
      ),
      findSymbol: jest.fn().mockResolvedValue(mcpText('[{"name": "handleRequest"}]')),
      replaceSymbolBody: jest.fn().mockResolvedValue(ok()),
      insertAfterSymbol: jest.fn().mockResolvedValue(ok()),
      insertBeforeSymbol: jest.fn().mockResolvedValue(ok()),
      renameSymbol: jest.fn().mockResolvedValue(ok()),
      safeDeleteSymbol: jest.fn().mockResolvedValue(ok()),
      createTextFile: jest.fn().mockResolvedValue(ok()),
    };

    llmService = {
      getModel: jest.fn(),
      logTokenUsage: jest.fn(),
      getProviderKind: jest.fn().mockReturnValue('openai'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PatchGeneratorAgent,
        { provide: LlmService, useValue: llmService },
        { provide: SerenaMcpService, useValue: serenaMcp },
      ],
    }).compile();

    agent = module.get(PatchGeneratorAgent);
    jest.clearAllMocks();
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.writeFile.mockResolvedValue(undefined);
    mockedFs.unlink.mockResolvedValue(undefined);
    mockedFs.access.mockResolvedValue(undefined);
  });

  afterEach(() => {
    agent.clearSession(worktreePath);
  });

  /** Sets up the LLM mock to return the given AIMessage responses in order. */
  const setLlmResponses = (...responses: AIMessage[]) => {
    const mockModel = new MockLlmModel(responses);
    llmService.getModel.mockReturnValue(mockModel);
  };

  // ─── Tool-level tests (via getToolsForSession) ───────────────────────

  describe('tools — read_file', () => {
    it('reads a file via Serena and adds the path to the session read set', async () => {
      const tools = agent.getToolsForSession(worktreePath);
      const readFile = tools.find((t) => t.name === 'read_file')!;

      const result = await readFile.invoke({ filePath: 'src/app.ts' });

      expect(serenaMcp.readFile).toHaveBeenCalledWith('src/app.ts');
      expect(result).toBe('file contents here');
      // Verify the path was recorded — edit tools should now accept it
      const replaceTool = tools.find((t) => t.name === 'replace_symbol_body')!;
      await replaceTool.invoke({
        filePath: 'src/app.ts',
        symbolName: 'handleRequest',
        newBody: 'function handleRequest() { return 1; }',
      });
      expect(serenaMcp.replaceSymbolBody).toHaveBeenCalledWith(
        'src/app.ts',
        'handleRequest',
        'function handleRequest() { return 1; }',
      );
    });

    it('returns an error message (does not throw) when Serena fails', async () => {
      serenaMcp.readFile.mockRejectedValue(new Error('ENOENT'));
      const tools = agent.getToolsForSession(worktreePath);
      const readFile = tools.find((t) => t.name === 'read_file')!;

      const result = await readFile.invoke({ filePath: 'src/missing.ts' });

      expect(result).toContain('Error reading "src/missing.ts"');
      expect(result).toContain('ENOENT');
    });
  });

  describe('tools — get_symbols_overview', () => {
    it('returns the symbol overview text', async () => {
      const tools = agent.getToolsForSession(worktreePath);
      const tool = tools.find((t) => t.name === 'get_symbols_overview')!;

      const result = await tool.invoke({ filePath: 'src/app.ts' });

      expect(serenaMcp.getSymbolsOverview).toHaveBeenCalledWith('src/app.ts');
      expect(result).toContain('handleRequest');
    });
  });

  describe('tools — find_symbol', () => {
    it('searches for a symbol with substring matching', async () => {
      const tools = agent.getToolsForSession(worktreePath);
      const tool = tools.find((t) => t.name === 'find_symbol')!;

      await tool.invoke({ namePattern: 'Home', filePath: 'app/page.tsx' });

      expect(serenaMcp.findSymbol).toHaveBeenCalledWith('Home', {
        relativePath: 'app/page.tsx',
        substringMatching: true,
      });
    });
  });

  // ─── Gate 1: read-before-edit ────────────────────────────────────────

  describe('Gate 1 — read-before-edit', () => {
    it('replace_symbol_body is rejected if the file was not read first', async () => {
      const tools = agent.getToolsForSession(worktreePath);
      const replaceTool = tools.find((t) => t.name === 'replace_symbol_body')!;

      const result = await replaceTool.invoke({
        filePath: 'src/app.ts',
        symbolName: 'handleRequest',
        newBody: 'function handleRequest() { return 1; }',
      });

      expect(result).toContain('must call read_file');
      expect(serenaMcp.replaceSymbolBody).not.toHaveBeenCalled();
    });

    it('insert_after_symbol is rejected if the file was not read first', async () => {
      const tools = agent.getToolsForSession(worktreePath);
      const tool = tools.find((t) => t.name === 'insert_after_symbol')!;

      const result = await tool.invoke({
        filePath: 'src/app.ts',
        symbolName: 'handleRequest',
        newBody: 'export const x = 1;',
      });

      expect(result).toContain('must call read_file');
      expect(serenaMcp.insertAfterSymbol).not.toHaveBeenCalled();
    });

    it('insert_before_symbol is rejected if the file was not read first', async () => {
      const tools = agent.getToolsForSession(worktreePath);
      const tool = tools.find((t) => t.name === 'insert_before_symbol')!;

      const result = await tool.invoke({
        filePath: 'src/app.ts',
        symbolName: 'handleRequest',
        newBody: 'export const x = 1;',
      });

      expect(result).toContain('must call read_file');
      expect(serenaMcp.insertBeforeSymbol).not.toHaveBeenCalled();
    });

    it('rename_symbol is rejected if the file was not read first', async () => {
      const tools = agent.getToolsForSession(worktreePath);
      const tool = tools.find((t) => t.name === 'rename_symbol')!;

      const result = await tool.invoke({
        filePath: 'src/app.ts',
        symbolName: 'oldName',
        newName: 'newName',
      });

      expect(result).toContain('must call read_file');
      expect(serenaMcp.renameSymbol).not.toHaveBeenCalled();
    });

    it('safe_delete_symbol is rejected if the file was not read first', async () => {
      const tools = agent.getToolsForSession(worktreePath);
      const tool = tools.find((t) => t.name === 'safe_delete_symbol')!;

      const result = await tool.invoke({
        filePath: 'src/app.ts',
        symbolName: 'deadCode',
      });

      expect(result).toContain('must call read_file');
      expect(serenaMcp.safeDeleteSymbol).not.toHaveBeenCalled();
    });

    it('replace_symbol_body succeeds after read_file registers the path', async () => {
      const tools = agent.getToolsForSession(worktreePath);
      const readFile = tools.find((t) => t.name === 'read_file')!;
      const replaceTool = tools.find((t) => t.name === 'replace_symbol_body')!;

      await readFile.invoke({ filePath: 'src/app.ts' });
      const result = await replaceTool.invoke({
        filePath: 'src/app.ts',
        symbolName: 'handleRequest',
        newBody: 'function handleRequest() { return 1; }',
      });

      expect(result).toContain('OK');
      expect(serenaMcp.replaceSymbolBody).toHaveBeenCalledWith(
        'src/app.ts',
        'handleRequest',
        'function handleRequest() { return 1; }',
      );
    });
  });

  // ─── Symbol-not-found self-correction ────────────────────────────────

  describe('symbol-not-found self-correction', () => {
    it('replace_symbol_body with a wrong name triggers find_symbol and returns a suggestion', async () => {
      serenaMcp.replaceSymbolBody.mockResolvedValue(
        mcpError('No symbol matching: Home'),
      );
      serenaMcp.findSymbol.mockResolvedValue(
        mcpText('[{"name": "HomePage", "relativePath": "app/page.tsx"}]'),
      );

      const tools = agent.getToolsForSession(worktreePath);
      const readFile = tools.find((t) => t.name === 'read_file')!;
      const replaceTool = tools.find((t) => t.name === 'replace_symbol_body')!;

      await readFile.invoke({ filePath: 'app/page.tsx' });
      const result = await replaceTool.invoke({
        filePath: 'app/page.tsx',
        symbolName: 'Home',
        newBody: 'export default function HomePage() { return null; }',
      });

      expect(result).toContain('No symbol matching');
      expect(result).toContain('HomePage');
      expect(result).toContain('Retry with the correct name');
      // find_symbol was called with the wrong name to produce the suggestion
      expect(serenaMcp.findSymbol).toHaveBeenCalledWith('Home', {
        relativePath: 'app/page.tsx',
        substringMatching: true,
      });
    });
  });

  // ─── Gate 2: create-rejects-existing ─────────────────────────────────

  describe('Gate 2 — create_text_file rejects existing files', () => {
    it('refuses to create a file that already exists', async () => {
      mockedFs.access.mockResolvedValue(undefined); // file exists

      const tools = agent.getToolsForSession(worktreePath);
      const createTool = tools.find((t) => t.name === 'create_text_file')!;

      const result = await createTool.invoke({
        filePath: 'src/existing.ts',
        content: 'export const x = 1;',
      });

      expect(result).toContain('already exists');
      expect(result).toContain('replace_symbol_body');
      expect(serenaMcp.createTextFile).not.toHaveBeenCalled();
    });

    it('creates a new file when the path does not exist', async () => {
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));

      const tools = agent.getToolsForSession(worktreePath);
      const createTool = tools.find((t) => t.name === 'create_text_file')!;

      const result = await createTool.invoke({
        filePath: 'src/new.ts',
        content: 'export const x = 1;',
      });

      expect(result).toContain('OK');
      expect(serenaMcp.createTextFile).toHaveBeenCalledWith(
        'src/new.ts',
        'export const x = 1;',
      );
    });

    it('falls back to direct filesystem write when Serena create_text_file fails', async () => {
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      serenaMcp.createTextFile.mockRejectedValue(new Error('mcp unavailable'));

      const tools = agent.getToolsForSession(worktreePath);
      const createTool = tools.find((t) => t.name === 'create_text_file')!;

      const result = await createTool.invoke({
        filePath: 'src/new.ts',
        content: 'export const x = 1;',
      });

      expect(result).toContain('OK');
      expect(result).toContain('direct filesystem write');
      expect(mockedFs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('src'),
        { recursive: true },
      );
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('src/new.ts'),
        'export const x = 1;',
        'utf8',
      );
    });
  });

  // ─── Restricted path guardrail ───────────────────────────────────────

  describe('restricted path guardrail', () => {
    it('read_file rejects path traversal outside the worktree', async () => {
      const tools = agent.getToolsForSession(worktreePath);
      const readFile = tools.find((t) => t.name === 'read_file')!;

      const result = await readFile.invoke({ filePath: '../../etc/passwd' });

      expect(result).toContain('Error');
      expect(serenaMcp.readFile).not.toHaveBeenCalled();
    });

    it('create_text_file rejects path traversal outside the worktree', async () => {
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      const tools = agent.getToolsForSession(worktreePath);
      const createTool = tools.find((t) => t.name === 'create_text_file')!;

      const result = await createTool.invoke({
        filePath: '../../etc/passwd',
        content: 'malicious',
      });

      expect(result).toContain('Error');
      expect(serenaMcp.createTextFile).not.toHaveBeenCalled();
    });
  });

  // ─── invoke() — LLM interaction ──────────────────────────────────────

  describe('invoke — LLM interaction', () => {
    it('throws a clear error without calling the LLM when there is no implementation plan', async () => {
      setLlmResponses(aiFinal('done'));

      // A missing plan can never be fixed by retrying this node — the plan
      // only comes from the planner upstream. Failing fast beats the old
      // silent {} return, which routed into an unrecoverable retry loop.
      await expect(agent.invoke({} as AgentState)).rejects.toThrow(
        'no implementation plan',
      );
      expect(llmService.getModel).not.toHaveBeenCalled();
    });

    it('returns {} when the state has no worktreePath', async () => {
      setLlmResponses(aiFinal('done'));
      const result = await agent.invoke({
        implementationPlan: 'plan',
        issuePayload: {},
      } as unknown as AgentState);

      expect(result).toEqual({});
      expect(llmService.getModel).not.toHaveBeenCalled();
    });

    it('on a fresh attempt, builds system+user prompts and calls the LLM', async () => {
      // Use a tool-call response so invoke() doesn't check appliedActions
      setLlmResponses(
        aiWithToolCalls([
          { name: 'read_file', args: { filePath: 'src/app.ts' }, id: 'tc1' },
        ]),
      );

      await agent.invoke(stateWith());

      expect(serenaMcp.activateProject).toHaveBeenCalledWith(worktreePath);
      expect(llmService.getModel).toHaveBeenCalledWith('patch_generator', undefined);
      const mockModel = llmService.getModel.mock.results[0].value;
      expect(mockModel.bindTools).toHaveBeenCalled();
    });

    it('returns patchMessages (no generatedPatch) when the LLM makes tool calls', async () => {
      setLlmResponses(
        aiWithToolCalls([
          { name: 'read_file', args: { filePath: 'src/app.ts' }, id: 'tc1' },
        ]),
      );

      const result = await agent.invoke(stateWith());

      expect(result.patchMessages).toBeDefined();
      expect(result.patchMessages).toHaveLength(3); // system + user + AI
      expect(result.generatedPatch).toBeUndefined();
      // The AIMessage in patchMessages should carry the tool_calls
      const aiMsg = result.patchMessages![2] as AIMessage;
      expect(aiMsg.tool_calls).toHaveLength(1);
    });

    it('returns generatedPatch when the LLM produces a final response and actions were applied', async () => {
      // Simulate: a previous tool call already applied a change (via a
      // prior patcher_tools execution). We set up the session with an
      // applied action, then invoke with a continuation patchMessages.
      const tools = agent.getToolsForSession(worktreePath);
      const createTool = tools.find((t) => t.name === 'create_text_file')!;
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      await createTool.invoke({ filePath: 'src/new.ts', content: 'x' });

      setLlmResponses(aiFinal('All changes applied successfully.'));

      // Continuation: patchMessages already has prior messages
      const priorMessages = [
        new SystemMessage('system'),
        new HumanMessage('user'),
      ];
      const result = await agent.invoke(
        stateWith({ patchMessages: priorMessages }),
      );

      expect(result.generatedPatch).toContain('CREATE src/new.ts');
      expect(result.unappliedChanges).toBe('');
      expect(result.messages).toBeDefined();
    });

    it('throws when the LLM produces a final response but no actions were applied', async () => {
      setLlmResponses(aiFinal('I did nothing.'));

      await expect(agent.invoke(stateWith())).rejects.toThrow(
        'No valid code changes applied',
      );
    });

    it('includes validation feedback in the user prompt on a fresh attempt', async () => {
      // Use a tool-call response so invoke() doesn't check appliedActions
      setLlmResponses(
        aiWithToolCalls([
          { name: 'read_file', args: { filePath: 'src/app.ts' }, id: 'tc1' },
        ]),
      );

      await agent.invoke(
        stateWith({ validationFeedback: 'TypeError in app.ts' }),
      );

      const mockModel = llmService.getModel.mock.results[0].value;
      const invokeArg = mockModel.invoke.mock.calls[0][0] as any[];
      const userMsg = invokeArg.find((m) => m._getType?.() === 'human');
      expect(userMsg.content).toContain('Previous Validation Feedback');
      expect(userMsg.content).toContain('TypeError in app.ts');
    });
  });

  // ─── Session management ──────────────────────────────────────────────

  describe('session management', () => {
    it('clearSession removes the session so gates reset on the next attempt', async () => {
      const tools = agent.getToolsForSession(worktreePath);
      const readFile = tools.find((t) => t.name === 'read_file')!;
      await readFile.invoke({ filePath: 'src/app.ts' });

      agent.clearSession(worktreePath);

      // After clearing, a new tool set should reject edits to src/app.ts
      const tools2 = agent.getToolsForSession(worktreePath);
      const replaceTool = tools2.find((t) => t.name === 'replace_symbol_body')!;
      const result = await replaceTool.invoke({
        filePath: 'src/app.ts',
        symbolName: 'handleRequest',
        newBody: 'x',
      });
      expect(result).toContain('must call read_file');
    });

    it('a fresh attempt (empty patchMessages) resets the session', async () => {
      // Read a file in a first session
      let tools = agent.getToolsForSession(worktreePath);
      const readFile = tools.find((t) => t.name === 'read_file')!;
      await readFile.invoke({ filePath: 'src/app.ts' });

      // Use a tool-call response so invoke() doesn't check appliedActions
      setLlmResponses(
        aiWithToolCalls([
          { name: 'read_file', args: { filePath: 'src/app.ts' }, id: 'tc1' },
        ]),
      );
      // Invoke with empty patchMessages → fresh attempt → session reset
      await agent.invoke(stateWith({ patchMessages: [] }));

      // After the fresh attempt, edits to src/app.ts should be blocked again
      tools = agent.getToolsForSession(worktreePath);
      const replaceTool = tools.find((t) => t.name === 'replace_symbol_body')!;
      const result = await replaceTool.invoke({
        filePath: 'src/app.ts',
        symbolName: 'handleRequest',
        newBody: 'x',
      });
      expect(result).toContain('must call read_file');
    });
  });
});

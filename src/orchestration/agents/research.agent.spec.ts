import { Test, TestingModule } from '@nestjs/testing';
import { ResearchAgent } from './research.agent';
import { LlmService } from '../llm.service';
import { SearchService } from '../../intelligence/search.service';
import { VectorDbService } from '../../intelligence/vector-db.service';
import { EmbeddingService } from '../../intelligence/embedding.service';
import { SerenaMcpService } from '../../intelligence/serena-mcp.service';
import { AIMessage, SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { AgentState } from '../graph.state';

/**
 * Helper: creates a mock LlmService whose getModel().bindTools().invoke()
 * returns a given AIMessage. The bindTools mock just returns the model
 * itself so invoke() can call it.
 */
function mockLlmService(response: AIMessage) {
  const modelWithTools = {
    invoke: jest.fn().mockResolvedValue(response),
    bindTools: jest.fn().mockReturnThis(),
  };
  return {
    getModel: jest.fn().mockReturnValue(modelWithTools),
    _modelWithTools: modelWithTools,
  };
}

/**
 * Covers the hybrid research agent's proactive memory injection: the
 * system prompt must always contain Serena memories (global_repo_structure
 * and, when enabled, historical_issues_and_lessons), read from the
 * persistent repoPath — not the ephemeral worktree.
 */
describe('ResearchAgent — proactive memory injection', () => {
  let agent: ResearchAgent;
  let serenaMcp: {
    readMemory: jest.Mock;
    activateProject: jest.Mock;
    getSymbolsOverview: jest.Mock;
  };
  let llmService: ReturnType<typeof mockLlmService>;

  const repoStructureMemory = {
    content: [
      {
        text: 'This is a Next.js (App Router) app using TypeScript and React.',
      },
    ],
    isError: false,
  };

  const stateWith = (overrides: Record<string, unknown> = {}): AgentState =>
    ({
      messages: [],
      issuePayload: {
        worktreePath: '/app/worktrees/mcp-test',
        repoPath: '/app/repo-cache/acme/widgets',
        issue: { title: 'Fix payment timeout', body: 'Payments time out after 30s' },
        repository: { full_name: 'acme/widgets' },
        ...overrides,
      },
    }) as unknown as AgentState;

  beforeEach(async () => {
    // Default LLM response: no tool calls → final summary
    llmService = mockLlmService(
      new AIMessage({ content: 'Research complete. Found the bug in http-client.ts' }),
    );

    serenaMcp = {
      readMemory: jest.fn().mockResolvedValue(repoStructureMemory),
      activateProject: jest.fn().mockResolvedValue(undefined),
      getSymbolsOverview: jest.fn().mockResolvedValue({ symbols: [] }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResearchAgent,
        { provide: LlmService, useValue: llmService },
        {
          provide: SearchService,
          useValue: { search: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: VectorDbService,
          useValue: { searchSimilar: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: EmbeddingService,
          useValue: { getEmbedding: jest.fn().mockResolvedValue([0.1]) },
        },
        { provide: SerenaMcpService, useValue: serenaMcp },
      ],
    }).compile();

    agent = module.get(ResearchAgent);
  });

  it('activates the persistent repoPath (not the ephemeral worktree) before reading memories', async () => {
    await agent.invoke(stateWith());

    const firstCall = serenaMcp.activateProject.mock.calls[0];
    expect(firstCall[0]).toBe('/app/repo-cache/acme/widgets');
  });

  it('reads global_repo_structure with only the memory name', async () => {
    await agent.invoke(stateWith());

    expect(serenaMcp.readMemory).toHaveBeenCalledWith('global_repo_structure');
    expect(serenaMcp.readMemory.mock.calls[0]).toHaveLength(1);
  });

  it('falls back to worktreePath for memory scoping when repoPath is missing', async () => {
    await agent.invoke(stateWith({ repoPath: undefined }));

    const firstCall = serenaMcp.activateProject.mock.calls[0];
    expect(firstCall[0]).toBe('/app/worktrees/mcp-test');
  });

  it('embeds the onboarding memory into the system prompt so the LLM sees it', async () => {
    await agent.invoke(stateWith());

    // The system prompt is the first injected message
    const invokeCall = llmService._modelWithTools.invoke.mock.calls[0];
    const messages = invokeCall[0];
    const systemPrompt = messages[0] as SystemMessage;
    expect(systemPrompt.content).toContain('Next.js');
    expect(systemPrompt.content).toContain('React');
  });

  it('does not throw when no memory exists yet', async () => {
    serenaMcp.readMemory.mockResolvedValue({ isError: true });

    const result = await agent.invoke(stateWith());

    // Should still produce a result — just without memory context
    expect(result).toBeDefined();
    const invokeCall = llmService._modelWithTools.invoke.mock.calls[0];
    const messages = invokeCall[0];
    const systemPrompt = messages[0] as SystemMessage;
    expect(systemPrompt.content).toContain('No Serena memories were available');
  });

  describe('historical_issues_and_lessons (only when ENABLE_SERENA_ISSUE_HISTORY=true)', () => {
    const originalEnv = process.env.ENABLE_SERENA_ISSUE_HISTORY;
    afterEach(() => {
      process.env.ENABLE_SERENA_ISSUE_HISTORY = originalEnv;
    });

    it('is not read at all when the feature flag is off', async () => {
      delete process.env.ENABLE_SERENA_ISSUE_HISTORY;

      await agent.invoke(stateWith());

      expect(serenaMcp.readMemory).not.toHaveBeenCalledWith(
        'historical_issues_and_lessons',
      );
    });

    it('is read and folded into the system prompt when the flag is on', async () => {
      process.env.ENABLE_SERENA_ISSUE_HISTORY = 'true';
      serenaMcp.readMemory.mockImplementation((name: string) => {
        if (name === 'historical_issues_and_lessons') {
          return Promise.resolve({
            isError: false,
            content: [
              {
                text: JSON.stringify({
                  entries: [
                    {
                      issue: 'Login button unresponsive',
                      solution: 'Fixed missing onClick handler',
                      lessons_learned: 'Always check event bindings first',
                    },
                  ],
                }),
              },
            ],
          });
        }
        return Promise.resolve(repoStructureMemory);
      });

      await agent.invoke(stateWith());

      const invokeCall = llmService._modelWithTools.invoke.mock.calls[0];
      const messages = invokeCall[0];
      const systemPrompt = messages[0] as SystemMessage;
      expect(systemPrompt.content).toContain('Lessons From Past Fixes');
      expect(systemPrompt.content).toContain('Login button unresponsive');
      expect(systemPrompt.content).toContain(
        'Always check event bindings first',
      );
    });

    it('caps the included lessons to the most recent entries', async () => {
      process.env.ENABLE_SERENA_ISSUE_HISTORY = 'true';
      const entries = Array.from({ length: 8 }, (_, i) => ({
        issue: `Issue ${i}`,
        solution: `Solution ${i}`,
        lessons_learned: `Lesson ${i}`,
      }));
      serenaMcp.readMemory.mockImplementation((name: string) => {
        if (name === 'historical_issues_and_lessons') {
          return Promise.resolve({
            isError: false,
            content: [{ text: JSON.stringify({ entries }) }],
          });
        }
        return Promise.resolve(repoStructureMemory);
      });

      await agent.invoke(stateWith());

      const invokeCall = llmService._modelWithTools.invoke.mock.calls[0];
      const messages = invokeCall[0];
      const systemPrompt = messages[0] as SystemMessage;
      expect(systemPrompt.content).not.toContain('Issue 0');
      expect(systemPrompt.content).toContain('Issue 7');
    });

    it('does not throw when the memory content is malformed JSON', async () => {
      process.env.ENABLE_SERENA_ISSUE_HISTORY = 'true';
      serenaMcp.readMemory.mockImplementation((name: string) => {
        if (name === 'historical_issues_and_lessons') {
          return Promise.resolve({
            isError: false,
            content: [{ text: 'not valid json' }],
          });
        }
        return Promise.resolve(repoStructureMemory);
      });

      const result = await agent.invoke(stateWith());

      expect(result).toBeDefined();
      const invokeCall = llmService._modelWithTools.invoke.mock.calls[0];
      const messages = invokeCall[0];
      const systemPrompt = messages[0] as SystemMessage;
      expect(systemPrompt.content).not.toContain('Lessons From Past Fixes');
    });
  });
});

/**
 * Covers the ReAct tool loop: when the LLM returns tool_calls, the agent
 * returns them in messages (for the ToolNode to execute) without setting
 * researchContext. When it returns a final summary, researchContext is set.
 */
describe('ResearchAgent — ReAct tool loop routing', () => {
  let agent: ResearchAgent;
  let llmService: ReturnType<typeof mockLlmService>;

  const stateWith = (): AgentState =>
    ({
      messages: [],
      issuePayload: {
        worktreePath: '/app/worktrees/mcp-test',
        repoPath: '/app/repo-cache/acme/widgets',
        issue: { title: 'Fix payment timeout', body: 'Payments time out after 30s' },
        repository: { full_name: 'acme/widgets' },
      },
    }) as unknown as AgentState;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResearchAgent,
        { provide: LlmService, useValue: {} },
        {
          provide: SearchService,
          useValue: { search: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: VectorDbService,
          useValue: { searchSimilar: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: EmbeddingService,
          useValue: { getEmbedding: jest.fn().mockResolvedValue([0.1]) },
        },
        {
          provide: SerenaMcpService,
          useValue: {
            readMemory: jest.fn().mockResolvedValue(null),
            activateProject: jest.fn().mockResolvedValue(undefined),
            getSymbolsOverview: jest.fn().mockResolvedValue({ symbols: [] }),
          },
        },
      ],
    }).compile();

    agent = module.get(ResearchAgent);
  });

  it('returns tool_calls in messages (for ToolNode) when the LLM wants to search', async () => {
    llmService = mockLlmService(
      new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            name: 'search_codebase',
            args: { query: 'payment timeout', repoFullName: 'acme/widgets' },
          },
        ],
      }),
    );
    // Re-inject the mock LlmService
    (agent as any).llmService = llmService;

    const result = await agent.invoke(stateWith());

    // researchContext should NOT be set — the loop continues
    expect(result.researchContext).toBeUndefined();
    // The AIMessage with tool_calls should be in messages
    const lastMsg = result.messages?.[result.messages.length - 1] as AIMessage;
    expect(lastMsg.tool_calls).toHaveLength(1);
    expect(lastMsg.tool_calls[0].name).toBe('search_codebase');
  });

  it('sets researchContext when the LLM produces a final summary (no tool calls)', async () => {
    llmService = mockLlmService(
      new AIMessage({
        content:
          'Found the bug in src/http-client.ts: fetchWithTimeout has a hardcoded 30s timeout.',
      }),
    );
    (agent as any).llmService = llmService;

    const result = await agent.invoke(stateWith());

    expect(result.researchContext).toContain('http-client.ts');
  });
});

/**
 * Covers the getTools() method directly — verifies the repoPath fix for
 * read_serena_memory and the non-symbolic file skip for get_file_symbols.
 */
describe('ResearchAgent — getTools', () => {
  let agent: ResearchAgent;
  let serenaMcp: {
    readMemory: jest.Mock;
    activateProject: jest.Mock;
    getSymbolsOverview: jest.Mock;
  };
  let searchService: { search: jest.Mock };
  let vectorDbService: { searchSimilar: jest.Mock };

  beforeEach(async () => {
    serenaMcp = {
      readMemory: jest.fn().mockResolvedValue({
        content: [{ text: 'memory content' }],
        isError: false,
      }),
      activateProject: jest.fn().mockResolvedValue(undefined),
      getSymbolsOverview: jest.fn().mockResolvedValue({ symbols: [] }),
    };
    searchService = { search: jest.fn().mockResolvedValue([]) };
    vectorDbService = { searchSimilar: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResearchAgent,
        { provide: LlmService, useValue: {} },
        { provide: SearchService, useValue: searchService },
        { provide: VectorDbService, useValue: vectorDbService },
        {
          provide: EmbeddingService,
          useValue: { getEmbedding: jest.fn().mockResolvedValue([0.1]) },
        },
        { provide: SerenaMcpService, useValue: serenaMcp },
      ],
    }).compile();

    agent = module.get(ResearchAgent);
  });

  describe('read_serena_memory tool', () => {
    it('uses repoPath (persistent clone) for memory reads, not worktreePath', async () => {
      const tools = agent.getTools(
        '/app/worktrees/mcp-test',
        '/app/repo-cache/acme/widgets',
      );
      const readMemoryTool = tools.find((t) => t.name === 'read_serena_memory');

      await readMemoryTool.invoke({ memoryName: 'global_repo_structure' });

      // activateProject must have been called with repoPath
      expect(serenaMcp.activateProject).toHaveBeenCalledWith(
        '/app/repo-cache/acme/widgets',
      );
    });

    it('falls back to worktreePath when repoPath is not provided', async () => {
      const tools = agent.getTools('/app/worktrees/mcp-test');
      const readMemoryTool = tools.find((t) => t.name === 'read_serena_memory');

      await readMemoryTool.invoke({ memoryName: 'global_repo_structure' });

      expect(serenaMcp.activateProject).toHaveBeenCalledWith(
        '/app/worktrees/mcp-test',
      );
    });
  });

  describe('get_file_symbols tool', () => {
    it.each([
      'public/questions.json',
      'notes.md',
      'config.yaml',
      'package-lock.lock',
    ])(
      'skips get_symbols_overview for %s and returns a helpful message',
      async (filePath) => {
        const tools = agent.getTools('/app/worktrees/mcp-test');
        const getSymbolsTool = tools.find((t) => t.name === 'get_file_symbols');

        const result = await getSymbolsTool.invoke({ filePath });

        expect(serenaMcp.getSymbolsOverview).not.toHaveBeenCalled();
        expect(result).toContain('non-code file');
      },
    );

    it('still calls get_symbols_overview for an actual code file', async (filePath = 'src/components/GuestRoute.tsx') => {
      const tools = agent.getTools('/app/worktrees/mcp-test');
      const getSymbolsTool = tools.find((t) => t.name === 'get_file_symbols');

      await getSymbolsTool.invoke({ filePath });

      expect(serenaMcp.getSymbolsOverview).toHaveBeenCalledWith(filePath);
    });
  });

  describe('search_codebase tool', () => {
    it('falls back to ripgrep when vector search returns nothing', async () => {
      vectorDbService.searchSimilar.mockResolvedValue([]);
      const tools = agent.getTools('/app/worktrees/mcp-test');
      const searchTool = tools.find((t) => t.name === 'search_codebase');

      const result = await searchTool.invoke({
        query: 'payment timeout',
        repoFullName: 'acme/widgets',
      });

      expect(searchService.search).toHaveBeenCalled();
      expect(result).toBe('[]');
    });

    it('returns vector search results when available', async () => {
      vectorDbService.searchSimilar.mockResolvedValue([
        { payload: { filePath: 'src/payment.ts' }, id: '1' },
      ]);
      const tools = agent.getTools('/app/worktrees/mcp-test');
      const searchTool = tools.find((t) => t.name === 'search_codebase');

      const result = await searchTool.invoke({
        query: 'payment',
        repoFullName: 'acme/widgets',
      });

      expect(searchService.search).not.toHaveBeenCalled();
      expect(result).toContain('payment.ts');
    });
  });
});

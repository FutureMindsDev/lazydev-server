import { Test, TestingModule } from '@nestjs/testing';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { PlannerAgent } from './planner.agent';
import { LlmService } from '../llm.service';
import { SearchService } from '../../intelligence/search.service';
import { VectorDbService } from '../../intelligence/vector-db.service';
import { EmbeddingService } from '../../intelligence/embedding.service';
import { SerenaMcpService } from '../../intelligence/serena-mcp.service';
import type { AgentState } from '../graph.state';

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

/** Builds an AIMessage with no tool calls (simulating the LLM's final plan). */
const aiFinal = (content: string) => new AIMessage({ content, tool_calls: [] });

/**
 * Simulates a DeepSeek thinking-mode response whose entire output is
 * reasoning_content — the `content` body comes back empty. This exact shape
 * produced the empty-plan death spiral in production: the planner accepted
 * it as "the final plan", the patcher got a falsy implementationPlan, and
 * the validator's retry edge looped until GraphRecursionError.
 */
const aiReasoningOnly = (reasoning = 'internal reasoning text') =>
  new AIMessage({
    content: '',
    tool_calls: [],
    additional_kwargs: { reasoning_content: reasoning },
  });

describe('PlannerAgent', () => {
  let agent: PlannerAgent;
  let llmService: {
    getModel: jest.Mock;
    logTokenUsage: jest.Mock;
    getProviderKind: jest.Mock;
  };
  let serenaMcp: {
    activateProject: jest.Mock;
    readMemory: jest.Mock;
    getSymbolsOverview: jest.Mock;
    findSymbol: jest.Mock;
  };
  let model: MockLlmModel;
  let originalHistoryFlag: string | undefined;

  const worktreePath = '/app/worktrees/mcp-test';

  const issuePayload = {
    worktreePath,
    repoPath: '/app/repo-cache/acme/widgets',
    issue: { number: 4, title: 'Bug: X crashes', body: 'It crashes' },
    repository: { full_name: 'acme/widgets' },
  };

  /** State as the planner node receives it on its first visit. */
  const freshState = (): AgentState =>
    ({ issuePayload }) as unknown as AgentState;

  /** State as the planner node receives it when returning from planner_tools. */
  const midLoopState = (messages: unknown[]): AgentState =>
    ({
      issuePayload,
      plannerMessages: messages,
    }) as unknown as AgentState;

  beforeEach(async () => {
    llmService = {
      getModel: jest.fn(),
      logTokenUsage: jest.fn(),
      getProviderKind: jest.fn().mockReturnValue('openai'),
    };
    serenaMcp = {
      activateProject: jest.fn().mockResolvedValue(undefined),
      readMemory: jest.fn().mockResolvedValue(null),
      getSymbolsOverview: jest.fn().mockResolvedValue({}),
      findSymbol: jest.fn().mockResolvedValue({}),
    };
    // Deterministic: never run the optional lessons-memory branch.
    originalHistoryFlag = process.env.ENABLE_SERENA_ISSUE_HISTORY;
    process.env.ENABLE_SERENA_ISSUE_HISTORY = 'false';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlannerAgent,
        { provide: LlmService, useValue: llmService },
        { provide: SearchService, useValue: { search: jest.fn() } },
        { provide: VectorDbService, useValue: { searchSimilar: jest.fn() } },
        { provide: EmbeddingService, useValue: { getEmbedding: jest.fn() } },
        { provide: SerenaMcpService, useValue: serenaMcp },
      ],
    }).compile();

    agent = module.get(PlannerAgent);
  });

  afterEach(() => {
    process.env.ENABLE_SERENA_ISSUE_HISTORY = originalHistoryFlag;
  });

  /** Sets up the LLM mock to return the given AIMessage responses in order. */
  const setLlmResponses = (...responses: AIMessage[]) => {
    model = new MockLlmModel(responses);
    llmService.getModel.mockReturnValue(model);
  };

  describe('invoke — normal tool loop', () => {
    it('routes tool calls back to the graph without setting implementationPlan', async () => {
      setLlmResponses(
        aiWithToolCalls([
          { name: 'list_dir', id: 't1', args: { dirPath: '.' } },
        ]),
      );

      const result = await agent.invoke(freshState());

      expect(result.implementationPlan).toBeUndefined();
      // system + user + the tool-calling AIMessage
      expect(result.plannerMessages).toHaveLength(3);
    });

    it('returns the final plan and resets the patcher conversation', async () => {
      setLlmResponses(aiFinal('### Step 1\nFix the handler.'));

      const result = await agent.invoke(freshState());

      expect(result.implementationPlan).toBe('### Step 1\nFix the handler.');
      expect(result.patchMessages).toEqual([]);
    });
  });

  describe('invoke — empty-plan guard (reasoning-only responses)', () => {
    it('re-prompts and recovers the plan when the final response has empty content', async () => {
      setLlmResponses(
        aiReasoningOnly(),
        aiFinal('### Step 1\nFix the handler.'),
      );

      const result = await agent.invoke(freshState());

      expect(result.implementationPlan).toBe('### Step 1\nFix the handler.');
      expect(model.invoke).toHaveBeenCalledTimes(2);

      // The re-prompt invocation must end with a user-turn nudge asking for
      // the plan — not a bare replay of the same messages.
      const secondCallArgs = model.invoke.mock.calls[1] as unknown[];
      const secondMessages = secondCallArgs[0] as unknown[];
      const last = secondMessages[secondMessages.length - 1] as HumanMessage;
      expect(last.content).toContain('implementation plan');

      // The persisted history carries: system, user, the empty response,
      // the nudge, and the final answer.
      expect(result.plannerMessages).toHaveLength(5);
    });

    it('throws a clear error instead of returning an empty plan when re-prompts stay empty', async () => {
      setLlmResponses(aiReasoningOnly(), aiReasoningOnly(), aiReasoningOnly());

      await expect(agent.invoke(freshState())).rejects.toThrow(
        'failed to produce an implementation plan',
      );
      // 1 original invocation + 2 bounded re-prompts.
      expect(model.invoke).toHaveBeenCalledTimes(3);
    });

    it('treats whitespace-only content as no plan and re-prompts', async () => {
      setLlmResponses(
        new AIMessage({ content: '   \n  ', tool_calls: [] }),
        aiFinal('plan text'),
      );

      const result = await agent.invoke(freshState());

      expect(result.implementationPlan).toBe('plan text');
      expect(model.invoke).toHaveBeenCalledTimes(2);
    });

    it('re-prompts when the unbound over-cap model still returns tool calls', async () => {
      // 51 messages puts the planner over its soft cap → tools are unbound.
      const history = Array.from(
        { length: 51 },
        (_, i) => new HumanMessage(`m${i}`),
      );
      setLlmResponses(
        aiWithToolCalls([
          { name: 'read_code_file', id: 't1', args: { filePath: 'a.ts' } },
        ]),
        aiFinal('### Step 1\nFix it.'),
      );

      const result = await agent.invoke(midLoopState(history));

      expect(result.implementationPlan).toBe('### Step 1\nFix it.');
      expect(model.invoke).toHaveBeenCalledTimes(2);
      // Tools are bound exactly once (pre-loop); the over-cap and re-prompt
      // invocations all use the bare model.
      expect(model.bindTools).toHaveBeenCalledTimes(1);

      // The hallucinated tool-call response must be replayed without its
      // tool_calls — replaying tool_calls with no matching ToolMessage
      // results is a 400 on OpenAI/DeepSeek.
      const replayed = result.plannerMessages![51] as AIMessage;
      expect(replayed.tool_calls ?? []).toHaveLength(0);
    });
  });
});

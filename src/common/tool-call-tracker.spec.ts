/* eslint-disable */
import { AIMessage, SystemMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  argsHash,
  toolCallKey,
  extractToolCallsFromLastAIMessage,
  buildToolCallWindow,
  checkDispatch,
  createRefusalToolMessage,
  checkBatchDispatch,
  DispatchCheckerConfig,
} from './tool-call-tracker';

describe('tool-call-tracker', () => {
  describe('argsHash', () => {
    it('produces the same hash regardless of arg key order', () => {
      const h1 = argsHash({ filePath: 'a.ts', offset: 10 });
      const h2 = argsHash({ offset: 10, filePath: 'a.ts' });
      expect(h1).toBe(h2);
    });

    it('produces different hashes for different args', () => {
      const h1 = argsHash({ filePath: 'a.ts' });
      const h2 = argsHash({ filePath: 'b.ts' });
      expect(h1).not.toBe(h2);
    });
  });

  describe('toolCallKey', () => {
    it('includes tool name in the key', () => {
      const k1 = toolCallKey('read_file', { filePath: 'a.ts' });
      const k2 = toolCallKey('find_symbol', { filePath: 'a.ts' });
      expect(k1).not.toBe(k2);
    });
  });

  describe('extractToolCallsFromLastAIMessage', () => {
    it('returns tool calls from the last AIMessage', () => {
      const messages = [
        new AIMessage({
          content: '',
          tool_calls: [{ id: '1', name: 'read_file', args: { filePath: 'a.ts' } }],
        }),
        new AIMessage({
          content: '',
          tool_calls: [{ id: '2', name: 'find_symbol', args: { namePattern: 'Bar' } }],
        }),
      ];
      const calls = extractToolCallsFromLastAIMessage(messages);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('find_symbol');
      expect(calls[0].id).toBe('2');
    });

    it('returns empty array if last AIMessage has no tool calls', () => {
      const messages = [
        new AIMessage({
          content: '',
          tool_calls: [{ id: '1', name: 'read_file', args: { filePath: 'a.ts' } }],
        }),
        new AIMessage('Final plan text'),
      ];
      const calls = extractToolCallsFromLastAIMessage(messages);
      expect(calls).toHaveLength(0);
    });

    it('returns empty array if no AIMessages exist', () => {
      const messages = [new HumanMessage('hello')];
      const calls = extractToolCallsFromLastAIMessage(messages);
      expect(calls).toHaveLength(0);
    });
  });

  describe('buildToolCallWindow', () => {
    it('collects all tool calls from all AIMessages', () => {
      const messages = [
        new AIMessage({
          content: '',
          tool_calls: [
            { id: '1', name: 'read_file', args: { filePath: 'a.ts' } },
            { id: '2', name: 'find_symbol', args: { namePattern: 'Foo' } },
          ],
        }),
        new HumanMessage('not relevant'),
        new AIMessage({
          content: '',
          tool_calls: [{ id: '3', name: 'read_file', args: { filePath: 'b.ts' } }],
        }),
      ];
      const window = buildToolCallWindow(messages);
      expect(window).toHaveLength(3);
      expect(window[0].toolName).toBe('read_file');
      expect(window[2].toolName).toBe('read_file');
    });

    it('returns empty array for messages with no tool calls', () => {
      const messages = [new HumanMessage('hello'), new SystemMessage('sys')];
      const window = buildToolCallWindow(messages);
      expect(window).toHaveLength(0);
    });
  });

  describe('checkDispatch', () => {
    it('returns null for a call not seen before', () => {
      const window = [
        { toolName: 'read_file', argsHash: argsHash({ filePath: 'a.ts' }), timestamp: 0 },
      ];
      const refusal = checkDispatch('read_file', { filePath: 'b.ts' }, window);
      expect(refusal).toBeNull();
    });

    it('returns a generic_repeat refusal for a duplicate call', () => {
      const window = [
        { toolName: 'read_file', argsHash: argsHash({ filePath: 'a.ts' }), timestamp: 0 },
        { toolName: 'read_file', argsHash: argsHash({ filePath: 'a.ts' }), timestamp: 1 },
      ];
      const refusal = checkDispatch('read_file', { filePath: 'a.ts' }, window, {
        maxRepeatPerTool: 1,
      });
      expect(refusal).not.toBeNull();
      expect(refusal!.mode).toBe('generic_repeat');
      expect(refusal!.toolName).toBe('read_file');
      expect(refusal!.message).toContain('already called');
    });

    it('returns a global_breaker refusal when total calls exceed cap', () => {
      const window = Array.from({ length: 5 }, (_, i) => ({
        toolName: `tool_${i}`,
        argsHash: `hash_${i}`,
        timestamp: i,
      }));
      const refusal = checkDispatch('new_tool', { arg: 'val' }, window, {
        maxTotalCalls: 5,
      });
      expect(refusal).not.toBeNull();
      expect(refusal!.mode).toBe('global_breaker');
    });

    it('allows the first call with maxRepeatPerTool=1', () => {
      // Empty window — first call, no prior history
      const refusal = checkDispatch('read_file', { filePath: 'a.ts' }, [], {
        maxRepeatPerTool: 1,
      });
      expect(refusal).toBeNull();
    });

    it('refuses the second identical call with maxRepeatPerTool=1', () => {
      const window = [
        { toolName: 'read_file', argsHash: argsHash({ filePath: 'a.ts' }), timestamp: 0 },
      ];
      // Second call with same args — priorCount=1, maxRepeat=1, 1 >= 1 is true
      const refusal = checkDispatch('read_file', { filePath: 'a.ts' }, window, {
        maxRepeatPerTool: 1,
      });
      expect(refusal).not.toBeNull();
      expect(refusal!.mode).toBe('generic_repeat');
    });
  });

  describe('createRefusalToolMessage', () => {
    it('creates a ToolMessage with the refusal message', () => {
      const msg = createRefusalToolMessage('call-123', 'read_file', {
        mode: 'generic_repeat',
        toolName: 'read_file',
        message: 'You already called this.',
      });
      expect(msg).toBeInstanceOf(ToolMessage);
      expect(msg.tool_call_id).toBe('call-123');
      expect(msg.content).toBe('You already called this.');
      expect(msg.name).toBe('read_file');
    });
  });

  describe('checkBatchDispatch', () => {
    it('refuses duplicate calls and allows unique calls', () => {
      // Two AIMessages: first calls read_file(a.ts), second calls read_file(a.ts) + read_file(b.ts)
      const messages = [
        new AIMessage({
          content: '',
          tool_calls: [{ id: '1', name: 'read_file', args: { filePath: 'a.ts' } }],
        }),
        new AIMessage({
          content: '',
          tool_calls: [
            { id: '2', name: 'read_file', args: { filePath: 'a.ts' } }, // repeat
            { id: '3', name: 'read_file', args: { filePath: 'b.ts' } }, // new
          ],
        }),
      ];
      const { refusals, allowedCallIds } = checkBatchDispatch(messages, {
        maxRepeatPerTool: 1,
      });
      expect(refusals.size).toBe(1);
      expect(refusals.has('2')).toBe(true);
      expect(allowedCallIds.size).toBe(1);
      expect(allowedCallIds.has('3')).toBe(true);
    });

    it('refuses all calls when all are duplicates', () => {
      const messages = [
        new AIMessage({
          content: '',
          tool_calls: [{ id: '1', name: 'read_file', args: { filePath: 'a.ts' } }],
        }),
        new AIMessage({
          content: '',
          tool_calls: [
            { id: '2', name: 'read_file', args: { filePath: 'a.ts' } },
            { id: '3', name: 'read_file', args: { filePath: 'a.ts' } },
          ],
        }),
      ];
      const { refusals, allowedCallIds } = checkBatchDispatch(messages, {
        maxRepeatPerTool: 1,
      });
      expect(refusals.size).toBe(2);
      expect(allowedCallIds.size).toBe(0);
    });

    it('allows all calls when none are duplicates', () => {
      const messages = [
        new AIMessage({
          content: '',
          tool_calls: [
            { id: '1', name: 'read_file', args: { filePath: 'a.ts' } },
            { id: '2', name: 'find_symbol', args: { namePattern: 'Foo' } },
          ],
        }),
      ];
      const { refusals, allowedCallIds } = checkBatchDispatch(messages, {
        maxRepeatPerTool: 1,
      });
      expect(refusals.size).toBe(0);
      expect(allowedCallIds.size).toBe(2);
    });
  });
});

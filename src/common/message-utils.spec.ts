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

import { AIMessage } from '@langchain/core/messages';
import { cloneAIMessageWithToolCalls } from './message-utils';

describe('cloneAIMessageWithToolCalls', () => {
  const toolCalls = [
    { name: 'read_file', args: { filePath: 'a.ts' }, id: 'call_1' },
    { name: 'read_file', args: { filePath: 'b.ts' }, id: 'call_2' },
  ];

  it('preserves provider metadata while filtering tool calls', () => {
    const original = new AIMessage({
      content: 'calling tools',
      tool_calls: toolCalls,
      additional_kwargs: {
        reasoning_content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
            extra_content: { google: { thought_signature: 'SIG_1' } },
          },
        ],
      },
      response_metadata: { model_provider: 'deepseek' },
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
      },
      id: 'msg-1',
      name: 'patcher',
    });

    const cloned = cloneAIMessageWithToolCalls(original, [toolCalls[0]]);

    expect(cloned).toBeInstanceOf(AIMessage);
    expect(cloned).not.toBe(original);
    expect(cloned.content).toBe('calling tools');
    expect(cloned.tool_calls).toEqual([toolCalls[0]]);
    expect(cloned.additional_kwargs).toEqual(original.additional_kwargs);
    expect(cloned.response_metadata).toEqual(original.response_metadata);
    expect(cloned.usage_metadata).toEqual(original.usage_metadata);
    expect(cloned.id).toBe('msg-1');
    expect(cloned.name).toBe('patcher');
  });

  it('preserves additional_kwargs with no reasoning_content (other providers)', () => {
    const original = new AIMessage({
      content: '',
      tool_calls: toolCalls,
      additional_kwargs: { function_call: undefined },
    });

    const cloned = cloneAIMessageWithToolCalls(original, toolCalls);

    expect(cloned.additional_kwargs).toEqual(original.additional_kwargs);
    expect(cloned.additional_kwargs.reasoning_content).toBeUndefined();
  });
});

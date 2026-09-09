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
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  stripDsmlTokens,
  stripThinkTokens,
  ensureEndsWithUserTurn,
} from './llm-guards';

describe('llm-guards', () => {
  describe('stripDsmlTokens', () => {
    it('returns text unchanged when no fullwidth-bar markup is present', () => {
      const text = 'Step 1: modify auth-provider.ts\nStep 2: update tests';
      expect(stripDsmlTokens(text)).toBe(text);
    });

    it('returns empty/undefined-ish input unchanged', () => {
      expect(stripDsmlTokens('')).toBe('');
    });

    it('strips complete single-bar DSML blocks (DeepSeek V4 format)', () => {
      const text =
        'Here is the plan.\n' +
        '<｜DSML｜tool_calls｜begin｜><｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path">a.ts</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls｜end｜>\n' +
        'Step 1: do the thing.';
      const out = stripDsmlTokens(text);
      expect(out).not.toContain('DSML');
      expect(out).not.toContain('｜');
      expect(out).toContain('Here is the plan.');
      expect(out).toContain('Step 1: do the thing.');
    });

    it('strips complete double-bar DSML blocks (legacy V3.2 format)', () => {
      const text =
        'Plan intro\n<｜｜DSML｜｜some leaked payload</｜｜DSML｜｜>\nPlan outro';
      const out = stripDsmlTokens(text);
      // The block is removed; surrounding whitespace (the newlines that
      // framed it) remains, which is harmless for prompt text.
      expect(out).not.toContain('DSML');
      expect(out).not.toContain('｜');
      expect(out).toContain('Plan intro');
      expect(out).toContain('Plan outro');
    });

    it('strips multiple complete blocks independently', () => {
      const text =
        'A<｜DSML｜invoke name="x">1</｜DSML｜invoke>B' +
        '<｜DSML｜invoke name="y">2</｜DSML｜invoke>C';
      expect(stripDsmlTokens(text)).toBe('ABC');
    });

    it('strips stray unbalanced tags left behind', () => {
      const text = 'Plan.\n<｜DSML｜invoke name="terminal"><｜DSML｜parameter name="command">ls</｜DSML｜parameter>';
      const out = stripDsmlTokens(text);
      expect(out).toBe('Plan.\n');
    });
  });

  describe('stripThinkTokens', () => {
    // Built by concatenation so the raw reasoning tag never appears as a
    // bare literal in this spec file.
    const OPEN = '<' + 'think' + '>';
    const CLOSE = '</' + 'think' + '>';

    it('returns text unchanged when no reasoning markup is present', () => {
      const text = 'Step 1: modify auth-provider.ts\nStep 2: update tests';
      expect(stripThinkTokens(text)).toBe(text);
    });

    it('returns empty/undefined-ish input unchanged', () => {
      expect(stripThinkTokens('')).toBe('');
    });

    it('strips complete blocks (MiniMax M2.x interleaved thinking)', () => {
      const text =
        OPEN + 'Let me look at the auth module.' + CLOSE +
        '\nThe plan:\nStep 1: fix the token refresh.';
      const out = stripThinkTokens(text);
      expect(out).not.toContain(OPEN);
      expect(out).toContain('The plan:');
      expect(out).toContain('Step 1: fix the token refresh.');
    });

    it('strips an unterminated block (truncated response)', () => {
      const text = OPEN + 'half a reasoning trace that never';
      const out = stripThinkTokens(text);
      expect(out).toBe('');
    });

    it('strips multiple blocks independently', () => {
      const text = 'A' + OPEN + '1' + CLOSE + 'B' + OPEN + '2' + CLOSE + 'C';
      const out = stripThinkTokens(text);
      expect(out).toBe('ABC');
    });

    it('is a no-op for plain text that merely mentions thinking', () => {
      const text = 'I think this approach is better.';
      expect(stripThinkTokens(text)).toBe(text);
    });
  });

  describe('ensureEndsWithUserTurn', () => {
    it('appends a user turn after a text-only assistant tail', () => {
      const messages = [
        new HumanMessage('fix it'),
        new AIMessage('I would do X.'),
      ];
      const out = ensureEndsWithUserTurn(messages) as any[];
      expect(out).toHaveLength(3);
      expect(out[2]).toBeInstanceOf(HumanMessage);
    });

    it('leaves tool-call assistant tails alone (tool results follow in real loops)', () => {
      const messages = [
        new HumanMessage('fix it'),
        new AIMessage({
          content: '',
          tool_calls: [{ name: 'read_file', args: { path: 'a' }, id: 'c1' }],
        }),
      ];
      expect(ensureEndsWithUserTurn(messages)).toBe(messages);
    });

    it('leaves ToolMessage tails alone (they map to user-role turns)', () => {
      const messages = [
        new HumanMessage('fix it'),
        new AIMessage({
          content: '',
          tool_calls: [{ name: 'read_file', args: { path: 'a' }, id: 'c1' }],
        }),
        new ToolMessage({ content: 'file contents', tool_call_id: 'c1' }),
      ];
      expect(ensureEndsWithUserTurn(messages)).toBe(messages);
    });

    it('leaves human/system tails alone', () => {
      const messages = [new HumanMessage('fix it')];
      expect(ensureEndsWithUserTurn(messages)).toBe(messages);
    });
  });
});

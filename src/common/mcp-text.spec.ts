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

import { extractMcpText } from './mcp-text';

describe('extractMcpText', () => {
  it('extracts text from a successful MCP content array', () => {
    expect(
      extractMcpText({
        isError: false,
        content: [{ text: 'hello' }, { text: ' world' }],
      }),
    ).toBe('hello world');
  });

  it('returns the string as-is if the result is already a plain string', () => {
    expect(extractMcpText('plain text')).toBe('plain text');
  });

  it('returns null for an error result', () => {
    expect(
      extractMcpText({ isError: true, content: [{ text: 'nope' }] }),
    ).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(extractMcpText(null)).toBeNull();
    expect(extractMcpText(undefined)).toBeNull();
  });

  it('returns null when there is no content array', () => {
    expect(extractMcpText({ isError: false })).toBeNull();
  });

  it('treats a missing text field on a content entry as an empty string', () => {
    expect(
      extractMcpText({ isError: false, content: [{}, { text: 'x' }] }),
    ).toBe('x');
  });
});

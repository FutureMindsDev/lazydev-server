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

import { formatLessonsEntries } from './lessons-learned-formatter';

const readResultWith = (entries: unknown[]) => ({
  isError: false,
  content: [{ text: JSON.stringify({ entries }) }],
});

describe('formatLessonsEntries', () => {
  it('formats entries as a numbered list', () => {
    const text = formatLessonsEntries(
      readResultWith([
        {
          issue: 'Login broken',
          solution: 'Fixed handler',
          lessons_learned: 'Check bindings',
        },
      ]),
    );

    expect(text).toContain('1. Issue: Login broken');
    expect(text).toContain('Solution: Fixed handler');
    expect(text).toContain('Lesson: Check bindings');
  });

  it('returns null for an error result', () => {
    expect(formatLessonsEntries({ isError: true })).toBeNull();
  });

  it('returns null when there are no entries', () => {
    expect(formatLessonsEntries(readResultWith([]))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(
      formatLessonsEntries({ isError: false, content: [{ text: 'not json' }] }),
    ).toBeNull();
  });

  it('defaults to uncapped — includes every entry', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      issue: `Issue ${i}`,
      solution: 's',
      lessons_learned: 'l',
    }));

    const text = formatLessonsEntries(readResultWith(entries));

    expect(text).toContain('Issue 0');
    expect(text).toContain('Issue 9');
  });

  it('caps to the most recent N entries when maxEntries is given', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      issue: `Issue ${i}`,
      solution: 's',
      lessons_learned: 'l',
    }));

    const text = formatLessonsEntries(readResultWith(entries), 3);

    expect(text).not.toContain('Issue 0');
    expect(text).not.toContain('Issue 6');
    expect(text).toContain('Issue 7');
    expect(text).toContain('Issue 9');
  });

  it('fills in defaults for missing fields on a partial entry', () => {
    const text = formatLessonsEntries(readResultWith([{}]));

    expect(text).toContain('Unknown issue');
    expect(text).toContain('No solution recorded');
    expect(text).toContain('No lessons recorded');
  });
});

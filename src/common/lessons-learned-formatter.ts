import { extractMcpText } from './mcp-text';

interface LessonEntry {
  issue?: string;
  solution?: string;
  lessons_learned?: string;
}

/**
 * Formats entries from the `historical_issues_and_lessons` memory (written by
 * ValidationAgent after each successful fix) as a numbered list.
 *
 * `maxEntries` caps how many of the most recent entries are included —
 * PlannerAgent caps this to keep the LLM prompt from growing unboundedly as
 * the log accumulates across many issues, while GitAgent (writing the
 * durable, human-facing copy into the repo) leaves it uncapped.
 */
export function formatLessonsEntries(
  readResult: unknown,
  maxEntries = Infinity,
): string | null {
  const raw = extractMcpText(readResult);
  if (!raw) return null;

  let parsed: { entries?: LessonEntry[] };
  try {
    parsed = JSON.parse(raw) as { entries?: LessonEntry[] };
  } catch {
    return null;
  }

  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    return null;
  }

  const entries =
    maxEntries === Infinity
      ? parsed.entries
      : parsed.entries.slice(-maxEntries);

  return entries
    .map((entry, i) => {
      const issue = entry?.issue || 'Unknown issue';
      const solution = entry?.solution || 'No solution recorded';
      const lessons = entry?.lessons_learned || 'No lessons recorded';
      return `${i + 1}. Issue: ${issue}\n   Solution: ${solution}\n   Lesson: ${lessons}`;
    })
    .join('\n');
}

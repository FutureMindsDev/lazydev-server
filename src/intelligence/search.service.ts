/* eslint-disable */
import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Cap stdout at 5 MB to prevent buffer overflow on large repos.
// ripgrep can produce enormous output when searching common keywords.
const MAX_BUFFER = 5 * 1024 * 1024;

// Never search inside these directories — they are never user source code
// and produce massive, irrelevant output that floods the buffer.
const EXCLUDED_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.turbo',
];

export interface SearchResult {
  file: string;
  line: number;
  content: string;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  async search(query: string, directory: string): Promise<SearchResult[]> {
    // Build --glob exclusion flags for each ignored directory
    const excludeArgs = EXCLUDED_DIRS.flatMap((dir) => [
      '--glob',
      `!${dir}/**`,
      '--glob',
      `!**/${dir}/**`,
    ]);

    try {
      const { stdout } = await execFileAsync(
        'rg',
        [
          '--vimgrep',
          '--fixed-strings',   // Treat query as literal string, not regex (LLM output can contain **,?,+,etc.)
          '--max-count=5',     // At most 5 matches per file — keeps output focused
          '--max-filesize=1M', // Skip binary or huge files
          ...excludeArgs,
          query,
          directory,
        ],
        { maxBuffer: MAX_BUFFER },
      );

      return stdout
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const parts = line.split(':');
          if (parts.length >= 4) {
            const file = parts[0];
            const lineNumber = parseInt(parts[1], 10);
            const content = parts.slice(3).join(':').trim();
            return { file, line: lineNumber, content };
          }
          return null;
        })
        .filter((result): result is SearchResult => result !== null);
    } catch (error: any) {
      // ripgrep exits with code 1 if no matches are found — not a real error
      if (error.code === 1) {
        return [];
      }
      this.logger.error(`Error executing ripgrep: ${error.message}`);
      throw error;
    }
  }
}

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
import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';
import { VectorDbService } from './vector-db.service';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// Source file extensions to index
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs',
  '.py', '.go', '.rs', '.java', '.kt', '.cs',
  '.rb', '.php', '.c', '.cpp', '.h', '.hpp',
  '.vue', '.svelte', '.html', '.css', '.scss',
  '.json', '.yaml', '.yml', '.toml', '.md',
]);

// Directories to always skip
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  'out', 'coverage', '.turbo', '__pycache__', 'vendor',
  '.serena',
]);

// Dimension map per known embedding provider/model
const VECTOR_DIMENSIONS: Record<string, number> = {
  'gemini-embedding-2': 3072,
  'gemini-embedding-001': 3072,
  'text-embedding-3-large': 3072,
  'text-embedding-3-small': 1536,
  'text-embedding-ada-002': 1536,
  'text-embedding-004': 768,
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
};

@Injectable()
export class RagIngestionService {
  private readonly logger = new Logger(RagIngestionService.name);

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorDbService: VectorDbService,
  ) {}

  /**
   * Walk a repo worktree, chunk source files, embed them, and upsert into Qdrant.
   * Safe to call multiple times — existing vectors are overwritten (upsert).
   */
  async ingestWorktree(worktreePath: string, collectionName: string): Promise<void> {
    this.logger.log(`[RAG] Starting ingestion for collection: ${collectionName} at ${worktreePath}`);

    // Determine vector dimension from the active embedding model
    const model = process.env.EMBEDDING_MODEL || 'gemini-embedding-2';
    const vectorSize = VECTOR_DIMENSIONS[model] ?? 768;

    await this.vectorDbService.ensureCollection(collectionName, vectorSize);
    this.logger.log(`[RAG] Collection "${collectionName}" ready (dim=${vectorSize})`);

    const files = await this.walkDir(worktreePath);
    this.logger.log(`[RAG] Found ${files.length} source files to index`);

    let indexed = 0;
    let skipped = 0;
    const BATCH_SIZE = 20;
    const batch: any[] = [];

    // Configurable delay between embedding calls to stay under rate limits.
    // Google free tier: 100 req/min → 600ms/req gives safe headroom.
    const INTER_REQUEST_DELAY = parseInt(process.env.EMBEDDING_RATE_LIMIT_MS || '700', 10);
    const MAX_RETRIES = 5;

    // Load local hash cache to avoid re-embedding unchanged files
    const hashDbPath = path.join(path.dirname(worktreePath), `.${collectionName}_hashes.json`);
    let hashDb: Record<string, string> = {};
    try {
      const data = await fs.readFile(hashDbPath, 'utf-8');
      hashDb = JSON.parse(data);
    } catch (e) {
      // Ignore if cache file doesn't exist
    }

    for (const filePath of files) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        if (!content.trim()) { skipped++; continue; }

        const relPath = path.relative(worktreePath, filePath);
        const contentHash = crypto.createHash('sha256').update(content).digest('hex');

        if (hashDb[relPath] === contentHash) {
          skipped++;
          continue; // File hasn't changed, skip embedding entirely
        }

        const chunks = this.embeddingService.chunkText(content, 800, 150);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (!chunk.trim()) continue;

          // Retry loop with 429-aware backoff
          let vector: number[] | null = null;
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
              vector = await this.embeddingService.getEmbedding(chunk);
              break; // success
            } catch (e: any) {
              const is429 = e.message?.includes('429') || e.message?.includes('RESOURCE_EXHAUSTED');
              if (!is429 || attempt === MAX_RETRIES - 1) throw e;

              // Parse retryDelay from Google's error body if present
              const delayMatch = e.message?.match(/"retryDelay"\s*:\s*"(\d+)s"/);
              const waitMs = delayMatch ? parseInt(delayMatch[1], 10) * 1000 + 500 : (attempt + 1) * 15_000;
              this.logger.warn(`[RAG] 429 rate limit hit — waiting ${waitMs / 1000}s before retry (attempt ${attempt + 1}/${MAX_RETRIES})`);
              await new Promise((r) => setTimeout(r, waitMs));
            }
          }

          if (!vector) continue;

          const relPath = path.relative(worktreePath, filePath);
          batch.push({
            id: this.stableId(`${relPath}:${i}`),
            vector,
            payload: { filePath: relPath, chunkIndex: i, content: chunk },
          });

          if (batch.length >= BATCH_SIZE) {
            await this.vectorDbService.upsertVectors(collectionName, [...batch]);
            batch.length = 0;
          }

          // Polite delay between embedding calls
          await new Promise((r) => setTimeout(r, INTER_REQUEST_DELAY));
        }

        // Mark file as fully indexed
        hashDb[relPath] = contentHash;
        indexed++;
      } catch (e: any) {
        this.logger.warn(`[RAG] Skipping ${filePath}: ${e.message}`);
        skipped++;
      }
    }

    // Flush remaining batch
    if (batch.length > 0) {
      await this.vectorDbService.upsertVectors(collectionName, [...batch]);
    }

    // Save hash cache
    await fs.writeFile(hashDbPath, JSON.stringify(hashDb, null, 2), 'utf-8');

    this.logger.log(`[RAG] Ingestion complete: ${indexed} files indexed, ${skipped} skipped (cached or empty)`);
  }

  /** Recursively collect all indexable source files under a directory */
  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...(await this.walkDir(fullPath)));
        } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          results.push(fullPath);
        }
      }
    } catch (e: any) {
      this.logger.warn(`[RAG] Cannot read dir ${dir}: ${e.message}`);
    }
    return results;
  }

  /** Generate a stable numeric ID from a string (for Qdrant point IDs) */
  private stableId(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }
}

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
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QdrantClient } from '@qdrant/js-client-rest';
import { fetch as undiciFetch } from 'undici';

// Workaround for Node.js 18+ native fetch bug with Qdrant client
globalThis.fetch = undiciFetch as any;

@Injectable()
export class VectorDbService implements OnModuleInit {
  private readonly logger = new Logger(VectorDbService.name);
  private client: QdrantClient;

  constructor() {
    // Configured based on docker-compose.yml default Qdrant port
    this.client = new QdrantClient({
      url: process.env.QDRANT_URL || 'http://localhost:6333',
    });
  }

  async onModuleInit() {
    try {
      const collections = await this.client.getCollections();
      this.logger.log(
        `Connected to Qdrant. Found collections: ${collections.collections.map((c) => c.name).join(', ')}`,
      );
    } catch (e) {
      this.logger.error('Failed to connect to Qdrant', e);
    }
  }

  async ensureCollection(collectionName: string, vectorSize: number) {
    const collections = await this.client.getCollections();
    const existing = collections.collections.find(
      (c) => c.name === collectionName,
    );

    if (existing) {
      // Guard against embedding model changes: if the stored dimension differs
      // from the requested one, the collection must be recreated. Mixing
      // dimensions causes silent bad results or hard errors at search time.
      const info = await this.client.getCollection(collectionName);
      const storedSize = (info.config?.params?.vectors as any)?.size as number | undefined;

      if (storedSize !== undefined && storedSize !== vectorSize) {
        this.logger.warn(
          `Collection "${collectionName}" has dimension ${storedSize} but current model produces ${vectorSize}. ` +
          `Dropping and recreating — this is expected when EMBEDDING_MODEL changes.`,
        );
        await this.client.deleteCollection(collectionName);
      } else {
        // Dimensions match — nothing to do
        return;
      }
    }

    await this.client.createCollection(collectionName, {
      vectors: {
        size: vectorSize,
        distance: 'Cosine',
      },
    });
    this.logger.log(`Created collection: ${collectionName} (dim=${vectorSize})`);
  }

  async upsertVectors(collectionName: string, points: any[]) {
    await this.client.upsert(collectionName, {
      wait: true,
      points,
    });
  }

  async searchSimilar(
    collectionName: string,
    vector: number[],
    limit: number = 5,
  ) {
    return this.client.search(collectionName, {
      vector: vector,
      limit,
    });
  }

  /**
   * Returns raw collection metadata from Qdrant for the dashboard repo-stats
   * endpoint (GET /api/dashboard/repos/:id/stats). Exposes the private client
   * call so the dashboard module doesn't need its own QdrantClient instance.
   */
  async getCollection(collectionName: string): Promise<any> {
    return this.client.getCollection(collectionName);
  }
}

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

import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { EmbeddingService } from './embedding.service';
import { VectorDbService } from './vector-db.service';
import { SerenaMcpService } from './serena-mcp.service';
import { RagIngestionService } from './rag-ingestion.service';

@Module({
  providers: [
    SerenaMcpService,
    SearchService,
    EmbeddingService,
    VectorDbService,
    RagIngestionService,
  ],
  exports: [
    SerenaMcpService,
    SearchService,
    EmbeddingService,
    VectorDbService,
    RagIngestionService,
  ],
})
export class IntelligenceModule {}

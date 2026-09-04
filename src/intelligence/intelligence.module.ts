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

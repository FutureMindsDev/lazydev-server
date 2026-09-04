import { Test, TestingModule } from '@nestjs/testing';
import { VectorDbService } from './vector-db.service';

jest.mock('@qdrant/js-client-rest', () => {
  return {
    QdrantClient: jest.fn().mockImplementation(() => ({
      getCollections: jest.fn().mockResolvedValue({ collections: [] }),
      createCollection: jest.fn().mockResolvedValue(true),
      upsert: jest.fn().mockResolvedValue(true),
      search: jest.fn().mockResolvedValue([]),
    })),
  };
});

describe('VectorDbService', () => {
  let service: VectorDbService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VectorDbService],
    }).compile();

    service = module.get<VectorDbService>(VectorDbService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

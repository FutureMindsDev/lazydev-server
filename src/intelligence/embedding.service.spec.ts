import { Test, TestingModule } from '@nestjs/testing';
import { EmbeddingService } from './embedding.service';

jest.mock('ollama', () => {
  return {
    Ollama: jest.fn().mockImplementation(() => ({
      embeddings: jest.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
    })),
  };
});

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EmbeddingService],
    }).compile();

    service = module.get<EmbeddingService>(EmbeddingService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should chunk text correctly', () => {
    const text = '1234567890';
    const chunks = service.chunkText(text, 5, 2);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).toBe('12345');
  });
});

describe('EmbeddingService — credential decoupling (EMBEDDING_API_KEY / EMBEDDING_BASE_URL)', () => {
  const ENV_KEYS = [
    'EMBEDDING_PROVIDER',
    'EMBEDDING_API_KEY',
    'EMBEDDING_BASE_URL',
    'EMBEDDING_MODEL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('pins embeddings to Gemini while the chat LLM runs on OpenRouter', () => {
    // Before the decoupling, this setup broke RAG: the OpenRouter key was
    // sent to googleapis (401). EMBEDDING_API_KEY keeps them separate.
    process.env.OPENAI_API_KEY = 'sk-or-openrouter';
    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.EMBEDDING_PROVIDER = 'google';
    process.env.EMBEDDING_API_KEY = 'gemini-key';

    const svc = new EmbeddingService();
    expect((svc as any).provider).toBe('google');
    expect((svc as any).model).toBe('gemini-embedding-2');
  });

  it('auto-detects google from EMBEDDING_BASE_URL without pinning the provider', () => {
    process.env.EMBEDDING_API_KEY = 'gemini-key';
    process.env.EMBEDDING_BASE_URL =
      'https://generativelanguage.googleapis.com';

    const svc = new EmbeddingService();
    expect((svc as any).provider).toBe('google');
  });

  it('auto-detects google from the shared chat credentials (previous behaviour)', () => {
    process.env.OPENAI_API_KEY = 'gemini-key';
    process.env.OPENAI_BASE_URL =
      'https://generativelanguage.googleapis.com/v1beta/openai';

    const svc = new EmbeddingService();
    expect((svc as any).provider).toBe('google');
  });

  it('inherits chat credentials when EMBEDDING_* is unset', () => {
    process.env.OPENAI_API_KEY = 'sk-or-openrouter';
    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1';

    const svc = new EmbeddingService();
    expect((svc as any).provider).toBe('openai');
    expect((svc as any).model).toBe('text-embedding-3-small');
  });

  it('falls back to ollama when no key resolves', () => {
    const svc = new EmbeddingService();
    expect((svc as any).provider).toBe('ollama');
    expect((svc as any).model).toBe('nomic-embed-text');
  });
});

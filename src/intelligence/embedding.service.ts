/* eslint-disable */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Ollama } from 'ollama';

type EmbeddingProvider = 'google' | 'openai' | 'ollama';

@Injectable()
export class EmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingService.name);
  private ollama: Ollama;
  private provider: EmbeddingProvider;
  private model: string;

  constructor() {
    this.ollama = new Ollama({
      host: process.env.OLLAMA_HOST || 'http://localhost:11434',
    });

    // Determine provider and model from env.
    // EMBEDDING_PROVIDER: 'google' | 'openai' | 'ollama'  (default: auto-detect)
    // EMBEDDING_MODEL:    model name override
    //
    // Credentials resolve from the dedicated EMBEDDING_API_KEY /
    // EMBEDDING_BASE_URL overrides first, then the shared OPENAI_API_KEY /
    // OPENAI_BASE_URL pair. This decouples embeddings from the chat LLM: the
    // agents can run on OpenRouter/NVIDIA/… while embeddings stay on Gemini
    // (or vice versa) without the two fighting over OPENAI_API_KEY.
    const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
    const baseUrl =
      process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || '';
    const envProvider = (process.env.EMBEDDING_PROVIDER || '').toLowerCase() as EmbeddingProvider;

    if (envProvider === 'google' || (!envProvider && apiKey && baseUrl.includes('googleapis'))) {
      this.provider = 'google';
      this.model = process.env.EMBEDDING_MODEL || 'gemini-embedding-2';
    } else if (envProvider === 'openai' || (!envProvider && apiKey)) {
      this.provider = 'openai';
      this.model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
    } else {
      this.provider = 'ollama';
      this.model = process.env.EMBEDDING_MODEL || process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
    }
  }

  async onModuleInit() {
    this.logger.log(`Embedding provider: ${this.provider.toUpperCase()} | Model: ${this.model}`);

    // Smoke-test the selected provider at startup
    try {
      await this.getEmbedding('ping');
      this.logger.log(`Embedding provider [${this.provider.toUpperCase()}] connected successfully ✅`);
    } catch (e: any) {
      this.logger.warn(`Embedding provider [${this.provider.toUpperCase()}] smoke-test failed: ${e.message}`);
    }
  }

  async getEmbedding(text: string): Promise<number[]> {
    switch (this.provider) {
      case 'google':
        return this.getGoogleEmbedding(text);
      case 'openai':
        return this.getOpenAiEmbedding(text);
      case 'ollama':
      default:
        return this.getOllamaEmbedding(text);
    }
  }

  private async getGoogleEmbedding(text: string): Promise<number[]> {
    const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('EMBEDDING_API_KEY (or OPENAI_API_KEY) is required for Google embeddings');

    const url = `https://generativelanguage.googleapis.com/v1/models/${this.model}:embedContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text }] } }),
      signal: AbortSignal.timeout(15000), // Prevent infinite hang
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google Embeddings API error ${res.status}: ${body}`);
    }

    const json = await res.json() as any;
    return json.embedding.values as number[];
  }

  private async getOpenAiEmbedding(text: string): Promise<number[]> {
    const { OpenAI } = await import('openai');
    const openai = new OpenAI({
      apiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY,
      baseURL: process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL,
    });

    const response = await openai.embeddings.create({
      model: this.model,
      input: text,
    });
    return response.data[0].embedding;
  }

  private async getOllamaEmbedding(text: string): Promise<number[]> {
    const response = await this.ollama.embeddings({
      model: this.model,
      prompt: text,
    });
    return response.embedding;
  }

  chunkText(
    text: string,
    chunkSize: number = 1000,
    overlap: number = 200,
  ): string[] {
    const chunks: string[] = [];
    let i = 0;
    while (i < text.length) {
      chunks.push(text.slice(i, i + chunkSize));
      i += chunkSize - overlap;
    }
    return chunks;
  }
}

# Sprint 4 Manual Testing Guide: Code Intelligence Layer

This guide outlines how to manually test the Code Intelligence capabilities implemented in **Sprint 4**. This includes testing AST parsing, Fast Search (Ripgrep), Embeddings, and the Vector DB connection.

---

## 📋 Prerequisites

1. Ensure the PostgreSQL, Redis, and **Qdrant** containers are running:
   ```bash
   docker-compose up -d
   ```
2. Verify that you have `rg` (Ripgrep) installed on your system if running outside of Docker.
3. Node.js dependencies installed (`npm install`).

---

## 🏃 Step 1: Start the Application

Start the application:
```bash
npm run start:dev
```
Observe the log output to make sure it establishes a connection to Qdrant successfully:
```text
[VectorDbService] Connected to Qdrant. Found collections: ...
```

---

## 🧪 Step 2: Testing AST Parsing (Tree-sitter)

Verify that the `AstService` can load the WebAssembly grammar and parse code.

1. **Download WASM Grammar (If not present)**:
   For this manual test, make sure `tree-sitter-typescript.wasm` or similar is available in your workspace.
2. **Trigger Detection**:
   You can use a quick script to test the parsing:
   ```typescript
   // Save to test-ast.ts and run with npx ts-node test-ast.ts
   import { NestFactory } from '@nestjs/core';
   import { AppModule } from './src/app.module';
   import { AstService } from './src/intelligence/ast.service';

   async function run() {
     const app = await NestFactory.createApplicationContext(AppModule);
     const service = app.get(AstService);
     
     // Ensure you load a language first. Example:
     // await service.loadLanguage('typescript', './tree-sitter-typescript.wasm');
     
     const result = service.extractSymbols('function test() { return 1; }', 'typescript');
     console.log('Parsed AST Result:', result);
     
     await app.close();
     process.exit(0);
   }
   run();
   ```

---

## 🔍 Step 3: Verify Fast Search (Ripgrep)

1. **Trigger Search via Code**:
   Trigger the `SearchService` to find a specific string in the project.
   ```typescript
   // Save to test-search.ts and run with npx ts-node test-search.ts
   import { NestFactory } from '@nestjs/core';
   import { AppModule } from './src/app.module';
   import { SearchService } from './src/intelligence/search.service';

   async function run() {
     const app = await NestFactory.createApplicationContext(AppModule);
     const service = app.get(SearchService);
     const results = await service.search('ValidationService', './src');
     console.log('Search Results:', results);
     await app.close();
     process.exit(0);
   }
   run();
   ```
   *Expected Result*: You should see an array of matches containing the file path, line number, and content.

---

## 🧠 Step 4: Verify Embeddings & Qdrant

1. **Generate and Upsert Vectors**:
   Test the fallback to Ollama and connection to Qdrant.
   Ensure Ollama is running locally with the `nomic-embed-text` model.
   ```typescript
   // Save to test-vector.ts and run with npx ts-node test-vector.ts
   import { NestFactory } from '@nestjs/core';
   import { AppModule } from './src/app.module';
   import { EmbeddingService } from './src/intelligence/embedding.service';
   import { VectorDbService } from './src/intelligence/vector-db.service';

   async function run() {
     const app = await NestFactory.createApplicationContext(AppModule);
     const embedService = app.get(EmbeddingService);
     const vectorDbService = app.get(VectorDbService);
     
     const text = "function doSomething() { console.log('hello world'); }";
     
     // 1. Get embedding
     console.log('Fetching embedding...');
     const vector = await embedService.getEmbedding(text);
     console.log(`Received embedding of size: ${vector.length}`);
     
     // 2. Upsert to Qdrant
     const collection = 'test_collection';
     await vectorDbService.ensureCollection(collection, vector.length);
     await vectorDbService.upsertVectors(collection, [{ id: 1, vector, payload: { text } }]);
     
     // 3. Search Qdrant
     const results = await vectorDbService.searchSimilar(collection, vector, 1);
     console.log('Search Result from Qdrant:', results);
     
     await app.close();
     process.exit(0);
   }
   run();
   ```

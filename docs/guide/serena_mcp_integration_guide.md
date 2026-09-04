# Serena MCP Integration Guide for LazyDev

## What is Serena MCP?

Serena is an open-source **MCP (Model Context Protocol) server** that acts as an "IDE for your AI agent." Instead of dumping raw file contents into LLM prompts (which burns tokens and loses context), Serena uses **Language Server Protocol (LSP) backends** to give your agents **semantic, symbol-level understanding** of the codebase.

> [!IMPORTANT]
> Serena is **NOT a library you install via npm**. It's a standalone MCP server process that your LangGraph agents communicate with over the MCP protocol (stdio or SSE transport). Think of it as a sidecar service, similar to how you run Qdrant or Redis alongside your NestJS app.

---

## How Serena Maps to Your Current Architecture

Your project ([architecture plan](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/LazyDev_Updated_Final_Architecture_Plan.md)) already has a **Code Intelligence** layer in the `src/intelligence/` module:

| Current Component | What It Does | Serena Replacement |
|---|---|---|
| [search.service.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/intelligence/search.service.ts) | ripgrep text search | `search_for_pattern` tool — same grep but integrated |
| [ast.service.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/intelligence/ast.service.ts) | Tree-sitter AST parsing (basic, partially implemented) | `get_symbols_overview`, `find_symbol` — **far more powerful**, uses real LSP |
| [lsp.service.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/intelligence/lsp.service.ts) | ts-morph (TypeScript only, very limited) | Full LSP integration — **40+ languages**, go-to-definition, find-references, rename |
| [embedding.service.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/intelligence/embedding.service.ts) | OpenAI/Ollama embeddings | ❌ Serena does NOT do embeddings — **keep this** |
| [vector-db.service.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/intelligence/vector-db.service.ts) | Qdrant vector similarity search | ❌ Serena does NOT do vector search — **keep this** |

---

## Step-by-Step Integration

### Step 1: Install Prerequisites

```bash
# Install uv (Python package manager used by Serena)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Clone Serena
git clone https://github.com/oraios/serena.git /opt/serena
```

### Step 2: Run Serena as a Docker Sidecar

Add Serena to your [docker-compose.yml](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/docker-compose.yml):

```yaml
services:
  # ... existing services (postgres, redis, qdrant, etc.)

  serena:
    build:
      context: ./serena  # or use a pre-built image
      dockerfile: Dockerfile
    volumes:
      - worktrees:/app/worktrees:ro  # Read-only access to repo worktrees
    ports:
      - "3333:3333"  # SSE transport port
    environment:
      - SERENA_PROJECT_PATH=/app/worktrees
    restart: unless-stopped
```

> [!TIP]
> If Serena doesn't have an official Docker image, you can create one using `uv` to install and run it. Alternatively, run it as a subprocess from your NestJS app using stdio transport.

### Step 3: Create an MCP Client in Your NestJS App

Create a new service that communicates with Serena over MCP:

```
src/intelligence/serena-mcp.service.ts  [NEW]
```

```typescript
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// OR for SSE: import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

@Injectable()
export class SerenaMcpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SerenaMcpService.name);
  private client: Client;
  private transport: StdioClientTransport;

  async onModuleInit() {
    // Option A: Stdio transport (subprocess)
    this.transport = new StdioClientTransport({
      command: 'uv',
      args: ['run', '--directory', '/opt/serena', 'serena-mcp-server',
             '--context', 'ide-assistant'],
    });

    this.client = new Client({ name: 'lazydev', version: '1.0.0' }, {});
    await this.client.connect(this.transport);
    this.logger.log('Connected to Serena MCP server');
  }

  async onModuleDestroy() {
    await this.client?.close();
  }

  // ── Symbol Navigation ───────────────────────────────────────

  async activateProject(projectPath: string) {
    return this.client.callTool({
      name: 'activate_project',
      arguments: { project_path: projectPath },
    });
  }

  async getSymbolsOverview(filePath: string) {
    return this.client.callTool({
      name: 'get_symbols_overview',
      arguments: { file_path: filePath },
    });
  }

  async findSymbol(namePattern: string) {
    return this.client.callTool({
      name: 'find_symbol',
      arguments: { name_path_pattern: namePattern },
    });
  }

  async findReferencingSymbols(symbolName: string) {
    return this.client.callTool({
      name: 'find_referencing_symbols',
      arguments: { symbol_name: symbolName },
    });
  }

  // ── Code Editing ────────────────────────────────────────────

  async replaceSymbolBody(symbolPath: string, newBody: string) {
    return this.client.callTool({
      name: 'replace_symbol_body',
      arguments: { symbol_path: symbolPath, new_body: newBody },
    });
  }

  async insertAfterSymbol(symbolPath: string, content: string) {
    return this.client.callTool({
      name: 'insert_after_symbol',
      arguments: { symbol_path: symbolPath, content: content },
    });
  }

  // ── Search ──────────────────────────────────────────────────

  async searchForPattern(pattern: string) {
    return this.client.callTool({
      name: 'search_for_pattern',
      arguments: { pattern },
    });
  }

  // ── File Operations ─────────────────────────────────────────

  async readFile(filePath: string, startLine?: number, endLine?: number) {
    return this.client.callTool({
      name: 'read_file',
      arguments: { file_path: filePath, start_line: startLine, end_line: endLine },
    });
  }
}
```

### Step 4: Install MCP SDK

```bash
npm install @modelcontextprotocol/sdk
```

### Step 5: Wire Serena into Your Research Agent

The key integration point is your [research.agent.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/orchestration/agents/research.agent.ts). Currently it uses ripgrep keywords → raw text matches. With Serena, it becomes **semantic-aware**:

```typescript
// research.agent.ts — enhanced with Serena
constructor(
  private readonly llmService: LlmService,
  private readonly searchService: SearchService,       // keep as fallback
  private readonly vectorDbService: VectorDbService,   // keep for RAG
  private readonly serenaMcp: SerenaMcpService,        // NEW
) {}

async invoke(state: AgentState): Promise<Partial<AgentState>> {
  const worktreePath = state.issuePayload?.worktreePath;

  // 1. Activate the project in Serena
  await this.serenaMcp.activateProject(worktreePath);

  // 2. Use Serena for SYMBOL-AWARE research
  const symbol = extractedKeyword; // e.g., "PaymentService"
  const symbolInfo = await this.serenaMcp.findSymbol(symbol);
  const references = await this.serenaMcp.findReferencingSymbols(symbol);

  // 3. Get file-level symbol overview (function names, classes, etc.)
  const overview = await this.serenaMcp.getSymbolsOverview('src/payments/payment.service.ts');

  // 4. Fall back to ripgrep for text patterns not covered by LSP
  const grepResults = await this.searchService.search(keyword, worktreePath);

  // 5. Combine for context — now with STRUCTURED symbol data, not raw text
  // ...
}
```

### Step 6: Wire Serena into Your Patch Generator

Your [patch-generator.agent.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/orchestration/agents/patch-generator.agent.ts) currently generates raw text patches. With Serena, it can use **symbol-level editing**:

```typescript
// Instead of: "find line 42 in file X and replace text..."
// Use: "replace the body of PaymentService.processRefund()"
await this.serenaMcp.replaceSymbolBody(
  'PaymentService.processRefund',
  newFunctionBody
);
```

> [!IMPORTANT]
> This is the **single biggest improvement** Serena brings. Symbol-level edits are far more reliable than line-number-based patching, which is fragile and breaks when files shift.

---

## Do You Still Need RAG (Qdrant + Embeddings)?

### Short Answer: **YES, absolutely keep your RAG pipeline.**

### Detailed Reasoning

Serena and RAG serve **fundamentally different purposes**:

| Capability | Serena MCP | RAG (Qdrant + Embeddings) |
|---|---|---|
| **"What is function X and where is it used?"** | ✅ LSP-powered, precise | ❌ Can't do this |
| **"Find all files related to payment processing"** | ⚠️ Only pattern/symbol search | ✅ Semantic similarity across entire codebase |
| **"What similar issues have we fixed before?"** | ❌ No historical memory | ✅ Issue-to-fix embeddings in Qdrant |
| **"What code is conceptually relevant to this error?"** | ⚠️ Only if you know the symbol name | ✅ Embedding similarity finds related code even with different naming |
| **"Understand the full architecture of module X"** | ✅ Symbol tree + references | ⚠️ Returns chunks, not structured relationships |
| **Navigation precision** | ✅ Exact (go-to-definition, find-references) | ⚠️ Approximate (similarity threshold) |
| **Token efficiency** | ✅ Returns only the symbol you asked for | ⚠️ Returns text chunks (may include noise) |
| **Cross-repo historical context** | ❌ Only current project | ✅ Can store/query across repos |

### The Optimal Architecture: Serena + RAG Together

```
Issue Received
    │
    ├──→ RAG Pipeline (Qdrant + Embeddings)
    │      → "Find files semantically related to this issue"
    │      → "Find similar past issues and their fixes"
    │      → Returns: candidate file list + historical context
    │
    └──→ Serena MCP
           → "For each candidate file, show me the symbol tree"
           → "Find all references to ErrorHandler.processRefund()"
           → "What's the exact signature of PaymentGateway.charge()?"
           → Returns: precise, structured code intelligence
    │
    ▼
Research Agent combines both →  Focused context for Planning Agent
```

> [!TIP]
> **Token savings come from using both together**: RAG narrows the search space (which files?), and Serena provides precise context (which symbols, what signatures, what references?) instead of dumping entire files.

---

## Recommended Serena Features for LazyDev

### 1. `replace_symbol_body` — Safe Patching ⭐ (Critical)
**Why**: Your [patch-generator.agent.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/orchestration/agents/patch-generator.agent.ts) currently generates text-based diffs. Symbol-level replacement is **dramatically more reliable** — it won't break when someone adds a comment or reformats the file.

### 2. `find_referencing_symbols` — Impact Analysis ⭐ (Critical)
**Why**: Before your Planning Agent creates a fix plan, it needs to know **what else will break**. This tells you every caller of the function you're about to modify.

### 3. `get_symbols_overview` — Token-Efficient File Summarization ⭐ (Critical)
**Why**: Instead of sending the full 500-line file to the LLM, send just the symbol overview (class names, function signatures, imports). This is the **#1 token saver**.

### 4. `find_symbol` — Precise Navigation
**Why**: When the issue says "the `calculateTax` function is wrong," your Research Agent can immediately jump to it instead of grep-searching and hoping.

### 5. `insert_after_symbol` — Additive Code Changes
**Why**: When the fix requires adding a new method to a class, this is cleaner than trying to compute line numbers.

### 6. `search_for_pattern` — Enhanced Grep
**Why**: Can replace your current [search.service.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/intelligence/search.service.ts) for some cases, but keep ripgrep as a fallback since it's faster for simple text patterns.

### 7. `activate_project` — Multi-Repo Support
**Why**: LazyDev processes issues from **multiple repositories**. Each time a new issue comes in, call `activate_project(worktreePath)` to point Serena at the correct repo.

---

## What You Can Deprecate vs. Keep

| Component | Decision | Reason |
|---|---|---|
| [ast.service.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/intelligence/ast.service.ts) (Tree-sitter) | 🗑️ **Deprecate** | Serena's LSP-based symbol analysis is strictly superior. Tree-sitter here is barely implemented and TS-only. |
| [lsp.service.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/intelligence/lsp.service.ts) (ts-morph) | 🗑️ **Deprecate** | Serena replaces this entirely with 40+ language support vs. TypeScript-only ts-morph. |
| [search.service.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/intelligence/search.service.ts) (ripgrep) | ✅ **Keep as fallback** | Ripgrep is faster for simple text patterns. Use Serena for symbol-aware search, ripgrep for raw text. |
| [embedding.service.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/intelligence/embedding.service.ts) | ✅ **Keep** | Serena has NO embedding capability. |
| [vector-db.service.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/intelligence/vector-db.service.ts) (Qdrant) | ✅ **Keep** | Serena has NO vector similarity capability. |
| `tree-sitter-typescript.wasm` | 🗑️ **Remove** | No longer needed. |

---

## Revised Architecture Flow with Serena

```
Issue Opened
    ↓
Webhook → BullMQ → Redis Lock
    ↓
Repository Cache → Create Worktree
    ↓
┌─────────────────────────────────────────────┐
│  serenaMcp.activateProject(worktreePath)     │ ← Point Serena at this repo
└─────────────────────────────────────────────┘
    ↓
Issue Analyzer Agent (LLM)
    ↓
Research Agent
    ├── Serena: findSymbol(), getSymbolsOverview()    ← Precise code navigation
    ├── Serena: findReferencingSymbols()               ← Impact analysis
    ├── Qdrant/Embeddings: semantic file search        ← Broad discovery
    └── ripgrep: text pattern fallback                 ← Simple patterns
    ↓
Planning Agent (LLM)
    ↓
Patch Generator Agent
    ├── Serena: replaceSymbolBody()     ← Symbol-level edits (safe!)
    ├── Serena: insertAfterSymbol()     ← Add new code
    └── Fallback: text-based patches    ← For file creation, etc.
    ↓
Validation Agent (Docker Sandbox)
    ↓
Git Agent → Push Branch
    ↓
Discord Notification
```

---

## Summary of Token Savings

| Before (Current) | After (With Serena) | Savings |
|---|---|---|
| Send 500-line file to LLM for context | Send 20-line symbol overview | **~96% fewer tokens per file** |
| LLM generates line-number diffs | LLM targets `ClassName.methodName` | **Fewer retries** (patches are more accurate) |
| Grep returns raw text lines | Serena returns structured symbol data | **~50% fewer context tokens** |
| ts-morph for TS only | LSP for 40+ languages | **Multi-language support for free** |
| Validation retry loop (up to 3x) | Fewer validation failures | **~30-50% fewer LLM round trips** |

---

## Quick Start Checklist

- [ ] Install `uv` on your machine/Docker image
- [ ] Clone Serena to `/opt/serena` (or vendor it)
- [ ] Install MCP SDK: `npm install @modelcontextprotocol/sdk`
- [ ] Create `src/intelligence/serena-mcp.service.ts`
- [ ] Add `SerenaMcpService` to [intelligence.module.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/intelligence/intelligence.module.ts)
- [ ] Inject into [research.agent.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/orchestration/agents/research.agent.ts) and [patch-generator.agent.ts](file:///Users/arkarchanmyae/Desktop/projects/lazy-issue-resolver/src/orchestration/agents/patch-generator.agent.ts)
- [ ] Add Serena as a service in `docker-compose.yml`
- [ ] Call `activateProject()` at the start of each pipeline run
- [ ] Deprecate `ast.service.ts` and `lsp.service.ts`
- [ ] Keep `embedding.service.ts`, `vector-db.service.ts`, and `search.service.ts`

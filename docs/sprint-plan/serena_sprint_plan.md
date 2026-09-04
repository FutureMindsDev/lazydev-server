# Sprint Plan: Serena MCP Integration (Sprint 10)

## Duration
2 Weeks

## Goals
- Deploy Serena MCP as a reliable sidecar container within the existing infrastructure.
- Integrate the MCP SDK into the NestJS backend.
- Overhaul the `ResearchAgent` to use the Hybrid RAG + Serena discovery model.
- Overhaul the `PatchGeneratorAgent` to use symbol-level AST editing.
- Deprecate legacy AST and LSP services to reduce technical debt.
- Drastically reduce LLM context token usage and improve patch safety.

## Deliverables

### 1. Infrastructure & Connectivity
**Owner:** DevOps / Backend
- Build and configure the Serena Docker container with `uv`.
- Configure `docker-compose.yml` to network the NestJS app and Serena.
- Ensure proper volume mounting so Serena can access isolated worktrees.

### 2. MCP Client Integration
**Owner:** Backend
- Install `@modelcontextprotocol/sdk`.
- Build `SerenaMcpService` in NestJS to establish and maintain the connection.
- Implement error handling and reconnection logic for the MCP transport layer.

### 3. Agent Enhancements
**Owner:** AI Engineer
- **Research Agent (The Hybrid Model)**: 
  - *Clarification on "Hybrid":* Serena does **not** search with vectors. The hybrid model works sequentially: (1) RAG (using Qdrant vectors) searches the English text to find the *paths* of semantically relevant files. (2) We pass those file paths to Serena. Serena then uses traditional Language Server Protocol (LSP) to extract the exact function signatures and callers from those specific files.
  - *Does the English text search use an LLM?* It uses an **Embedding Model** (a specialized math model), not a conversational "Chat" LLM. Here is the exact sequence:
    1. **Before (Chat LLM)**: The `IssueAnalyzerAgent` (e.g., GPT-4o) reads the messy human GitHub issue and summarizes it into a clean, searchable query.
    2. **During (Embedding Model + Qdrant)**: We send that summary to the Embedding Model, which turns it into a vector. Qdrant compares it to the repo vectors and returns file paths. Serena generates the symbol trees for those files. (Zero Chat LLM tokens used here).
    3. **After (Chat LLM)**: The `PlanningAgent` and `PatchGeneratorAgent` (e.g., Claude 3.5 Sonnet) receive Serena's symbol trees, "read" the code, and figure out how to fix the bug.
  - *Are the embeddings local or cloud?* We support both. By default, we use **Cloud** (e.g., OpenAI's `text-embedding-3-small` or Cohere via OpenRouter) for the highest accuracy and speed. However, our architecture includes a **Local** fallback (using Ollama with `nomic-embed-text`). If the user configures the agent to be fully local/private, both the Chat LLM and the Embedding Model run entirely on the host machine.
- **Planning Agent**: Update prompt templates to leverage the new structured symbol context.
  - *Why update prompts?* Previously, the LLM was fed raw lines of text from `ripgrep`. Now, it will receive structured JSON-like symbol trees (e.g., "Class X has Methods Y and Z"). The LLM's system prompt must be updated to instruct it on how to read and plan using this new structured data format.
  - *Fallback Strategy:* We must add a fallback instruction to the prompt: *"If Serena fails to analyze a file (e.g., due to a severe syntax error preventing parsing, or an unsupported language), fall back to using the `SearchService` (ripgrep) for text-based analysis."*
- **Patch Generator**: Refactor to output target symbols instead of full files.
  - *Before vs. After:* **Before**, the LLM was fed the entire 500-line file, and was asked to output the complete 500-line modified file. This burned thousands of tokens and often led to the LLM accidentally changing surrounding code formatting or hallucinating deleted lines. **After**, the LLM is only given the specific function body. It outputs *only* the new function body and the target symbol name (e.g., `OrderService.calculateTotal`). We then call Serena's `replace_symbol_body` API, and Serena injects the code into the exact AST node of the file, completely protecting the surrounding formatting and unmodified code.
  - *How does Serena modify the file?* Serena parses the code into an AST (Abstract Syntax Tree) to find the exact line and character coordinates (byte offsets) where the function starts and ends. It then slices the new code into that exact position in memory, and performs a standard, safe filesystem write (e.g., Python's equivalent of `fs.writeFileSync`) to save the file. It does *not* use brittle command-line tools like `sed` or `awk`.

### 4. Cleanup & Deprecation
**Owner:** Backend
- Safely remove `ast.service.ts` and `tree-sitter` dependencies.
- Safely remove `lsp.service.ts` and `ts-morph` dependencies.
- Update package.json and clean up unused libraries.
  - *How does this reduce token usage? (Deep Dive):* Our legacy AST service would extract raw AST nodes (which looks like a massive JSON object detailing every parenthesis, block, and variable declaration). Feeding that JSON to an LLM costs thousands of tokens and confuses the model. Serena's `get_symbols_overview` runs a script over the LSP output to build a human-readable "Table of Contents". Instead of a massive JSON tree, the LLM just sees: 
    `1. Class OrderService`
    `  - calculateTotal(items: CartItem[])`
    This turns a 500-line file into a 20-line summary, stripping out all the internal logic code that the LLM doesn't need to see yet. This drastically reduces the LLM context window size.

## Technical Tasks & Assignments

| Task | Owner | Estimated Effort |
|---|---|---|
| Configure Serena Docker container & compose networking | DevOps | 2 Days |
| Implement `SerenaMcpService` with SDK | Backend | 3 Days |
| Refactor `ResearchAgent` to use Hybrid RAG+Serena | AI Engineer | 3 Days |
| Refactor `PatchGeneratorAgent` for symbol-level patching | AI Engineer | 3 Days |
| Remove legacy AST/LSP services & dependencies | Backend | 1 Day |
| Integration Testing & Token Cost Profiling | QA / AI Engineer | 2 Days |

## Sprint Exit Criteria
- [ ] Serena container boots successfully and connects to the NestJS app via MCP.
- [ ] `ResearchAgent` successfully extracts symbol trees instead of raw grep lines for candidate files.
- [ ] `PatchGeneratorAgent` successfully modifies code using `replace_symbol_body` without breaking surrounding file formatting.
- [ ] Legacy tree-sitter and ts-morph packages are completely removed from the project.
- [ ] A test pipeline run demonstrates a >50% reduction in context tokens for large files compared to the previous sprint.

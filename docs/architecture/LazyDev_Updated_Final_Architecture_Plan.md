# LazyDev — Updated Final Architecture Plan

## Core Vision

LazyDev is an AI-native autonomous CI assistant that:

- listens for GitHub issues
- analyzes the issue automatically
- determines the target branch (issues are repo-level, not branch-specific)
- pulls the correct repository branch
- retrieves relevant code context
- generates code fixes using multi-agent orchestration
- validates fixes locally
- pushes a new fix branch
- waits for repository CI/CD validation
- reports status through Discord/Slack

The automation boundary ends at:

Branch Push → STOP

No autonomous PR creation.
No autonomous merging.
No direct modification of protected branches.

---

## Final Selected Architecture Decisions

| Category | Selected Choice |
|---|---|
| AI Architecture | Hybrid AI |
| Agent System | Multi-Agent |
| GitHub Integration | GitHub App |
| Sandbox | Docker |
| Multi-Language Support | Language-Specific Agents |
| Validation | Language Auto Detection |
| Deployment | Docker Compose |
| Notifications | Discord / Slack |
| Branch Strategy | Work from resolved target branch (default branch or label/body hint) |
| Repository Strategy | Cached repositories |
| Queue System | BullMQ |
| Distributed Locking | Redis Locks |
| PR Automation | Disabled |

---

## High-Level Architecture

GitHub App
↓
Webhook Receiver
↓
API Server
↓
BullMQ Queue
↓
Redis Lock Manager
↓
Repository Cache System (repo-cache/)
↓
Git Worktree Creation (lazydev/fix-* branch)
↓
Code Intelligence (RAG via Qdrant + LSP via Serena MCP)
↓
Docker Sandbox
↓
LangGraph Multi-Agent System
↓
Push Fix Branch
↓
Main Repository CI/CD
↓
CI/CD Result Observer
↓
Discord / Slack Notification

---

## GitHub App Integration

The GitHub App is responsible for:

- cloning repositories
- fetching branches
- pushing fix branches
- listening to issue events
- secure authentication using scoped tokens

---

## Repository Management System

LazyDev will NOT fully clone repositories every time.

### Local Cache Location
Bare repositories are cached locally in the `repo-cache/` directory in the root of the project.

### Workflow:

Issue Appears
↓
Check Local Cache (repo-cache/)
↓
Repo Exists?
YES → git fetch latest
NO → initial clone

### Git Worktrees
Instead of switching branches inside the main cache directory (which would cause conflicts when multiple tasks run concurrently), LazyDev creates a temporary, isolated **Git Worktree**. A Git worktree is an isolated folder linked to the main cached repository database.

### Issue Branch Strategy
The worktree is checked out directly onto a new branch named `lazydev/fix-{issue_number}-{desc}` (created off the resolved target branch). The agent's subsequent edits and commits are applied solely to this new branch inside the isolated worktree directory.

Branch resolution:

GitHub issues are repo-level — they are NOT tied to any specific branch.
LazyDev must resolve the target branch using this priority order:

1. Branch hint in issue body (e.g. `branch: feature/payment-v2`)
2. Branch name in issue labels (e.g. label `branch:develop`)
3. Repository default branch (e.g. `main` or `develop`)
4. Configured per-repo default in LazyDev settings

Example:

Resolved Target: feature/payment-v2
↓
Worktree checkout on new branch: lazydev/fix-142-payment-timeout

---

## CI/CD Architecture

### LazyDev Internal Validation

Runs:

- syntax checks
- lint
- type checks
- quick unit tests

inside Docker.

### Main Repository CI/CD

Source of truth for validation:

- GitHub Actions
- Jenkins
- GitLab CI
- Drone CI

Validation flow:

Local Validation
↓
Push Fix Branch
↓
Repository CI/CD Executes
↓
Observe Results
↓
Discord/Slack Notification

---

## Multi-Agent Architecture

Agents:

- Issue Analyzer (extracts requirements and summarizes issues)
- Research Agent (collects context using Qdrant RAG + Serena MCP LSP + Ripgrep)
- Planning Agent (develops step-by-step implementation plans)
- Patch Generator (writes the fixes and applies them via Serena AST updates)
- Validation Agent (runs tests inside Docker sandbox)
- Git Agent (commits and pushes the fix branch)

### Research Agent Integration
The Research Agent implements a hybrid intelligence workflow:
- **RAG Discovery**: Queries Qdrant to find semantically related files and past issue fixes.
- **Serena MCP Precision**: Uses the Serena sidecar container over MCP to query the language server (LSP) for class/method overviews, symbol references, and caller impact analysis.
- **Ripgrep Fallback**: Falls back to ripgrep for simple exact text patterns.

### Patch Generator
- Generates code fixes at the function or symbol level.
- Applies changes by sending the new function bodies directly to Serena MCP's `replace_symbol_body` tool.
- Uses AST-safe rewriting instead of fragile regex or line-number-based string replacement.

### Git Agent Restrictions

NEVER:

- merges code
- creates PRs
- modifies protected branches

---

## Redis Locks & Deadlock Prevention

### Why Locks Are Needed

Prevent:

- duplicate issue processing
- concurrent branch modifications
- repository corruption
- deadlocks

### Lock Types

Repository lock:

lock:repo:owner/repo

Branch lock:

lock:branch:repo:develop

Issue lock:

lock:issue:repo:142

### Deadlock Prevention

- TTL expiration
- heartbeat renewal
- strict lock ordering
- exponential backoff retries
- automatic recovery

---

## Core Code Intelligence Systems

### AST Parsing & Code Intelligence (LSP)

Handled by:

- Serena MCP Server (Sidecar Container)
- Language Server backends (LSP) for TypeScript/JavaScript, Python, Go, Rust, etc.

Used for:

- Token-efficient symbol and class discovery (`get_symbols_overview`)
- Cross-file reference and call-graph tracing (`find_referencing_symbols`)
- Safe, AST-aware code editing (`replace_symbol_body`, `insert_after_symbol`)

### Fast Code Search

Used for:

- locating symbols
- tracing error messages

Recommended:

- ripgrep (integrated within Serena and available as local fallback)

### Semantic Search & History

Used for:

- relevant file retrieval
- issue-to-code mapping
- historical fix memory

Recommended:

- Qdrant Vector DB
- nomic-embed-text

---

## Repository Ingestion & RAG Indexing

To support semantic code search, repositories must be ingested and embedded in the Qdrant Vector DB.

### Target Architecture (GitHub App Installation / Hermes Integration)
1. **Initial Full Indexing**:
   - Triggered by GitHub App `installation` or `installation_repositories.added` webhook events (or Hermes workspace registration).
   - Clones the target repositories, chunkifies all source code files, generates embeddings using `nomic-embed-text` or user's own embedder, and stores them in Qdrant collections.
2. **Incremental Updates**:
   - Triggered by GitHub `push` webhook events.
   - Computes file diffs and updates modified files in Qdrant collections to keep the index fresh.

---

## Embedding Models

Used for:

- semantic retrieval
- similar issue detection
- context compression
- historical fix memory

---

## Validation System

Language auto detection supports:

- Node.js
- Python
- Go
- Rust
- PHP
- Java
- C#

Example commands:

npm test
pytest
cargo test
go test
phpunit

---

## Docker Sandbox Architecture

Each job runs inside isolated Docker containers.

Features:

- CPU limits
- memory limits
- temporary filesystem
- optional network restrictions
- automatic cleanup

---

## Repository & Agent Separation

### Main Repository

Contains:

- application code
- CI/CD
- issues

### LazyDev Engine Repository

Contains:

- agents
- orchestration
- validation engine
- Docker runners

---

## Final Workflow

Issue Opened
↓
Webhook Received
↓
Acquire Redis Locks
↓
Check Repository Cache (repo-cache/)
↓
Resolve Target Branch
(issue body hint → issue label hint → repo default branch)
↓
Create Temporary Worktree (Isolated Branch)
↓
Activate Project in Serena MCP Sidecar
↓
Run Multi-Agent Pipeline
├─ Issue Analyzer: Extract clean requirements
├─ Research Agent: Qdrant RAG + Serena LSP symbol analysis
├─ Planning Agent: Formulation of changes
└─ Patch Generator: Apply fix via Serena `replace_symbol_body`
↓
Create Docker Sandbox & Run Local Validation
↓
Commit Changes
↓
Push Branch
↓
Repository CI/CD Executes
↓
Observe CI/CD Result
↓
Send Discord/Slack Notification
↓
Release Redis Locks & Cleanup Worktree

---

## Final Recommended Tech Stack

| Layer | Recommendation |
|---|---|
| Backend | Node.js / NestJS |
| Queue | BullMQ |
| Distributed Locks | Redis + Redlock |
| Agent Orchestration | LangGraph |
| Sandbox | Docker |
| GitHub Integration | GitHub App |
| Database | PostgreSQL |
| Vector DB | Qdrant |
| Code Intelligence (AST/LSP) | Serena MCP (Sidecar) |
| Fast Search | ripgrep |
| Embeddings | nomic-embed-text |
| Hosted AI | OpenRouter |
| Local AI Fallback | Ollama |
| Notifications | Discord / Slack |
| Deployment | Docker Compose |

---

## Final Architectural Direction

LazyDev is an:

AI-native autonomous CI engineering assistant

with:

- multi-agent orchestration
- repository-aware branch workflows
- CI/CD-driven validation
- distributed job locking
- semantic code understanding
- Docker-isolated execution
- GitHub-native automation

while maintaining a critical safety boundary:

AI never merges code automatically.

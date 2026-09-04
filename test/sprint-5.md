# Sprint 5: Multi-Agent Orchestration Testing Guide

This guide outlines how to manually verify the LangGraph-based multi-agent pipeline implemented in Sprint 5. The pipeline consists of 6 core agents (Analyzer, Researcher, Planner, Patcher, Validator, Git) wired together via a `StateGraph`.

## Prerequisites

Before testing, ensure you have the necessary environment variables set up in your `.env` file:
- `OPENAI_API_KEY` (if using OpenAI or OpenRouter)
- `LLM_MODEL` (e.g., `gpt-4o-mini`)
- OR ensure `ollama serve` is running locally with the fallback model (e.g., `llama3`).

## Test Case 1: Agent State Compilation

**Goal**: Verify that the LangGraph `StateGraph` correctly compiles and links all agent nodes.

**Steps**:
1. Run the test script: `npx ts-node testing/test-orchestration.ts`
2. **Expected Output**: 
   You should see `Initializing Multi-Agent LangGraph...` in the console, followed by `Starting multi-agent pipeline...`. The graph should not throw any compilation errors regarding node definitions or edges.

## Test Case 2: Issue Analysis & Research

**Goal**: Verify that the `IssueAnalyzerAgent` and `ResearchAgent` correctly process an incoming mock issue payload and gather context.

**Steps**:
1. Run the test script: `npx ts-node testing/test-orchestration.ts`
2. **Expected Output**:
   - `[IssueAnalyzerAgent] Analyzing issue payload...`
   - `[ResearchAgent] Performing research based on issue analysis...`
   - `[ResearchAgent] Searching for keyword...`
   The LLM should extract keywords from the mock payload ("Fix typo in validation service") and attempt to grep the codebase for them.

## Test Case 3: Patch Generation & Validation (Mocked)

**Goal**: Verify that the `PlanningAgent` drafts a plan, and the `PatchGeneratorAgent` outputs a patch.

**Steps**:
1. Observe the terminal output from the previous script execution.
2. **Expected Output**:
   - `[PlanningAgent] Drafting implementation plan...`
   - `[PatchGeneratorAgent] Generating patch based on implementation plan...`
   - You should see the raw Markdown output of the generated code printed at the end of the script under `Generated Patch Preview`.
   - `[ValidationAgent] Validating generated patch...` (Mock validation succeeds).

## Test Case 4: Safety & Git Operations (Mocked)

**Goal**: Verify that the `GitAgent` is only invoked if validation succeeds and handles branch creation safely.

**Steps**:
1. Observe the final steps of the terminal output from the previous script execution.
2. **Expected Output**:
   - `[GitAgent] Preparing to commit and push changes...`
   - `[GitAgent] Created branch fix/ai-generated-... and pushed changes (mock).`
   - `IsValid: true`

*Note: In the Sprint 5 MVP, validation and git operations are safely mocked to prevent accidental pushes while the underlying diff-application sandbox is finalized in Sprint 6.*

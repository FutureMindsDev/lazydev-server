# Sprint 6: Patch Generation & Validation Testing Guide

This guide outlines how to manually verify the enhancements to the LangGraph-based multi-agent pipeline implemented in Sprint 6. The pipeline now performs structured patch generation, active sandbox validation (via Docker mock or Node.js host), dynamic retry loops, and stores an audit log in PostgreSQL.

## Prerequisites

Before testing, ensure you have the necessary environment variables set up in your `.env` file:
- `OPENAI_API_KEY` (if using OpenAI or OpenRouter)
- OR ensure `ollama serve` is running locally with the fallback model (e.g., `llama3`).
- PostgreSQL must be running, or use the mocked test script below.

## Test Case 1: Structured Patch Generation & Workspace Injection

**Goal**: Verify that the `PatchGeneratorAgent` writes the file patches directly to the `repo-cache/repo` workspace instead of just returning raw Markdown strings.

**Steps**:
1. Run the isolated test script: `npx ts-node testing/test-orchestration.ts`
2. **Expected Output**: 
   - `[PatchGeneratorAgent] Generating patch based on implementation plan...`
   - You should see the patch output being parsed, creating or editing files in `repo-cache/repo`.
   - The test script's console output for `Generated Patch Preview` will state `Modified files:` instead of returning the raw code, because the files were actually written to disk via `fs`.

## Test Case 2: Sandbox Execution & Build Validation

**Goal**: Verify that the `ValidationAgent` invokes the `SandboxService` to physically validate the repository rather than immediately returning a mocked success.

**Steps**:
1. Run the test script: `npx ts-node testing/test-orchestration.ts`
2. **Expected Output**:
   - `[ValidationAgent] Running validation sandbox (Attempt 1)...`
   - `Mock build success` or genuine NPM compilation errors based on the state of the workspace.

## Test Case 3: LangGraph Validation Retry Loop

**Goal**: Verify that if validation fails, the `OrchestrationService` conditional logic dynamically routes execution back to the `PatchGeneratorAgent` and passes the stderr feedback to the LLM.

**Steps**:
1. To test this, you can manually force the mock sandbox to throw an error in `testing/test-orchestration.ts`:
   ```ts
   class MockSandboxService {
     async executeCommand() {
       throw new Error('Mock compilation failed: TS2304 Cannot find name x.');
     }
   }
   ```
2. Run the test script: `npx ts-node testing/test-orchestration.ts`
3. **Expected Output**:
   - `[ValidationAgent] Validation failed: Mock compilation failed...`
   - `[OrchestrationService] Validation failed (Attempt 1). Retrying patch generation...`
   - `[PatchGeneratorAgent] Generating patch based on implementation plan...`
   - The cycle should repeat up to exactly 3 times before aborting: `[OrchestrationService] Validation failed 3 times. Aborting workflow.`

## Test Case 4: Audit Logging

**Goal**: Verify that the pipeline outcome is correctly packaged and logged to the `AuditLogService`.

**Steps**:
1. Check the test script output.
2. **Expected Output**:
   - `[OrchestrationService] Pipeline finished.`
   - `[AuditLogService] Audit log saved for issue #...`
   - The final `AgentState` object should contain the number of `validationAttempts`.

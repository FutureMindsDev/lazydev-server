import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RepositoryCacheService } from '../repository/repository-cache.service';
import { BranchResolverService } from '../repository/branch-resolver.service';
import { GitService } from '../git/git.service';
import { WorktreeManagerService } from '../git/worktree-manager.service';
import { LockService, AcquiredLock } from '../locks/lock.service';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { RagIngestionService } from '../intelligence/rag-ingestion.service';
import type { WorkKind } from '../common/work-kind';

export interface IssueJobData {
  repository: string; // e.g. "owner/repo"
  issueNumber: number;
  title: string;
  body: string | null;
  action: string;
  installationId: number;
  labels?: string[];
  /**
   * Whether this run repairs something or builds something new. Defaults to
   * `fix` (all webhook-driven runs); set to `feature` by the MCP
   * implement_new_feature tool so the branch/commit/PR are named correctly.
   */
  kind?: WorkKind;
}

@Processor('issue-processing', { concurrency: 1 })
export class IssueProcessor extends WorkerHost {
  private readonly logger = new Logger(IssueProcessor.name);

  constructor(
    private readonly repoCacheService: RepositoryCacheService,
    private readonly branchResolverService: BranchResolverService,
    private readonly gitService: GitService,
    private readonly worktreeManager: WorktreeManagerService,
    private readonly lockService: LockService,
    private readonly orchestrationService: OrchestrationService,
    private readonly ragIngestion: RagIngestionService,
  ) {
    super();
  }

  async process(job: Job<IssueJobData>): Promise<void> {
    const {
      repository,
      issueNumber,
      body,
      installationId,
      labels = [],
    } = job.data;

    // Parse owner/repo from full_name
    const [owner, repo] = repository.split('/');
    const jobId = job.id ?? `${repository}-${issueNumber}-${Date.now()}`;

    this.logger.log(
      `[Job ${jobId}] Processing issue #${issueNumber} for ${repository} (action: ${job.data.action})`,
    );

    // --- Lock tracking for finally-block cleanup ---
    let issueLock: AcquiredLock | null = null;
    let repoLock: AcquiredLock | null = null;
    let branchLock: AcquiredLock | null = null;

    // Hoisted (rather than `const` inside the try block) so both the success
    // path and the catch block below can pass them straight to
    // cleanupJobWorktree — that bypasses WorktreeManagerService's in-memory
    // registry, which does not survive a process restart between job start
    // and completion and would otherwise silently orphan the directory.
    let repoPath: string | undefined;
    let worktreePath: string | undefined;

    try {
      // Step 1: Acquire issue lock — prevents duplicate processing of same issue
      this.logger.log(
        `[Job ${jobId}] Acquiring issue lock for #${issueNumber}`,
      );
      issueLock = await this.lockService.acquireIssueLock(
        owner,
        repo,
        issueNumber,
      );

      // Step 2: Resolve the target branch
      this.logger.log(`[Job ${jobId}] Resolving target branch`);
      const resolved = await this.branchResolverService.resolve(
        owner,
        repo,
        installationId,
        body,
        labels,
      );
      this.logger.log(
        `[Job ${jobId}] Target branch resolved: "${resolved.branchName}" (source: ${resolved.source})`,
      );

      // Step 3: Acquire repository lock — prevents concurrent clones/fetches
      this.logger.log(`[Job ${jobId}] Acquiring repo lock for ${repository}`);
      repoLock = await this.lockService.acquireRepoLock(owner, repo);

      // Step 4: Ensure repo is cloned/fetched into local cache
      this.logger.log(`[Job ${jobId}] Ensuring repository cache`);
      repoPath = await this.repoCacheService.ensureRepo(
        owner,
        repo,
        installationId,
      );
      this.logger.log(`[Job ${jobId}] Repository available at: ${repoPath}`);

      // Step 5: Acquire branch lock — prevents concurrent checkouts of same branch
      this.logger.log(
        `[Job ${jobId}] Acquiring branch lock for "${resolved.branchName}"`,
      );
      branchLock = await this.lockService.acquireBranchLock(
        owner,
        repo,
        resolved.branchName,
      );

      // Step 6: Create isolated worktree for this job
      this.logger.log(`[Job ${jobId}] Creating isolated worktree`);
      worktreePath = await this.worktreeManager.createJobWorktree(
        jobId,
        repoPath,
        resolved.branchName,
      );
      this.logger.log(`[Job ${jobId}] Worktree ready at: ${worktreePath}`);

      // Step 8: Release branch and repo locks — worktree is now isolated
      await this.lockService.release(branchLock);
      branchLock = null;
      await this.lockService.release(repoLock);
      repoLock = null;

      this.logger.log(
        `[Job ${jobId}] ✅ Workspace ready — indexing repo for RAG`,
      );

      // Step 7a: Ingest the worktree into Qdrant for RAG retrieval
      const collectionName = repository.replace(/[^a-zA-Z0-9_]/g, '_');
      try {
        await this.ragIngestion.ingestWorktree(worktreePath, collectionName);
      } catch (ragErr: any) {
        // Non-fatal — log and continue; PlannerAgent falls back to ripgrep
        this.logger.warn(
          `[Job ${jobId}] RAG ingestion failed (non-fatal): ${ragErr.message}`,
        );
      }

      this.logger.log(
        `[Job ${jobId}] ✅ RAG indexed — launching multi-agent pipeline`,
      );

      // Step 7: Run the full multi-agent LangGraph pipeline
      // Shape the payload to match the GitHub webhook structure that agents expect
      await this.orchestrationService.runPipeline({
        issue: {
          number: issueNumber,
          title: job.data.title,
          body: job.data.body || '',
        },
        repository: {
          full_name: repository,
          name: repo,
          owner: { login: owner },
          default_branch: resolved.branchName,
        },
        installation: { id: installationId },
        // Extra runtime context for agents that need the filesystem path.
        // worktreePath is the ephemeral per-job checkout (deleted when the job
        // finishes) — used for reading/writing actual source files. repoPath is
        // the persistent, shared repo-cache clone for this repo (reused across
        // every job) — agents activate it in Serena when they need a memory
        // (global_repo_structure, historical_issues_and_lessons) to survive
        // beyond this one job.
        worktreePath,
        repoPath,
        labels,
        // Correlates this run with the MCP task id so human feedback submitted
        // via the MCP server can be picked up mid-pipeline.
        taskId: jobId,
        // Drives branch prefix, commit type and PR title in the GitAgent.
        kind: job.data.kind ?? 'fix',
      });

      this.logger.log(`[Job ${jobId}] ✅ Pipeline completed successfully`);

      // Step 8: Cleanup worktree after job completes
      await this.worktreeManager.cleanupJobWorktree(
        jobId,
        repoPath && worktreePath ? { repoPath, worktreePath } : undefined,
      );
      this.logger.log(`[Job ${jobId}] Worktree cleaned up`);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `[Job ${jobId}] Job failed for issue #${issueNumber}: ${err.message}`,
        err.stack,
      );

      // Best-effort worktree cleanup on failure. Pass the paths explicitly
      // (when we got far enough to have them) rather than relying on
      // WorktreeManagerService's in-memory registry, which is exactly what a
      // process restart mid-job wipes — this is the one cleanup call that
      // most needs to survive that, since a failing job is the most likely
      // to coincide with a crash.
      try {
        await this.worktreeManager.cleanupJobWorktree(
          jobId,
          repoPath && worktreePath ? { repoPath, worktreePath } : undefined,
        );
      } catch (cleanupError: unknown) {
        const cErr =
          cleanupError instanceof Error
            ? cleanupError
            : new Error(String(cleanupError));
        this.logger.warn(
          `[Job ${jobId}] Worktree cleanup failed: ${cErr.message}`,
        );
      }

      // Re-throw so BullMQ can retry or move to dead-letter queue
      throw error;
    } finally {
      // Always release all held locks — order: branch → repo → issue
      if (branchLock) await this.lockService.release(branchLock);
      if (repoLock) await this.lockService.release(repoLock);
      if (issueLock) await this.lockService.release(issueLock);
      this.logger.log(`[Job ${jobId}] All locks released`);
    }
  }
}

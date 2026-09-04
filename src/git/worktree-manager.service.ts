import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from './git.service';

/** Directories older than this with no in-memory record are treated as orphans. */
const DEFAULT_ORPHAN_MAX_AGE_HOURS = 6;

export interface WorktreeHandle {
  jobId: string;
  repoPath: string;
  worktreePath: string;
  branchName: string;
  createdAt: Date;
}

@Injectable()
export class WorktreeManagerService implements OnModuleInit {
  private readonly logger = new Logger(WorktreeManagerService.name);

  /**
   * In-memory map of active worktrees keyed by jobId.
   *
   * This does NOT survive a process restart — a crash, a `--watch` reload, or
   * a `docker compose up --build` between `createJobWorktree` and
   * `cleanupJobWorktree` empties it, and cleanup would otherwise have no way
   * to know what to remove, orphaning the directory forever. Callers that
   * already hold the paths (see `IssueProcessor`) should pass them explicitly
   * to `cleanupJobWorktree` rather than relying on this map; it exists mainly
   * for `listActiveWorktrees()`/observability, and `onModuleInit` sweeps up
   * whatever it missed on the last run.
   */
  private readonly activeWorktrees = new Map<string, WorktreeHandle>();

  constructor(private readonly gitService: GitService) {}

  /**
   * Startup reconciliation: removes worktree directories left behind by a
   * previous process instance that never got to clean up after itself. Only
   * targets directories old enough (default 6h) that they cannot belong to a
   * job that's still legitimately in flight after a fast restart.
   */
  async onModuleInit(): Promise<void> {
    await this.reconcileOrphanedWorktrees();
  }

  /**
   * Creates an isolated worktree for a job.
   * Registers the handle in memory for later cleanup.
   *
   * @returns The worktree path for the job to operate in
   */
  async createJobWorktree(
    jobId: string,
    repoPath: string,
    branchName: string,
  ): Promise<string> {
    const worktreePath = this.gitService.buildWorktreePath(jobId);

    this.logger.log(
      `Creating worktree for job ${jobId} — branch: ${branchName}`,
    );

    // Ensure parent directory exists
    const parentDir = path.dirname(worktreePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    await this.gitService.createWorktree(repoPath, worktreePath, branchName);

    const handle: WorktreeHandle = {
      jobId,
      repoPath,
      worktreePath,
      branchName,
      createdAt: new Date(),
    };

    this.activeWorktrees.set(jobId, handle);
    this.logger.log(`Worktree registered for job ${jobId} at ${worktreePath}`);

    return worktreePath;
  }

  /**
   * Cleans up the worktree for a job. Removes the worktree from disk and the
   * active registry.
   *
   * `knownPaths` lets a caller that already holds `repoPath`/`worktreePath`
   * (e.g. `IssueProcessor`, which has them as local variables) clean up
   * without depending on the in-memory registry — the registry is wiped by a
   * process restart, but the caller's own locals are not. Falls back to the
   * registry lookup when not provided, for any other caller.
   */
  async cleanupJobWorktree(
    jobId: string,
    knownPaths?: { repoPath: string; worktreePath: string },
  ): Promise<void> {
    const handle = this.activeWorktrees.get(jobId) ?? knownPaths;

    if (!handle) {
      this.logger.warn(
        `No active worktree found for job ${jobId} — skipping cleanup`,
      );
      return;
    }

    this.logger.log(`Cleaning up worktree for job ${jobId}`);

    await this.gitService.removeWorktree(handle.repoPath, handle.worktreePath);

    this.activeWorktrees.delete(jobId);
    this.logger.log(`Worktree cleanup complete for job ${jobId}`);
  }

  /**
   * Returns the worktree handle for a job, or undefined if not found.
   */
  getWorktreeHandle(jobId: string): WorktreeHandle | undefined {
    return this.activeWorktrees.get(jobId);
  }

  /**
   * Returns all currently active worktrees.
   * Useful for observability and recovery on restart.
   */
  listActiveWorktrees(): WorktreeHandle[] {
    return Array.from(this.activeWorktrees.values());
  }

  /**
   * Scans the worktree base directory for leftovers this (freshly started)
   * process has no record of, and removes the ones old enough to be safely
   * considered dead rather than mid-flight.
   */
  private async reconcileOrphanedWorktrees(): Promise<void> {
    const base = process.env.WORKTREE_BASE_PATH ?? '/app/worktrees';
    const maxAgeHours = Number(
      process.env.WORKTREE_ORPHAN_MAX_AGE_HOURS ?? DEFAULT_ORPHAN_MAX_AGE_HOURS,
    );
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

    if (!fs.existsSync(base)) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (e: unknown) {
      this.logger.warn(
        `Could not scan ${base} for orphaned worktrees: ${(e as Error).message}`,
      );
      return;
    }

    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || this.activeWorktrees.has(entry.name)) {
        continue;
      }

      const worktreePath = path.join(base, entry.name);
      let ageMs: number;
      try {
        ageMs = Date.now() - fs.statSync(worktreePath).mtime.getTime();
      } catch {
        continue;
      }
      if (ageMs < maxAgeMs) continue; // too recent — may belong to an in-flight job

      this.logger.warn(
        `Found orphaned worktree "${entry.name}" (age ${(ageMs / 3_600_000).toFixed(1)}h, no in-memory record) — ` +
          `most likely left behind by a process restart mid-job. Removing.`,
      );

      try {
        await this.removeOrphanDirectory(worktreePath);
        removed++;
      } catch (e: unknown) {
        this.logger.error(
          `Failed to remove orphaned worktree ${worktreePath}: ${(e as Error).message}`,
        );
      }
    }

    if (removed > 0) {
      this.logger.log(
        `Startup reconciliation removed ${removed} orphaned worktree(s).`,
      );
    }
  }

  /**
   * Removes an orphaned worktree whose owning repo we no longer have a
   * record of. Re-derives it from the worktree's own `.git` file (which
   * always points at `<repo>/.git/worktrees/<name>`) so `git worktree
   * remove` still runs from the right place and properly deregisters it —
   * a raw filesystem delete alone would leave stale admin metadata behind in
   * the original repo-cache clone's `.git/worktrees/`.
   */
  private async removeOrphanDirectory(worktreePath: string): Promise<void> {
    const repoPath = this.resolveOriginalRepoPath(worktreePath);
    if (repoPath) {
      try {
        await this.gitService.removeWorktree(repoPath, worktreePath);
        return;
      } catch (e: unknown) {
        this.logger.warn(
          `git worktree remove failed for orphan ${worktreePath} (${(e as Error).message}); falling back to a raw filesystem delete.`,
        );
      }
    }
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  /** Reads a worktree's `.git` file to find the main repository it belongs to. */
  private resolveOriginalRepoPath(worktreePath: string): string | null {
    try {
      const content = fs.readFileSync(path.join(worktreePath, '.git'), 'utf8');
      const match = content.match(/gitdir:\s*(.+)/);
      if (!match) return null;

      // "<repo>/.git/worktrees/<name>" -> "<repo>"
      const repoRoot = match[1]
        .trim()
        .replace(/[/\\]\.git[/\\]worktrees[/\\][^/\\]+[/\\]?$/, '');
      return repoRoot === match[1].trim() ? null : repoRoot;
    } catch {
      return null;
    }
  }
}

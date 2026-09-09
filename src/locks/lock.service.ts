/**
 * Copyright (c) 2026 FutureMindsDev. All rights reserved.
 *
 * LazyDev™ is a trademark of FutureMindsDev.
 * Organization : https://github.com/FutureMindsDev
 *
 * Authors:
 *   Arkar Chan Myae  <https://github.com/arkar-chanmyae>
 *   Khin Me Me Latt  <https://github.com/KhinMeMeLatt>
 *
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 */

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redlock from 'redlock';
import Redis from 'ioredis';

// Redlock v5 types are structurally complex — we use these local aliases
// to avoid re-declaring what the library exposes.
type RedlockLock = Awaited<ReturnType<Redlock['acquire']>>;

export interface AcquiredLock {
  lock: RedlockLock;
  heartbeatInterval?: ReturnType<typeof setInterval>;
}

@Injectable()
export class LockService implements OnModuleInit {
  private readonly logger = new Logger(LockService.name);
  private readonly redlock: Redlock;
  private readonly redis: Redis;

  /** Default TTL for repo and branch locks (ms) — 10 min to survive a fresh git clone */
  private readonly DEFAULT_TTL = 600_000;

  /** Default TTL for issue locks — 15 min covers the full multi-agent pipeline (ms) */
  private readonly ISSUE_LOCK_TTL = 900_000;

  /** Heartbeat renewal interval (ms) — well under DEFAULT_TTL */
  private readonly HEARTBEAT_INTERVAL = 30_000;

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
    });

    // Built synchronously in the constructor rather than in onModuleInit:
    // Redlock doesn't need to await a connection (ioredis buffers commands
    // until connected), but BullMQ's Worker can start pulling already-queued
    // jobs the moment IssueProcessor is instantiated — there's no guarantee
    // Nest runs LockService's onModuleInit first. On a fresh container start
    // with jobs already sitting in Redis (e.g. a retried job from before a
    // rebuild), that race let `acquire()` run against a still-undefined
    // `this.redlock`.
    this.redlock = new Redlock([this.redis], {
      // Retry 10 times with exponential backoff + jitter
      retryCount: 10,
      retryDelay: 200,
      retryJitter: 100,
      // Drift factor for clock drift tolerance
      driftFactor: 0.01,
      automaticExtensionThreshold: 500,
    });

    this.redlock.on('error', (error: Error) => {
      // Suppress ResourceLockedError — it's expected under contention
      if (!error.message.includes('ResourceLockedError')) {
        this.logger.error(`Redlock error: ${error.message}`);
      }
    });
  }

  async onModuleInit() {
    // On startup, clear any stale lock keys left from a previous process crash.
    // Safe for single-instance deployments. Set LOCK_CLEAR_ON_STARTUP=false
    // if running multiple replicas to avoid clearing live locks on other instances.
    const shouldClear = process.env.LOCK_CLEAR_ON_STARTUP !== 'false';
    if (shouldClear) {
      await this.clearStaleLocks();
    }

    this.logger.log('Redlock initialized');
  }

  /** Scan and delete all lock:* keys left over from a prior process crash */
  private async clearStaleLocks(): Promise<void> {
    try {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, found] = await this.redis.scan(
          cursor,
          'MATCH',
          'lock:*',
          'COUNT',
          100,
        );
        cursor = nextCursor;
        keys.push(...found);
      } while (cursor !== '0');

      if (keys.length > 0) {
        await this.redis.del(...keys);
        this.logger.warn(
          `Cleared ${keys.length} stale lock key(s) from previous process: ${keys.join(', ')}`,
        );
      } else {
        this.logger.log('No stale locks found on startup');
      }
    } catch (e: any) {
      this.logger.warn(`Could not clear stale locks: ${e.message}`);
    }
  }

  /**
   * Acquires a repository-level lock.
   * Key: lock:repo:owner/repo
   */
  async acquireRepoLock(owner: string, repo: string): Promise<AcquiredLock> {
    const resource = `lock:repo:${owner}/${repo}`;
    return this.acquire(resource, this.DEFAULT_TTL);
  }

  /**
   * Acquires a branch-level lock.
   * Key: lock:branch:owner/repo:branchName
   */
  async acquireBranchLock(
    owner: string,
    repo: string,
    branchName: string,
  ): Promise<AcquiredLock> {
    const resource = `lock:branch:${owner}/${repo}:${branchName}`;
    return this.acquire(resource, this.DEFAULT_TTL);
  }

  /**
   * Acquires an issue-level lock.
   * Key: lock:issue:owner/repo:issueNumber
   * Longer TTL as the entire job processing runs under this lock.
   */
  async acquireIssueLock(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<AcquiredLock> {
    const resource = `lock:issue:${owner}/${repo}:${issueNumber}`;
    return this.acquire(resource, this.ISSUE_LOCK_TTL);
  }

  /**
   * Releases a lock and clears its heartbeat interval.
   * Safe to call in finally blocks — will not throw if already released.
   */
  async release(acquired: AcquiredLock): Promise<void> {
    if (acquired.heartbeatInterval) {
      clearInterval(acquired.heartbeatInterval);
    }

    try {
      await this.redlock.release(acquired.lock);
      this.logger.debug(`Released lock: ${acquired.lock.resources.join(', ')}`);
    } catch (error: unknown) {
      // Lock may have expired — log but don't throw
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Lock release warning: ${msg}`);
    }
  }

  /**
   * Internal: acquires a Redlock lock and starts a heartbeat renewal interval
   * to keep the lock alive for long-running jobs.
   */
  private async acquire(resource: string, ttl: number): Promise<AcquiredLock> {
    this.logger.log(`Acquiring lock: ${resource} (TTL: ${ttl}ms)`);

    const lock = await this.redlock.acquire([resource], ttl);

    this.logger.log(`Lock acquired: ${resource}`);

    // Start heartbeat renewal so the lock doesn't expire mid-job.
    // IMPORTANT: Redlock v5's extend() returns a NEW lock object with a fresh
    // expiry. We must capture it in `currentLock` on every renewal, otherwise
    // the second renewal attempts to extend the original (now expired) lock and
    // throws "Cannot extend an already-expired lock".
    let currentLock = lock;
    const heartbeatInterval = setInterval(() => {
      void (async () => {
        try {
          currentLock = await this.redlock.extend(currentLock, ttl);
          this.logger.debug(`Lock renewed: ${resource}`);
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Failed to renew lock ${resource}: ${msg}`);
          clearInterval(heartbeatInterval);
        }
      })();
    }, this.HEARTBEAT_INTERVAL);

    return { lock, heartbeatInterval };
  }
}

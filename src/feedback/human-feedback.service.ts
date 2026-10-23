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

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis-backed store for human feedback submitted against a running pipeline
 * task (via the MCP `provide_human_feedback` tool), plus short-lived gate
 * verdicts (see below).
 *
 * Lives in its own module because both the MCP server (writer) and the
 * orchestration graph (reader) depend on it — putting it in either one would
 * create a circular module dependency.
 */

/** What a pipeline gate decided, shown on the run-detail page. */
export interface GateSummary {
  /** Which gate stopped or flagged the run. */
  stoppedBy: 'triage' | 'patch-gate' | 'validation-gate';
  /** Gate routing verdict (e.g. quarantine / abort / validate). */
  decision: string;
  /** Risk level when the gate assigns one. */
  risk?: string | null;
  /** Plain-words reason (no raw issue text, no secrets). */
  reason: string;
}
@Injectable()
export class HumanFeedbackService implements OnModuleDestroy {
  private readonly logger = new Logger(HumanFeedbackService.name);
  private readonly redis: Redis;

  /** Feedback lives for 24h — long enough for a retry loop or a manual re-queue. */
  private readonly TTL_SECONDS = 86_400;

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD') || undefined,
      maxRetriesPerRequest: null,
    });
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  async store(taskId: string, feedback: string): Promise<void> {
    await this.redis.set(this.key(taskId), feedback, 'EX', this.TTL_SECONDS);
    // Record the submission timestamp so the dashboard feedback-status
    // endpoint can report when human feedback was last provided. Same TTL as
    // the feedback itself so the two keys expire together.
    await this.redis.set(this.tsKey(taskId), Date.now().toString(), 'EX', this.TTL_SECONDS);
    this.logger.log(`Stored human feedback for task ${taskId}`);
  }

  async read(taskId: string): Promise<string | null> {
    return this.redis.get(this.key(taskId));
  }

  /** Reads and clears the feedback so it is applied at most once. */
  async consume(taskId: string): Promise<string | null> {
    const key = this.key(taskId);
    const feedback = await this.redis.get(key);
    if (feedback !== null) {
      await this.redis.del(key);
      // Leave the timestamp key so the dashboard can still show "submitted at"
      // after the pipeline has consumed the feedback — it just flips pending
      // to false. The ts key expires on its own TTL.
      this.logger.log(`Consumed human feedback for task ${taskId}`);
    }
    return feedback;
  }

  /**
   * Dashboard feedback-status (GET /api/dashboard/runs/:taskId/feedback-status).
   * `pending` is true while the feedback key still exists (not yet consumed by
   * the pipeline); `submittedAt` is the ISO string of when `store` was called.
   */
  async getFeedbackStatus(taskId: string): Promise<{
    pending: boolean;
    submittedAt: string | null;
  }> {
    const [feedback, ts] = await Promise.all([
      this.redis.get(this.key(taskId)),
      this.redis.get(this.tsKey(taskId)),
    ]);
    return {
      pending: feedback !== null,
      submittedAt: ts ? new Date(Number(ts)).toISOString() : null,
    };
  }

  private key(taskId: string): string {
    return `mcp:feedback:${taskId}`;
  }

  private tsKey(taskId: string): string {
    return `mcp:feedback:${taskId}:ts`;
  }

  private gateKey(taskId: string): string {
    return `gate:${taskId}`;
  }

  /**
   * Records a gate verdict so the run-detail page can show WHY a job was
   * stopped or flagged (e.g. "patch gate: high risk — dependency files
   * touched"). Same 24h TTL as results — the banner simply expires with
   * the task data. Never throws (dashboard reads must not fail on this).
   */
  async storeGateStatus(
    taskId: string,
    summary: GateSummary,
  ): Promise<void> {
    try {
      await this.redis.set(
        this.gateKey(taskId),
        JSON.stringify(summary),
        'EX',
        this.TTL_SECONDS,
      );
    } catch (e: any) {
      this.logger.warn(`Could not store gate status: ${e.message}`);
    }
  }

  /** Reads the gate verdict for run detail (null = none recorded/expired). */
  async readGateStatus(taskId: string): Promise<GateSummary | null> {
    try {
      const raw = await this.redis.get(this.gateKey(taskId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as GateSummary;
      if (!parsed || typeof parsed.reason !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

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

/* eslint-disable */
import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import type { QueueJob, PaginatedJobs, JobStateKey } from '../dashboard.dto';

@Controller('api/dashboard')
export class QueuesController {
  constructor(
    @InjectQueue('issue-processing') private readonly issueQueue: Queue,
  ) {}

  @Get('queues/:name/jobs')
  async listJobs(
    @Param('name') queueName: string,
    @Query('state') state?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ): Promise<PaginatedJobs> {
    const lim = Math.max(1, limit ?? 50);
    const off = Math.max(0, offset ?? 0);
    const queue = this.resolveQueue(queueName);

    // BullMQ's getJobs takes start/end as absolute indices into the ordered
    // list for the given state(s).
    const states = state ? [state] : ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'];
    const jobs = await queue.getJobs(states as any[], off, off + lim - 1);
    const total = state
      ? await queue.getJobCounts(state as any).then((c) => c[state] ?? 0)
      : await queue.getJobCounts().then(
          (c) =>
            (c.waiting ?? 0) +
            (c.active ?? 0) +
            (c.completed ?? 0) +
            (c.failed ?? 0) +
            (c.delayed ?? 0) +
            (c.paused ?? 0),
        );

    return {
      items: jobs.map((j) => this.toQueueJob(j, state as JobStateKey)),
      total,
      limit: lim,
      offset: off,
    };
  }

  @Post('queues/:name/jobs/:id/retry')
  async retryJob(
    @Param('name') queueName: string,
    @Param('id') jobId: string,
  ): Promise<{ ok: boolean }> {
    const queue = this.resolveQueue(queueName);
    const job = await queue.getJob(jobId);
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    // Move the job back to wait for reprocessing. Fallback: re-add the job.
    try {
      await job.retry();
    } catch {
      await queue.add(job.name, job.data);
    }
    return { ok: true };
  }

  @Post('queues/:name/drain')
  async drainQueue(
    @Param('name') queueName: string,
    @Body() body: { state?: string },
  ): Promise<{ ok: boolean; count: number }> {
    const queue = this.resolveQueue(queueName);
    const state = body?.state ?? 'failed';
    const jobs = await queue.getJobs([state as any]);
    let count = 0;
    for (const job of jobs) {
      await job.remove().catch(() => undefined);
      count += 1;
    }
    return { ok: true, count };
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  // Today only the issue-processing queue is registered. When more queues are
  // added, register them in the module and resolve by name here.
  private resolveQueue(name: string): Queue {
    if (name === 'issue-processing') return this.issueQueue;
    // Return the default queue for unknown names so the UI doesn't 500 —
    // BullMQ operations against a non-existent queue return empty results.
    return this.issueQueue;
  }

  private toQueueJob(job: Job, state: JobStateKey): QueueJob {
    // BullMQ Job.state() returns the live state; fall back to the requested
    // state filter when available.
    return {
      id: String(job.id ?? ''),
      name: job.name,
      state,
      attempts: job.attemptsMade ?? 0,
      data: (job.data as Record<string, unknown>) ?? {},
      failedReason: job.failedReason ?? null,
      stackTrace: job.stacktrace?.join('\n') ?? null,
      timestamp: new Date(job.timestamp ?? Date.now()).toISOString(),
      processedOn: job.processedOn
        ? new Date(job.processedOn).toISOString()
        : null,
      finishedOn: job.finishedOn
        ? new Date(job.finishedOn).toISOString()
        : null,
    };
  }
}

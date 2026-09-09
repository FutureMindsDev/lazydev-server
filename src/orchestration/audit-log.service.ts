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
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { AgentState } from './graph.state';

/** Query params for the dashboard runs listing (GET /api/dashboard/runs). */
export interface ListRunsQuery {
  installationId?: number;
  repo?: string;
  limit?: number;
  offset?: number;
  status?: 'SUCCESS' | 'FAILED';
  search?: string;
}

/** Paginated wrapper matching the frontend's Paginated<T> shape. */
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
  ) {}

  async logPipelineOutcome(state: AgentState): Promise<void> {
    try {
      const issueNumber = state.issuePayload?.issue?.number || 0;
      const issueTitle = state.issuePayload?.issue?.title || 'Unknown';
      const status = state.isValid ? 'SUCCESS' : 'FAILED';
      const repoFullName: string | undefined =
        state.issuePayload?.repository?.full_name;
      const installationId: number | undefined =
        state.issuePayload?.installation?.id;

      const log = this.auditLogRepository.create({
        taskId: state.issuePayload?.taskId,
        issueNumber,
        issueTitle,
        status,
        validationAttempts: state.validationAttempts || 0,
        finalValidationFeedback: state.validationFeedback,
        generatedPatch: state.generatedPatch,
        // New dashboard fields — all derived from AgentState at completion.
        installationId: installationId ?? null,
        repo: repoFullName ?? null,
        branch: state.branch ?? null,
        prUrl: state.prUrl ?? null,
        unappliedChanges: state.unappliedChanges ?? null,
        // triageContext may be an object (legacy analyzer output) or a string;
        // store a stringified form so the column stays text-typed.
        triageContext: this.stringifyTriage(state.triageContext),
        researchContext: state.researchContext ?? null,
        implementationPlan: state.implementationPlan ?? null,
      });

      await this.auditLogRepository.save(log);
      this.logger.log(`Audit log saved for issue #${issueNumber}`);
    } catch (e: any) {
      this.logger.error(`Failed to save audit log: ${e.message}`);
    }
  }

  /**
   * Looks up the audit record for an MCP task. Used as the status fallback once
   * the BullMQ job has been evicted from Redis.
   */
  async findByTaskId(taskId: string): Promise<AuditLog | null> {
    return this.auditLogRepository.findOne({
      where: { taskId },
      order: { createdAt: 'DESC' },
    });
  }

  async getMetrics(): Promise<{ total: number; success: number; failed: number }> {
    const total = await this.auditLogRepository.count();
    const success = await this.auditLogRepository.count({ where: { status: 'SUCCESS' } });
    const failed = await this.auditLogRepository.count({ where: { status: 'FAILED' } });

    return { total, success, failed };
  }

  /**
   * Paginated, filtered listing for GET /api/dashboard/runs.
   *
   * `search` matches issueTitle (ILIKE), issueNumber (exact), or taskId
   * (ILIKE) — OR'd together. `status` and `repo` are exact matches.
   * `installationId` is the Mode B tenancy wall. Sorted by createdAt DESC.
   */
  async listRuns(query: ListRunsQuery): Promise<Paginated<AuditLog>> {
    const limit = Math.max(1, query.limit ?? 50);
    const offset = Math.max(0, query.offset ?? 0);

    // search is an OR across three fields — TypeORM can't express that inside
    // a single FindOptionsWhere, so build the whole query with a query builder.
    const qb = this.auditLogRepository.createQueryBuilder('log');

    if (query.installationId !== undefined) {
      qb.andWhere('log.installationId = :installationId', {
        installationId: query.installationId,
      });
    }
    if (query.status) {
      qb.andWhere('log.status = :status', { status: query.status });
    }
    if (query.repo) {
      qb.andWhere('log.repo = :repo', { repo: query.repo });
    }
    if (query.search) {
      const s = `%${query.search}%`;
      const asNum = Number(query.search);
      const numClause = Number.isFinite(asNum)
        ? 'log.issueNumber = :issueNum'
        : '1=0';
      qb.andWhere(
        `(${numClause} OR LOWER(log.issueTitle) LIKE LOWER(:s) OR LOWER(log.taskId) LIKE LOWER(:s))`,
        { issueNum: asNum, s },
      );
    }

    qb.orderBy('log.createdAt', 'DESC')
      .skip(offset)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, limit, offset };
  }

  /**
   * Single run detail for GET /api/dashboard/runs/:taskId.
   * Returns the most recent audit log for the taskId (a retried issue can
   * produce multiple logs sharing a taskId).
   */
  async getRunDetail(taskId: string): Promise<AuditLog | null> {
    return this.auditLogRepository.findOne({
      where: { taskId },
      order: { createdAt: 'DESC' },
    });
  }

  private stringifyTriage(ctx: unknown): string | null {
    if (ctx === undefined || ctx === null) return null;
    if (typeof ctx === 'string') return ctx;
    try {
      return JSON.stringify(ctx);
    } catch {
      return null;
    }
  }
}

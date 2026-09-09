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
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { AuditLog } from '../orchestration/entities/audit-log.entity';
import { AuditLogService, ListRunsQuery, Paginated } from '../orchestration/audit-log.service';
import { HumanFeedbackService } from '../feedback/human-feedback.service';
import { RepositoryCache } from '../repository/entities/repository-cache.entity';
import { VectorDbService } from '../intelligence/vector-db.service';
import { LlmConfigService } from '../orchestration/llm-config.service';
import { LlmProviderConfigService } from '../orchestration/llm-provider-config.service';
import { LlmService, providerLabel } from '../orchestration/llm.service';
import {
  AuditLogDto,
  DashboardMeta,
  FeedbackStatus,
  RunDetailDto,
  RepositoryDto,
  SettingsDto,
  ByokSettingsDto,
  UpdateLlmSettingsRequest,
  LlmProviderId,
  GrafanaConfig,
  GrafanaDashboard,
  RepoIndexStats,
  ProviderConfigDto,
  CreateProviderConfigRequest,
  UpdateProviderConfigRequest,
} from './dashboard.dto';
import { derivePipelineStages } from './pipeline-stages.helper';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly humanFeedbackService: HumanFeedbackService,
    @InjectRepository(RepositoryCache)
    private readonly repoCacheRepo: Repository<RepositoryCache>,
    private readonly vectorDbService: VectorDbService,
    private readonly llmConfigService: LlmConfigService,
    private readonly llmService: LlmService,
    private readonly providerConfigService: LlmProviderConfigService,
  ) {}

  // ── #1 meta ──────────────────────────────────────────────────────────────
  getMeta(): DashboardMeta {
    // `||` (not the ConfigService default arg) so an empty-string env value
    // — which dotenv produces from `DEPLOYMENT_MODE=` — falls back to the
    // default instead of being returned verbatim and breaking the frontend.
    const deploymentMode = (this.configService.get<string>(
      'DEPLOYMENT_MODE',
    ) || 'selfhosted') as DashboardMeta['deploymentMode'];
    const auth = (this.configService.get<string>(
      'DASHBOARD_AUTH',
    ) || 'none') as DashboardMeta['auth'];

    // Mode A (selfhosted + auth none) has no current user. Mode B user
    // resolution is handled by the auth controller/session; meta returns the
    // session-derived user when available. For now, in selfhosted/none there
    // is no currentUser.
    return { deploymentMode, auth };
  }

  // ── #0 metrics (legacy /metrics route) ───────────────────────────────────
  // Returns BullMQ job counts + audit log stats. The queue is passed in by
  // the controller (which injects it via @InjectQueue) rather than injected
  // here, to keep DashboardService independent of BullMQ's queue registry.
  async getMetrics(issueQueue: Queue): Promise<Record<string, unknown>> {
    const jobCounts = await issueQueue.getJobCounts();
    const auditStats = await this.auditLogService.getMetrics();
    return {
      queues: {
        'issue-processing': jobCounts,
      },
      auditLogs: auditStats,
      status: 'operational',
      timestamp: new Date().toISOString(),
    };
  }

  // ── #2 runs list ─────────────────────────────────────────────────────────
  async listRuns(query: ListRunsQuery): Promise<Paginated<AuditLogDto>> {
    const page = await this.auditLogService.listRuns(query);
    return {
      items: page.items.map((log) => this.toAuditLogDto(log)),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  // ── #3 run detail ────────────────────────────────────────────────────────
  async getRunDetail(taskId: string): Promise<RunDetailDto | null> {
    const log = await this.auditLogService.getRunDetail(taskId);
    if (!log) return null;

    const feedbackStatus: FeedbackStatus =
      await this.humanFeedbackService.getFeedbackStatus(taskId);

    return {
      ...this.toAuditLogDto(log),
      repo: log.repo,
      branch: log.branch,
      prUrl: log.prUrl,
      unappliedChanges: log.unappliedChanges,
      triageContext: log.triageContext,
      researchContext: log.researchContext,
      implementationPlan: log.implementationPlan,
      pipelineStages: derivePipelineStages(log),
      feedbackStatus,
    };
  }

  // ── #4 feedback submit ───────────────────────────────────────────────────
  async submitFeedback(taskId: string, feedback: string): Promise<{
    ok: boolean;
    pending: boolean;
  }> {
    await this.humanFeedbackService.store(taskId, feedback);
    const status = await this.humanFeedbackService.getFeedbackStatus(taskId);
    return { ok: true, pending: status.pending };
  }

  // ── #5 feedback status ───────────────────────────────────────────────────
  async getFeedbackStatus(taskId: string): Promise<FeedbackStatus> {
    return this.humanFeedbackService.getFeedbackStatus(taskId);
  }

  // ── #10 repos list ───────────────────────────────────────────────────────
  async listRepos(installationId?: number): Promise<RepositoryDto[]> {
    const where: Record<string, unknown> = {};
    if (installationId !== undefined) {
      where.installationId = installationId;
    }
    const repos = await this.repoCacheRepo.find({ where });
    return repos.map((r) => this.toRepositoryDto(r));
  }

  // ── #11 resync repo ──────────────────────────────────────────────────────
  async resyncRepo(repoId: string, issueQueue: Queue): Promise<boolean> {
    const repo = await this.repoCacheRepo.findOne({ where: { id: repoId } });
    if (!repo) return false;
    // Mark in_progress so the UI reflects the re-index immediately.
    repo.onboardingStatus = 'in_progress';
    await this.repoCacheRepo.save(repo);
    // Re-enqueue an onboarding job. The processor re-clones/fetches and
    // re-indexes into Qdrant; on completion the RAG ingestion path flips
    // onboardingStatus back to 'indexed' (and indexedFiles is updated).
    await issueQueue.add(
      'onboard-repo',
      {
        repository: repo.fullName,
        issueNumber: 0,
        title: '',
        body: null,
        action: 'resync',
        installationId: repo.installationId ?? 0,
        labels: [],
      },
      {
        jobId: `resync-${repo.id}-${Date.now()}`,
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    );
    return true;
  }

  // ── #14 repo stats (Qdrant) ──────────────────────────────────────────────
  async getRepoStats(repoId: string): Promise<RepoIndexStats> {
    const repo = await this.repoCacheRepo.findOne({ where: { id: repoId } });
    const collectionName = repo
      ? repo.fullName.replace(/[^a-zA-Z0-9_]/g, '_')
      : 'unknown';

    let vectorSize = 0;
    let distance: RepoIndexStats['distance'] = 'Cosine';
    let pointsCount = 0;
    let indexedCount = 0;
    let status: RepoIndexStats['status'] = 'red';
    let diskUsageBytes = 0;

    try {
      const info: any = await this.vectorDbService.getCollection(collectionName);
      const vectors = info?.config?.params?.vectors;
      vectorSize = vectors?.size ?? 0;
      const dist = vectors?.distance;
      if (dist === 'Cosine' || dist === 'Dot' || dist === 'Euclid') {
        distance = dist;
      }
      pointsCount = info?.points_count ?? info?.vectors_count ?? 0;
      indexedCount =
        info?.indexed_vectors_count ?? info?.payload_schema?.indexed_fields_count ?? pointsCount;
      // Qdrant collection status: 'green' | 'yellow' | 'red' (or 'grey' for
      // initializing). Map anything unexpected to red.
      const rawStatus = info?.status;
      status = rawStatus === 'green' || rawStatus === 'yellow' ? rawStatus : 'red';
      diskUsageBytes =
        info?.disk_usage ?? info?.collection_info?.disk_usage ?? 0;
    } catch (e: any) {
      this.logger.warn(
        `Failed to fetch Qdrant stats for ${collectionName}: ${e.message}`,
      );
    }

    return {
      repoId,
      collectionName,
      vectorSize,
      distance,
      pointsCount,
      indexedCount,
      status,
      diskUsageBytes,
      lastIndexedAt: repo?.lastFetchedAt
        ? repo.lastFetchedAt.toISOString()
        : null,
    };
  }

  // ── #12 settings (masked) ────────────────────────────────────────────────
  /**
   * Settings view, optionally scoped to an installation. The `llm` block
   * mirrors getModel()'s resolution so the settings page shows what
   * pipelines actually run on: an effective BYOK row (installation's own,
   * else the global fallback) fully replaces the env default; otherwise the
   * env-configured provider is reported. The `byok` block carries the
   * masked details of the stored config (never the key itself).
   */
  async getSettings(installationId?: number): Promise<SettingsDto> {
    const byok = await this.llmConfigService.getMaskedInfo(
      installationId ?? null,
    );
    const providers = await this.llmConfigService.getMaskedProviders(
      installationId ?? null,
    );
    const envModel = this.configService.get<string>('LLM_MODEL', '');
    const fallbackModel =
      this.configService.get<string>('OLLAMA_LLM_MODEL') || null;

    const llm = byok.configured
      ? {
          provider: providerLabel(byok.baseUrl ?? undefined),
          model: byok.model ?? envModel,
          fallbackModel,
          source: 'byok' as const,
        }
      : {
          provider: this.detectLlmProvider(),
          model: envModel,
          fallbackModel,
          source: 'env' as const,
        };

    const networkModeRaw = this.configService.get<string>(
      'SANDBOX_NETWORK_MODE',
      'bridge',
    );
    const networkMode: SettingsDto['sandbox']['networkMode'] =
      networkModeRaw === 'none'
        ? 'none'
        : networkModeRaw === 'restricted'
          ? 'restricted'
          : 'unrestricted';

    const discordWebhook = this.configService.get<string>('DISCORD_WEBHOOK_URL');
    return {
      llm,
      byok,
      providers,
      sandbox: {
        networkMode,
        timeout: 120,
      },
      notifications: {
        discord: !!discordWebhook,
        discordWebhookMasked: discordWebhook
          ? this.maskUrl(discordWebhook)
          : null,
      },
      queue: {
        concurrency: 1,
        maxAttempts: 5,
      },
      database: {
        type: 'postgres',
        hostMasked: this.maskHost(
          this.configService.get<string>('DB_HOST', 'localhost'),
        ),
      },
    };
  }

  // ── #13 grafana ──────────────────────────────────────────────────────────
  getGrafanaConfig(): GrafanaConfig {
    const baseUrl = this.configService.get<string>('GRAFANA_BASE_URL', '').trim();
    if (!baseUrl) {
      return { enabled: false, baseUrl: '', dashboards: [] };
    }
    let dashboards: GrafanaDashboard[] = [];
    const rawDashboards = this.configService.get<string>('GRAFANA_DASHBOARDS');
    if (rawDashboards) {
      try {
        const parsed = JSON.parse(rawDashboards);
        if (Array.isArray(parsed)) dashboards = parsed;
      } catch (e: any) {
        this.logger.warn(`GRAFANA_DASHBOARDS is not valid JSON: ${e.message}`);
      }
    }
    return { enabled: true, baseUrl, dashboards };
  }

  // ── #14 BYOK LLM config write/delete ─────────────────────────────────────
  /**
   * Upserts the BYOK config for a scope (installationId, or the global
   * default row when omitted). Validation and encryption live in
   * LlmConfigService; after a successful write the LlmService's cached model
   * instances for the affected scope are dropped so the next pipeline run
   * rebuilds with the new key/model.
   */
  async updateLlmConfig(
    input: UpdateLlmSettingsRequest,
  ): Promise<ByokSettingsDto> {
    const masked = await this.llmConfigService.upsertConfig(input);
    this.llmService.invalidateInstallationModels(input.installationId ?? null);
    return masked;
  }

  /** Deletes the BYOK config row for a scope. Idempotent. */
  async deleteLlmConfig(installationId?: number): Promise<{ ok: boolean }> {
    const deleted = await this.llmConfigService.deleteConfig(
      installationId ?? null,
    );
    this.llmService.invalidateInstallationModels(installationId ?? null);
    return { ok: deleted };
  }

  // ── Multi-provider config CRUD ──────────────────────────────────────────

  async listProviders(installationId?: number): Promise<ProviderConfigDto[]> {
    return this.llmConfigService.getMaskedProviders(installationId ?? null);
  }

  async createProvider(
    input: CreateProviderConfigRequest,
  ): Promise<ProviderConfigDto> {
    const masked = await this.providerConfigService.create({
      installationId: input.installationId ?? null,
      label: input.label,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl ?? null,
      model: input.model,
    });
    // Invalidate LlmService cache so new provider configs are picked up.
    this.llmService.invalidateInstallationModels(input.installationId ?? null);
    return masked;
  }

  async updateProvider(
    id: string,
    input: UpdateProviderConfigRequest,
    installationId?: number,
  ): Promise<ProviderConfigDto> {
    const masked = await this.providerConfigService.update(
      id,
      input,
      installationId ?? null,
    );
    this.llmService.invalidateInstallationModels(installationId ?? null);
    return masked;
  }

  async deleteProvider(
    id: string,
    installationId?: number,
  ): Promise<{ ok: boolean }> {
    const deleted = await this.providerConfigService.delete(
      id,
      installationId ?? null,
    );
    if (deleted) {
      // Clear any agent assignments pointing at this provider.
      await this.llmConfigService.clearAssignmentsForProvider(
        id,
        installationId ?? null,
      );
      this.llmService.invalidateInstallationModels(installationId ?? null);
    }
    return { ok: deleted };
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private toAuditLogDto(log: AuditLog): AuditLogDto {
    return {
      id: log.id,
      taskId: log.taskId,
      issueNumber: log.issueNumber,
      issueTitle: log.issueTitle,
      status: log.status,
      validationAttempts: log.validationAttempts,
      finalValidationFeedback: log.finalValidationFeedback,
      generatedPatch: log.generatedPatch,
      createdAt: log.createdAt.toISOString(),
      installationId: log.installationId,
    };
  }

  private toRepositoryDto(r: RepositoryCache): RepositoryDto {
    return {
      id: r.id,
      owner: r.owner,
      name: r.repo,
      fullName: r.fullName,
      defaultBranch: r.defaultBranch,
      onboardingStatus: r.onboardingStatus,
      indexedFiles: r.indexedFiles,
      lastSync: r.lastFetchedAt ? r.lastFetchedAt.toISOString() : null,
      autoFix: r.autoFix,
      installationId: r.installationId,
    };
  }

  private detectLlmProvider(): LlmProviderId {
    const baseUrl = this.configService.get<string>('OPENAI_BASE_URL', '');
    const ollamaHost = this.configService.get<string>('OLLAMA_HOST');
    if (ollamaHost && !this.configService.get<string>('OPENAI_API_KEY')) {
      return 'ollama';
    }
    return providerLabel(baseUrl);
  }

  /** Masks the path/secret portion of a URL, keeping the host visible. */
  private maskUrl(url: string): string {
    try {
      const u = new URL(url);
      // Replace each path/secret segment with bullets, keep host + protocol.
      const segs = u.pathname.split('/').filter(Boolean);
      const masked = segs.map((s) => '••••').join('/');
      return `${u.protocol}//${u.host}/${masked}`;
    } catch {
      return '••••';
    }
  }

  /** Masks a DB host: keeps the TLD-ish suffix, bullets the rest. */
  private maskHost(host: string): string {
    if (host === 'localhost' || host === '127.0.0.1') return host;
    const dot = host.indexOf('.');
    if (dot <= 0) return '••••';
    return '••••••••' + host.slice(dot);
  }
}

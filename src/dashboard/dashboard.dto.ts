/* eslint-disable */
/**
 * DTOs for the dashboard control-plane API.
 *
 * These mirror the frontend's `src/lib/types.ts` exactly so that flipping
 * NEXT_PUBLIC_ENABLE_MOCKS=false hits the real API with zero component
 * changes. See BACKEND_API_SPEC.md in the frontend repo for the contract.
 *
 * Request DTOs (FeedbackRequest, UpdateLlmSettingsRequest,
 * CreateProviderConfigRequest, UpdateProviderConfigRequest) are classes
 * with class-validator decorators so the global ValidationPipe can
 * whitelist + validate incoming bodies. Response DTOs remain interfaces
 * since they're only used for output typing.
 */
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsObject,
  MaxLength,
} from 'class-validator';

export type RunStatus = 'SUCCESS' | 'FAILED';

export interface AuditLogDto {
  id: string;
  taskId: string;
  issueNumber: number;
  issueTitle: string;
  status: RunStatus;
  validationAttempts: number;
  finalValidationFeedback: string | null;
  generatedPatch: string | null;
  createdAt: string;
  installationId?: number | null;
}

export interface DashboardMeta {
  deploymentMode: 'selfhosted' | 'hosted';
  auth: 'none' | 'token' | 'github-oauth';
  currentUser?: {
    login: string;
    avatarUrl: string;
    installations: number[];
  };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export type PipelineNode =
  | 'onboarding'
  | 'analyzer'
  | 'research'
  | 'tools'
  | 'planner'
  | 'patcher'
  | 'validator'
  | 'human_feedback'
  | 'git';

export interface PipelineStage {
  node: PipelineNode;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  output?: string;
  attempt?: number;
}

export interface FeedbackStatus {
  pending: boolean;
  submittedAt: string | null;
}

export interface RunDetailDto extends AuditLogDto {
  repo?: string | null;
  branch?: string | null;
  prUrl?: string | null;
  unappliedChanges?: string | null;
  triageContext?: string | null;
  researchContext?: string | null;
  implementationPlan?: string | null;
  pipelineStages?: PipelineStage[];
  feedbackStatus?: FeedbackStatus;
}

export class FeedbackRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  feedback!: string;
}

export interface FeedbackResponse {
  ok: boolean;
  pending: boolean;
}

export type JobStateKey =
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'paused';

export interface QueueJob {
  id: string;
  name: string;
  state: JobStateKey;
  attempts: number;
  data: Record<string, unknown>;
  failedReason?: string | null;
  stackTrace?: string | null;
  timestamp: string;
  processedOn?: string | null;
  finishedOn?: string | null;
}

export interface PaginatedJobs {
  items: QueueJob[];
  total: number;
  limit: number;
  offset: number;
}

export interface RepositoryDto {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  onboardingStatus: 'pending' | 'indexed' | 'failed' | 'in_progress';
  indexedFiles: number;
  lastSync: string | null;
  autoFix: boolean;
  installationId: number | null;
}

/**
 * Provider ids surfaced by the settings API. Mirrors providerLabel() in
 * orchestration/llm.service.ts — every id here is OpenAI-compatible on the
 * wire except the three with provider-native LangChain clients.
 */
export type LlmProviderId =
  | 'openai'
  | 'ollama'
  | 'gemini'
  | 'deepseek'
  | 'anthropic'
  | 'openrouter'
  | 'nvidia'
  | 'zai'
  | 'minimax'
  | 'xiaomi'
  | 'kimi'
  | 'grok'
  | 'custom';

/** Masked, display-safe view of a saved provider config (never the key). */
export interface ProviderConfigDto {
  id: string;
  label: string;
  baseUrl: string | null;
  model: string;
  apiKeyHint: string | null;
  updatedAt: string;
}

/** Masked, display-safe view of a stored BYOK config (never the key). */
export interface ByokSettingsDto {
  configured: boolean;
  /** Which row is effective: the installation's own, or the global fallback. */
  scope: 'installation' | 'global' | null;
  baseUrl: string | null;
  model: string | null;
  /**
   * Per-agent model name overrides within the same BYOK provider. Keys are
   * agent roles ('planner', 'patch_generator', 'validation', 'onboarding');
   * values are model names. Null when no overrides are configured.
   * @deprecated — use agentAssignments for per-agent provider selection.
   */
  agentModelOverrides: Record<string, string> | null;
  /**
   * Per-agent provider assignments: role → providerConfigId. An agent with
   * an entry here uses that provider config's key + baseUrl + model instead
   * of the shared default. Null when no assignments are configured.
   */
  agentAssignments: Record<string, string> | null;
  /** Last 4 chars of the stored key, for "••••abcd" style display. */
  apiKeyHint: string | null;
  updatedAt: string | null;
}

export interface SettingsDto {
  llm: {
    provider: LlmProviderId;
    model: string;
    fallbackModel: string | null;
    /** 'byok' when a dashboard-submitted config is effective, else 'env'. */
    source: 'byok' | 'env';
  };
  byok: ByokSettingsDto;
  /** Saved provider configs that can be assigned to specific agents. */
  providers: ProviderConfigDto[];
  sandbox: {
    networkMode: 'none' | 'restricted' | 'unrestricted';
    timeout: number;
  };
  notifications: {
    discord: boolean;
    discordWebhookMasked: string | null;
  };
  queue: {
    concurrency: number;
    maxAttempts: number;
  };
  database: {
    type: string;
    hostMasked: string;
  };
}

/** Body for PUT /api/dashboard/settings/llm (BYOK write). */
export class UpdateLlmSettingsRequest {
  /** GitHub App installation to scope the config to; omit/null for global. */
  @IsOptional()
  @IsNumber()
  installationId?: number | null;

  /** Required when creating a config; omit to keep the stored key. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  /** Optional — blank means "use the provider's default endpoint". */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string | null;

  /** Required when creating a config. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  /**
   * Per-agent model name overrides within the same BYOK provider. Pass a
   * partial map to merge (e.g. { planner: "strong-model" }), null to clear
   * all overrides, or omit to leave them unchanged. Only keys matching a
   * known agent role are kept; unknown keys are silently dropped.
   * @deprecated — use agentAssignments for per-agent provider selection.
   */
  @IsOptional()
  @IsObject()
  agentModelOverrides?: Record<string, string> | null;

  /**
   * Per-agent provider assignments (role → providerConfigId). Pass null to
   * clear all assignments, or a partial map to set/merge. Only keys matching
   * a known agent role are kept; providerConfigIds that don't exist in the
   * same scope are silently dropped.
   */
  @IsOptional()
  @IsObject()
  agentAssignments?: Record<string, string> | null;
}

/** Body for POST /api/dashboard/settings/providers (create a provider config). */
export class CreateProviderConfigRequest {
  @IsOptional()
  @IsNumber()
  installationId?: number | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  apiKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  model!: string;
}

/** Body for PUT /api/dashboard/settings/providers/:id (update a provider config). */
export class UpdateProviderConfigRequest {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;
}

export interface GrafanaDashboard {
  uid: string;
  title: string;
  embedUrl: string;
  description?: string;
}

export interface GrafanaConfig {
  enabled: boolean;
  baseUrl: string;
  dashboards: GrafanaDashboard[];
}

export interface RepoIndexStats {
  repoId: string;
  collectionName: string;
  vectorSize: number;
  distance: 'Cosine' | 'Dot' | 'Euclid';
  pointsCount: number;
  indexedCount: number;
  status: 'green' | 'yellow' | 'red';
  diskUsageBytes: number;
  lastIndexedAt: string | null;
}

export interface PipelineEvent {
  taskId: string;
  node: PipelineNode;
  status: 'started' | 'completed' | 'failed';
  payload?: string;
  attempt?: number;
  timestamp: string;
}

export interface AuthSession {
  authenticated: boolean;
  user?: {
    login: string;
    avatarUrl: string;
    name: string | null;
    installations: number[];
  };
}

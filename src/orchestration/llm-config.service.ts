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
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { LlmConfig } from './entities/llm-config.entity';
import { LlmProviderConfig } from './entities/llm-provider-config.entity';
import {
  LlmProviderConfigService,
  ResolvedProviderConfig,
} from './llm-provider-config.service';
import {
  decryptSecret,
  encryptSecret,
  LlmConfigCryptoError,
  resolveMasterKey,
} from './llm-config-crypto';

/** A decrypted, ready-to-use BYOK provider config. */
export interface ResolvedLlmConfig {
  apiKey: string;
  baseUrl: string | null;
  model: string;
  /** @deprecated — replaced by agentAssignments. Kept for backward-compat reads. */
  agentModelOverrides: Record<string, string> | null;
  /**
   * Per-agent provider assignments: role → provider config id. At
   * resolution time, LlmService looks up the provider config by id to
   * get a separate apiKey + baseUrl + model for that agent.
   */
  agentAssignments: Record<string, string> | null;
  /** Which row supplied the config — for logging and settings display. */
  scope: 'installation' | 'global';
}

/** Shape accepted by the settings write API. */
export interface UpsertLlmConfigInput {
  /** GitHub App installation scope; null/undefined → global default row. */
  installationId?: number | null;
  apiKey?: string;
  baseUrl?: string | null;
  model?: string;
  /**
   * Per-agent model overrides. Pass null to clear, {} to keep empty, or a
   * partial map to merge. Only keys matching an AgentRole are kept.
   * @deprecated — use agentAssignments for per-agent provider selection.
   */
  agentModelOverrides?: Record<string, string> | null;
  /**
   * Per-agent provider assignments (role → providerConfigId). Pass null
   * to clear all assignments, or a partial map to set/merge. Only keys
   * matching a known agent role are kept; providerConfigIds that don't
   * exist in the same scope are silently dropped.
   */
  agentAssignments?: Record<string, string> | null;
}

/** Masked, display-safe view of a stored config (never contains the key). */
export interface MaskedLlmConfig {
  configured: boolean;
  scope: 'installation' | 'global' | null;
  baseUrl: string | null;
  model: string | null;
  agentModelOverrides: Record<string, string> | null;
  agentAssignments: Record<string, string> | null;
  apiKeyHint: string | null;
  updatedAt: string | null;
}

const GLOBAL = 'global' as const;
type CacheKey = number | typeof GLOBAL;

/** Valid agent role keys for agentModelOverrides — mirrors AgentRole in llm.service.ts. */
const VALID_AGENT_ROLES = new Set([
  'planner',
  'patch_generator',
  'validation',
  'git',
  'onboarding',
  'analyzer',
  'research',
]);

/**
 * Bring-your-own-key LLM config storage + resolution.
 *
 * The DB is read asynchronously, but LlmService.getModel() must stay
 * synchronous (agents call it mid-tool-loop, and existing specs mock it as a
 * sync call). So resolution works in two steps:
 *
 * 1. `loadForInstallation(id)` (async) — called once at the start of every
 *    pipeline run by OrchestrationService — loads the installation row and
 *    the global fallback row into an in-memory cache of decrypted configs.
 * 2. `getResolvedConfig(id)` (sync) — exact installation row, else global
 *    row, else null → the caller falls back to env defaults.
 *
 * After a settings write/delete the cache is refreshed immediately, and
 * LlmService invalidates its cached model instances for the affected scope.
 */
@Injectable()
export class LlmConfigService {
  private readonly logger = new Logger(LlmConfigService.name);
  /**
   * Decrypted configs keyed by scope. A value of `null` means "loaded and
   * confirmed absent" (so a missing installation row correctly falls through
   * to the global row); an unset key means "never loaded" (env fallback).
   */
  private readonly cache = new Map<CacheKey, ResolvedLlmConfig | null>();
  /**
   * Decrypted provider configs keyed by `<scope>:<providerId>`. Populated
   * alongside the main cache during loadForInstallation(). Used by
   * getResolvedProvider() for per-agent provider assignment resolution.
   */
  private readonly providerCache = new Map<string, ResolvedProviderConfig | null>();

  constructor(
    @InjectRepository(LlmConfig)
    private readonly llmConfigRepo: Repository<LlmConfig>,
    private readonly configService: ConfigService,
    private readonly providerConfigService: LlmProviderConfigService,
  ) {}

  /** Loads the exact + global rows for an installation into memory. */
  async loadForInstallation(installationId?: number | null): Promise<void> {
    const exact: CacheKey | null =
      typeof installationId === 'number' ? installationId : null;
    try {
      if (exact !== null) {
        const row = await this.findRow(exact);
        this.cache.set(exact, row ? this.toResolved(row) : null);
        await this.loadProvidersForScope(exact);
      }
      // The global row is the fallback for every installation (and the only
      // row when unscoped), so always (re)load it alongside.
      const globalRow = await this.findRow(null);
      this.cache.set(GLOBAL, globalRow ? this.toResolved(globalRow) : null);
      await this.loadProvidersForScope(null);
    } catch (e: any) {
      // Non-fatal: keep whatever was primed last (or nothing) and let
      // getModel() fall back to env defaults.
      this.logger.warn(
        `BYOK config load failed (falling back to env/last-known-good): ${e?.message ?? e}`,
      );
    }
  }

  /** Load all provider configs for a scope into the provider cache. */
  private async loadProvidersForScope(scope: number | null): Promise<void> {
    const providers = await this.providerConfigService.listForScope(scope);
    const scopeKey = scope === null ? GLOBAL : scope;
    for (const p of providers) {
      const resolved = this.providerConfigService.toResolved(p);
      this.providerCache.set(`${scopeKey}:${p.id}`, resolved);
    }
  }

  /**
   * Synchronously resolve a provider config by id from the primed cache.
   * Returns null if not found or undecryptable (caller falls back to the
   * shared default provider).
   */
  getResolvedProvider(
    providerId: string,
    installationId?: number | null,
  ): ResolvedProviderConfig | null {
    const scopeKey =
      typeof installationId === 'number' ? installationId : GLOBAL;
    // Try exact scope first, then global fallback.
    return (
      this.providerCache.get(`${scopeKey}:${providerId}`) ??
      this.providerCache.get(`${GLOBAL}:${providerId}`) ??
      null
    );
  }

  /**
   * Synchronous resolution from the primed cache: exact installation row →
   * global row → null. Callers treat null as "use env defaults".
   */
  getResolvedConfig(installationId?: number | null): ResolvedLlmConfig | null {
    if (typeof installationId === 'number') {
      const exact = this.cache.get(installationId);
      if (exact) return exact;
    }
    return this.cache.get(GLOBAL) ?? null;
  }

  /**
   * Creates or updates the BYOK config row for a scope.
   *
   * Create requires apiKey + model (baseUrl optional); update is
   * partial — omit apiKey to keep the stored key, pass baseUrl/model to
   * change them. Returns the masked view of the stored row.
   */
  async upsertConfig(input: UpsertLlmConfigInput): Promise<MaskedLlmConfig> {
    const installationId =
      typeof input.installationId === 'number' ? input.installationId : null;

    const hasApiKey = input.apiKey !== undefined;
    const hasBaseUrl = input.baseUrl !== undefined;
    const hasModel = input.model !== undefined;
    const hasAgentOverrides = input.agentModelOverrides !== undefined;
    const hasAgentAssignments = input.agentAssignments !== undefined;
    if (!hasApiKey && !hasBaseUrl && !hasModel && !hasAgentOverrides && !hasAgentAssignments) {
      throw new BadRequestException(
        'Nothing to update — provide at least one of apiKey, baseUrl, model, agentModelOverrides, agentAssignments',
      );
    }

    const apiKey = input.apiKey?.trim();
    if (hasApiKey && !apiKey) {
      throw new BadRequestException('apiKey must be a non-empty string');
    }
    const model = input.model?.trim();
    if (hasModel && !model) {
      throw new BadRequestException('model must be a non-empty string');
    }
    const baseUrl = hasBaseUrl ? input.baseUrl?.trim() || null : undefined;
    if (baseUrl) {
      try {
        const u = new URL(baseUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          throw new Error('bad protocol');
        }
      } catch {
        throw new BadRequestException(
          `baseUrl must be a valid http(s) URL (got: "${baseUrl}")`,
        );
      }
    }

    const existing = await this.findRow(installationId);
    if (!existing && (!apiKey || !model)) {
      throw new BadRequestException(
        'Creating an LLM config requires both apiKey and model ' +
          '(baseUrl is optional). For a local no-key endpoint (Ollama etc.) ' +
          'use environment variables instead — BYOK rows always carry a key.',
      );
    }

    // Validate + normalize agent model overrides. Only known agent roles
    // are kept; unknown keys are silently dropped. A null value clears the
    // map; an empty object keeps it empty (no overrides).
    let agentOverrides: Record<string, string> | null | undefined;
    if (hasAgentOverrides) {
      const raw = input.agentModelOverrides;
      if (raw === null) {
        agentOverrides = null;
      } else {
        const cleaned: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw ?? {})) {
          if (VALID_AGENT_ROLES.has(k) && typeof v === 'string' && v.trim()) {
            cleaned[k] = v.trim();
          }
        }
        agentOverrides = cleaned;
      }
    }

    // Validate + normalize agent provider assignments. Only known agent
    // roles are kept; providerConfigIds are validated against existing
    // rows in the same scope (unknown ids are silently dropped). A null
    // value clears all assignments.
    let agentAssignments: Record<string, string> | null | undefined;
    if (hasAgentAssignments) {
      const raw = input.agentAssignments;
      if (raw === null) {
        agentAssignments = null;
      } else {
        const existingProviders = await this.providerConfigService.listForScope(installationId);
        const validProviderIds = new Set(existingProviders.map((p) => p.id));
        const cleaned: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw ?? {})) {
          if (VALID_AGENT_ROLES.has(k) && typeof v === 'string' && validProviderIds.has(v)) {
            cleaned[k] = v;
          }
        }
        agentAssignments = cleaned;
      }
    }

    const row = existing ?? this.llmConfigRepo.create({ installationId });
    if (apiKey) {
      // Only apiKey writes need the master key — override/baseUrl/model-only
      // updates don't touch the encrypted column, so they must work even when
      // LLM_CONFIG_ENCRYPTION_KEY isn't configured.
      const masterKey = this.getMasterKeyOrThrow();
      row.apiKeyEncrypted = encryptSecret(apiKey, masterKey);
      row.apiKeyHint = apiKey.slice(-4);
    }
    if (baseUrl !== undefined) row.baseUrl = baseUrl;
    if (model) row.model = model;
    if (agentOverrides !== undefined) row.agentModelOverrides = agentOverrides;
    if (agentAssignments !== undefined) row.agentAssignments = agentAssignments;

    await this.llmConfigRepo.save(row);
    this.logger.log(
      `Saved BYOK LLM config (scope: ${installationId === null ? 'global' : `installation ${installationId}`})`,
    );

    // Refresh the in-memory cache so the next pipeline run (and any
    // already-primed lookups) sees the new config immediately.
    this.cache.clear();
    this.providerCache.clear();
    await this.loadForInstallation(installationId);

    return this.toMasked(row);
  }

  /** Deletes the config row for a scope. Returns whether a row existed. */
  async deleteConfig(installationId?: number | null): Promise<boolean> {
    const scope =
      typeof installationId === 'number' ? installationId : null;
    const existing = await this.findRow(scope);
    if (!existing) return false;
    await this.llmConfigRepo.remove(existing);
    this.cache.delete(scope === null ? GLOBAL : scope);
    // Clear provider cache for this scope — provider configs may also be
    // deleted separately, but clearing here ensures stale assignments don't
    // resolve to orphaned providers.
    for (const key of this.providerCache.keys()) {
      if (key.startsWith(`${scope === null ? GLOBAL : scope}:`)) {
        this.providerCache.delete(key);
      }
    }
    this.logger.log(
      `Deleted BYOK LLM config (scope: ${scope === null ? 'global' : `installation ${scope}`})`,
    );
    return true;
  }

  /**
   * Removes any agent assignment entries that point at a deleted provider
   * config. Called after a provider config is deleted to keep assignments
   * consistent. Saves the affected llm_configs row(s) and refreshes the cache.
   */
  async clearAssignmentsForProvider(
    providerId: string,
    installationId?: number | null,
  ): Promise<void> {
    const scope = typeof installationId === 'number' ? installationId : null;
    // Check both the exact scope row (if installation-scoped) and the global row.
    const rows: LlmConfig[] = [];
    if (scope !== null) {
      const exact = await this.findRow(scope);
      if (exact) rows.push(exact);
    }
    // Always check the global row — it's the fallback for every scope, and
    // when scope is null it's the only row.
    const globalRow = await this.findRow(null);
    if (globalRow) rows.push(globalRow);
    let changed = false;
    for (const row of rows) {
      if (!row.agentAssignments) continue;
      const updated = { ...row.agentAssignments };
      for (const [role, pid] of Object.entries(updated)) {
        if (pid === providerId) delete updated[role];
      }
      if (Object.keys(updated).length !== Object.keys(row.agentAssignments).length) {
        row.agentAssignments = Object.keys(updated).length > 0 ? updated : null;
        await this.llmConfigRepo.save(row);
        changed = true;
      }
    }
    if (changed) {
      this.cache.clear();
      this.providerCache.clear();
      await this.loadForInstallation(scope);
    }
  }

  /**
   * Masked, display-safe info for the settings endpoint: the exact
   * installation row if present, else the global row (it is what would
   * actually serve that installation). Reads the DB directly so the
   * dashboard shows fresh data even before the next pipeline run primes
   * the cache; never decrypts anything.
   */
  async getMaskedInfo(installationId?: number | null): Promise<MaskedLlmConfig> {
    const row =
      (typeof installationId === 'number'
        ? await this.findRow(installationId)
        : null) ?? (await this.findRow(null));
    if (!row) {
      return {
        configured: false,
        scope: null,
        baseUrl: null,
        model: null,
        agentModelOverrides: null,
        agentAssignments: null,
        apiKeyHint: null,
        updatedAt: null,
      };
    }
    return this.toMasked(row);
  }

  /** List masked provider configs for a scope (for the settings UI). */
  async getMaskedProviders(installationId?: number | null): Promise<import('./llm-provider-config.service').MaskedProviderConfig[]> {
    const providers = await this.providerConfigService.listForScope(installationId);
    return providers.map((p) => this.providerConfigService.toMasked(p));
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private async findRow(installationId: number | null): Promise<LlmConfig | null> {
    return this.llmConfigRepo.findOne({
      where: {
        installationId: installationId === null ? IsNull() : installationId,
      },
    });
  }

  private toResolved(row: LlmConfig): ResolvedLlmConfig | null {
    if (!row.apiKeyEncrypted || !row.model) return null;
    try {
      const masterKey = this.getMasterKey();
      return {
        apiKey: decryptSecret(row.apiKeyEncrypted, masterKey),
        baseUrl: row.baseUrl,
        model: row.model,
        agentModelOverrides: row.agentModelOverrides ?? null,
        agentAssignments: row.agentAssignments ?? null,
        scope: row.installationId === null ? 'global' : 'installation',
      };
    } catch (e: any) {
      // Wrong master key or tampered row — treat as absent (env fallback)
      // rather than failing every pipeline run for this installation.
      this.logger.warn(
        `BYOK config for scope ${row.installationId === null ? 'global' : row.installationId} ` +
          `is undecryptable and will be ignored: ${e?.message ?? e}`,
      );
      return null;
    }
  }

  private toMasked(row: LlmConfig): MaskedLlmConfig {
    return {
      configured: true,
      scope: row.installationId === null ? 'global' : 'installation',
      baseUrl: row.baseUrl,
      model: row.model,
      agentModelOverrides: row.agentModelOverrides ?? null,
      agentAssignments: row.agentAssignments ?? null,
      apiKeyHint: row.apiKeyHint,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    };
  }

  private getMasterKey(): Buffer {
    return resolveMasterKey(
      this.configService.get<string>('LLM_CONFIG_ENCRYPTION_KEY'),
    );
  }

  private getMasterKeyOrThrow(): Buffer {
    try {
      return this.getMasterKey();
    } catch (e: any) {
      // Surface crypto setup problems as 400s — the message tells the
      // operator exactly how to generate the key.
      throw new BadRequestException(e?.message ?? String(e));
    }
  }
}

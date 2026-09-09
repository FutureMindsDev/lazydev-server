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
import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { LlmProviderConfig } from './entities/llm-provider-config.entity';
import { encryptSecret, decryptSecret, resolveMasterKey } from './llm-config-crypto';

/** Masked, display-safe view of a saved provider config (never the key). */
export interface MaskedProviderConfig {
  id: string;
  label: string;
  baseUrl: string | null;
  model: string;
  apiKeyHint: string | null;
  updatedAt: string;
}

/** Decrypted, ready-to-use provider config (for LlmService resolution). */
export interface ResolvedProviderConfig {
  id: string;
  apiKey: string;
  baseUrl: string | null;
  model: string;
}

/** Input for creating a new provider config. */
export interface CreateProviderConfigInput {
  installationId?: number | null;
  label: string;
  apiKey: string;
  baseUrl?: string | null;
  model: string;
}

/** Input for updating an existing provider config (all fields optional). */
export interface UpdateProviderConfigInput {
  label?: string;
  apiKey?: string;
  baseUrl?: string | null;
  model?: string;
}

/**
 * CRUD service for saved LLM provider configs (the multi-provider feature).
 *
 * Each row is a distinct provider (key + base URL + model) that can be
 * assigned to specific agents via the llm_configs.agentAssignments column.
 * API keys are encrypted at rest with the same master key as the BYOK
 * config (LLM_CONFIG_ENCRYPTION_KEY).
 *
 * Resolution at pipeline-run time is handled by LlmConfigService, which
 * loads provider configs alongside the llm_configs row and exposes them
 * synchronously via getResolvedConfig().
 */
@Injectable()
export class LlmProviderConfigService {
  private readonly logger = new Logger(LlmProviderConfigService.name);

  constructor(
    @InjectRepository(LlmProviderConfig)
    private readonly repo: Repository<LlmProviderConfig>,
    private readonly configService: ConfigService,
  ) {}

  /** List all provider configs for a scope (exact installation, else global). */
  async listForScope(installationId?: number | null): Promise<LlmProviderConfig[]> {
    const scope = typeof installationId === 'number' ? installationId : null;
    return this.repo.find({
      where: { installationId: scope === null ? IsNull() : scope },
      order: { createdAt: 'ASC' },
    });
  }

  /** Get a single provider config by id (must match the scope). */
  async findById(id: string, installationId?: number | null): Promise<LlmProviderConfig | null> {
    const scope = typeof installationId === 'number' ? installationId : null;
    return this.repo.findOne({
      where: {
        id,
        installationId: scope === null ? IsNull() : scope,
      },
    });
  }

  /** Create a new provider config. */
  async create(input: CreateProviderConfigInput): Promise<MaskedProviderConfig> {
    const label = input.label?.trim();
    if (!label) throw new BadRequestException('label is required');
    const apiKey = input.apiKey?.trim();
    if (!apiKey) throw new BadRequestException('apiKey is required');
    const model = input.model?.trim();
    if (!model) throw new BadRequestException('model is required');

    const baseUrl = input.baseUrl?.trim() || null;
    this.validateBaseUrl(baseUrl);

    const masterKey = this.getMasterKeyOrThrow();
    const installationId =
      typeof input.installationId === 'number' ? input.installationId : null;

    const row = this.repo.create({
      installationId,
      label,
      model,
      baseUrl,
      apiKeyEncrypted: encryptSecret(apiKey, masterKey),
      apiKeyHint: apiKey.slice(-4),
    });
    await this.repo.save(row);
    this.logger.log(
      `Created provider config "${label}" (scope: ${installationId === null ? 'global' : `installation ${installationId}`})`,
    );
    return this.toMasked(row);
  }

  /** Update an existing provider config (partial — omit apiKey to keep stored key). */
  async update(
    id: string,
    input: UpdateProviderConfigInput,
    installationId?: number | null,
  ): Promise<MaskedProviderConfig> {
    const row = await this.findById(id, installationId);
    if (!row) throw new NotFoundException(`Provider config ${id} not found`);

    const hasLabel = input.label !== undefined;
    const hasApiKey = input.apiKey !== undefined;
    const hasBaseUrl = input.baseUrl !== undefined;
    const hasModel = input.model !== undefined;

    if (!hasLabel && !hasApiKey && !hasBaseUrl && !hasModel) {
      throw new BadRequestException('Nothing to update');
    }

    if (hasLabel) {
      const label = input.label!.trim();
      if (!label) throw new BadRequestException('label must be non-empty');
      row.label = label;
    }
    if (hasModel) {
      const model = input.model!.trim();
      if (!model) throw new BadRequestException('model must be non-empty');
      row.model = model;
    }
    if (hasBaseUrl) {
      const baseUrl = input.baseUrl?.trim() || null;
      this.validateBaseUrl(baseUrl);
      row.baseUrl = baseUrl;
    }
    if (hasApiKey) {
      const apiKey = input.apiKey!.trim();
      if (!apiKey) throw new BadRequestException('apiKey must be non-empty');
      const masterKey = this.getMasterKeyOrThrow();
      row.apiKeyEncrypted = encryptSecret(apiKey, masterKey);
      row.apiKeyHint = apiKey.slice(-4);
    }

    await this.repo.save(row);
    this.logger.log(`Updated provider config "${row.label}" (${id})`);
    return this.toMasked(row);
  }

  /** Delete a provider config. Also clears any agent assignments pointing at it. */
  async delete(id: string, installationId?: number | null): Promise<boolean> {
    const row = await this.findById(id, installationId);
    if (!row) return false;
    await this.repo.remove(row);
    this.logger.log(`Deleted provider config "${row.label}" (${id})`);
    return true;
  }

  /** Decrypt a provider config for LlmService to use. Returns null if undecryptable. */
  toResolved(row: LlmProviderConfig): ResolvedProviderConfig | null {
    if (!row.apiKeyEncrypted) return null;
    try {
      const masterKey = this.getMasterKey();
      return {
        id: row.id,
        apiKey: decryptSecret(row.apiKeyEncrypted, masterKey),
        baseUrl: row.baseUrl,
        model: row.model,
      };
    } catch (e: any) {
      this.logger.warn(
        `Provider config ${row.id} (${row.label}) is undecryptable, will be ignored: ${e?.message ?? e}`,
      );
      return null;
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  toMasked(row: LlmProviderConfig): MaskedProviderConfig {
    return {
      id: row.id,
      label: row.label,
      baseUrl: row.baseUrl,
      model: row.model,
      apiKeyHint: row.apiKeyHint,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : new Date().toISOString(),
    };
  }

  private validateBaseUrl(baseUrl: string | null): void {
    if (!baseUrl) return;
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

  private getMasterKey(): Buffer {
    return resolveMasterKey(
      this.configService.get<string>('LLM_CONFIG_ENCRYPTION_KEY'),
    );
  }

  private getMasterKeyOrThrow(): Buffer {
    try {
      return this.getMasterKey();
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? String(e));
    }
  }
}

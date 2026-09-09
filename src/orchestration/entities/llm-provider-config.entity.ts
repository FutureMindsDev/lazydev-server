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
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * A saved LLM provider configuration (API key + base URL + model).
 *
 * Multiple rows can exist per scope (installationId = N for Mode B
 * per-tenant, or NULL for the global/default scope in Mode A). Each row
 * is a distinct provider the user can assign agents to — e.g. one row
 * for OpenRouter (strong models) and another for DeepSeek (cheap
 * onboarding).
 *
 * The API key is stored as an AES-256-GCM envelope (apiKeyEncrypted, see
 * llm-config-crypto.ts) plus a display hint (last 4 chars) so the
 * settings UI can echo a masked version without decrypting.
 *
 * Agent → provider assignment is stored on the llm_configs row's
 * agentAssignments JSON column (role → providerConfigId). Agents
 * without an explicit assignment use the llm_configs row's shared
 * provider config (the "default" provider).
 */
@Entity('llm_provider_configs')
@Index('IDX_llm_provider_configs_installation', ['installationId'])
export class LlmProviderConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'integer', nullable: true })
  installationId: number | null;

  /** User-facing label, e.g. "OpenRouter (strong)" or "DeepSeek (cheap)". */
  @Column({ type: 'varchar', length: 120 })
  label: string;

  @Column({ type: 'varchar', nullable: true })
  baseUrl: string | null;

  @Column({ type: 'varchar' })
  model: string;

  /** "v1:<iv>:<authTag>:<ciphertext>" — see llm-config-crypto.ts. */
  @Column({ type: 'text', nullable: true })
  apiKeyEncrypted: string | null;

  /** Last 4 chars of the key, for masked display only. */
  @Column({ type: 'varchar', nullable: true })
  apiKeyHint: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

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
 * Bring-your-own-key (BYOK) LLM provider config, submitted through the
 * dashboard settings API rather than process env.
 *
 * Scope:
 * - installationId = N  → applies to every pipeline run for that GitHub App
 *   installation (Mode B per-tenant BYOK).
 * - installationId NULL → the global default row, applied to any installation
 *   without its own row (how a Mode A operator sets "the" provider via UI).
 *
 * Resolution precedence in LlmService.getModel(): installation row → global
 * row → env defaults. A resolved BYOK config fully replaces the env defaults
 * for that scope — including per-agent env overrides — because a
 * UI-submitted key is a more specific, more recent intent than static env.
 *
 * The API key is stored only as an AES-256-GCM envelope (apiKeyEncrypted,
 * see llm-config-crypto.ts) plus a display hint (last 4 chars) so the
 * settings UI can echo a masked version without decrypting anything.
 */
@Entity('llm_configs')
@Index('UQ_llm_configs_installation', ['installationId'], { unique: true })
export class LlmConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'integer', nullable: true })
  installationId: number | null;

  @Column({ type: 'varchar', nullable: true })
  baseUrl: string | null;

  @Column({ type: 'varchar', nullable: true })
  model: string | null;

  /**
   * Per-agent model name overrides within the same BYOK provider. Keys are
   * AgentRole values ('planner', 'patch_generator', 'validation', 'git',
   * 'onboarding'); values are model names served by the same provider
   * (same apiKey + baseUrl). Null/absent means "use the shared `model`".
   *
   * Stored as JSON so the schema stays stable as agent roles change. Only
   * model names are overridden here — per-agent *provider* overrides (a
   * different key + base URL per agent) remain an env-only feature since
   * they require separate encrypted keys.
   *
   * @deprecated Replaced by `agentAssignments` (role → providerConfigId).
   * Kept for backward-compat reads; new writes use agentAssignments.
   */
  @Column({ type: 'jsonb', nullable: true })
  agentModelOverrides: Record<string, string> | null;

  /**
   * Per-agent provider assignments. Keys are AgentRole values; values are
   * the UUID of an llm_provider_configs row in the same scope. An agent
   * with an entry here uses that provider config's key + baseUrl + model
   * instead of the shared default on this row. Null/absent means "use the
   * shared provider" (this row's apiKey + baseUrl + model).
   */
  @Column({ type: 'jsonb', nullable: true })
  agentAssignments: Record<string, string> | null;

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

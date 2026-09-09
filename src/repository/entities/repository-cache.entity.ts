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

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('repository_cache')
@Index(['owner', 'repo'], { unique: true })
export class RepositoryCache {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  owner: string;

  @Column({ length: 255 })
  repo: string;

  @Column({ name: 'full_name', length: 511 })
  fullName: string;

  @Column({ name: 'local_path', length: 1024 })
  localPath: string;

  @Column({ name: 'default_branch', length: 255, default: 'main' })
  defaultBranch: string;

  @Column({ name: 'last_fetched_at', type: 'timestamptz', nullable: true })
  lastFetchedAt: Date | null;

  // ── Dashboard control-plane additions (BACKEND_API_SPEC §10) ──
  // onboardingStatus tracks the RAG indexing lifecycle so the Repositories
  // page can show pending / in_progress / indexed / failed badges.
  @Column({
    name: 'onboarding_status',
    length: 32,
    default: 'pending',
  })
  onboardingStatus: 'pending' | 'indexed' | 'failed' | 'in_progress';

  // Number of file chunks currently indexed in Qdrant for this repo. Updated
  // by the RAG ingestion pipeline. 0 means not yet indexed.
  @Column({ name: 'indexed_files', default: 0 })
  indexedFiles: number;

  // Whether the GitHub App auto-creates fix PRs for new issues in this repo.
  // Defaults to true (matches the webhook-driven flow).
  @Column({ name: 'auto_fix', default: true })
  autoFix: boolean;

  // GitHub App installation id this repo belongs to (Mode B tenancy). Null in
  // Mode A self-hosted deployments. Explicit `type: 'integer'` because
  // TypeORM cannot infer a column type from the `number | null` union and
  // falls back to `Object`, which Postgres rejects.
  @Column({ name: 'installation_id', type: 'integer', nullable: true })
  installationId: number | null;

  @CreateDateColumn({ name: 'cloned_at', type: 'timestamptz' })
  clonedAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

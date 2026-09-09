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
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  taskId: string;

  @Column()
  issueNumber: number;

  @Column()
  issueTitle: string;

  @Column()
  status: 'SUCCESS' | 'FAILED';

  @Column()
  validationAttempts: number;

  @Column({ type: 'text', nullable: true })
  finalValidationFeedback: string;

  @Column({ type: 'text', nullable: true })
  generatedPatch: string;

  // ── Dashboard control-plane additions (BACKEND_API_SPEC §"Entity changes") ──
  // installationId is the Mode B tenancy wall (null in Mode A). Every dashboard
  // query filters by it when provided. The remaining fields are populated from
  // AgentState at pipeline completion so Run Detail can render without
  // rehydrating the LangGraph checkpoint.
  @Column({ type: 'integer', nullable: true })
  installationId: number | null;

  @Column({ type: 'varchar', nullable: true })
  repo: string | null;

  @Column({ type: 'varchar', nullable: true })
  branch: string | null;

  @Column({ type: 'varchar', nullable: true })
  prUrl: string | null;

  @Column({ type: 'text', nullable: true })
  unappliedChanges: string | null;

  @Column({ type: 'text', nullable: true })
  triageContext: string | null;

  @Column({ type: 'text', nullable: true })
  researchContext: string | null;

  @Column({ type: 'text', nullable: true })
  implementationPlan: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

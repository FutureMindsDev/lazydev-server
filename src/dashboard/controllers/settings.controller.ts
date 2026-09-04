/* eslint-disable */
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Query,
  Param,
  Body,
} from '@nestjs/common';
import { DashboardService } from '../dashboard.service';
import type {
  SettingsDto,
  GrafanaConfig,
  ByokSettingsDto,
  UpdateLlmSettingsRequest,
  ProviderConfigDto,
  CreateProviderConfigRequest,
  UpdateProviderConfigRequest,
} from '../dashboard.dto';

@Controller('api/dashboard')
export class SettingsController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * Masked settings view. Pass ?installationId= in Mode B to scope the
   * reported LLM config to that installation (its BYOK row, else the global
   * fallback row, else env defaults).
   */
  @Get('settings')
  async getSettings(
    @Query('installationId') installationId?: number,
  ): Promise<SettingsDto> {
    return this.dashboardService.getSettings(installationId);
  }

  @Get('grafana')
  async getGrafanaConfig(): Promise<GrafanaConfig> {
    return this.dashboardService.getGrafanaConfig();
  }

  /**
   * Upsert the BYOK LLM config (bring-your-own-key).
   *
   * Body: { installationId?, apiKey?, baseUrl?, model?, agentAssignments? }
   * - installationId omitted/null → the global default row (applies to every
   *   installation without its own row — how a self-hosted operator sets
   *   "the" provider from the UI).
   * - Creating a config requires apiKey + model; updates are partial (omit
   *   apiKey to keep the stored key).
   * - agentAssignments maps agent roles to provider config ids (for the
   *   multi-provider feature); omit to leave unchanged, null to clear.
   * - Requires LLM_CONFIG_ENCRYPTION_KEY to be configured when apiKey is
   *   included (keys are encrypted at rest); returns 400 with setup
   *   instructions otherwise.
   */
  @Put('settings/llm')
  async updateLlmSettings(
    @Body() body: UpdateLlmSettingsRequest,
  ): Promise<ByokSettingsDto> {
    return this.dashboardService.updateLlmConfig(body ?? {});
  }

  /** Delete the BYOK LLM config row for a scope. Idempotent. */
  @Delete('settings/llm')
  async deleteLlmSettings(
    @Query('installationId') installationId?: number,
  ): Promise<{ ok: boolean }> {
    return this.dashboardService.deleteLlmConfig(installationId);
  }

  // ── Multi-provider config CRUD ──────────────────────────────────────────

  /** List all saved provider configs for a scope. */
  @Get('settings/providers')
  async listProviders(
    @Query('installationId') installationId?: number,
  ): Promise<ProviderConfigDto[]> {
    return this.dashboardService.listProviders(installationId);
  }

  /** Create a new provider config. */
  @Post('settings/providers')
  async createProvider(
    @Body() body: CreateProviderConfigRequest,
  ): Promise<ProviderConfigDto> {
    return this.dashboardService.createProvider(body ?? ({} as CreateProviderConfigRequest));
  }

  /** Update an existing provider config (partial — omit apiKey to keep stored). */
  @Put('settings/providers/:id')
  async updateProvider(
    @Param('id') id: string,
    @Body() body: UpdateProviderConfigRequest,
    @Query('installationId') installationId?: number,
  ): Promise<ProviderConfigDto> {
    return this.dashboardService.updateProvider(id, body ?? {}, installationId);
  }

  /** Delete a provider config. Also clears any agent assignments pointing at it. */
  @Delete('settings/providers/:id')
  async deleteProvider(
    @Param('id') id: string,
    @Query('installationId') installationId?: number,
  ): Promise<{ ok: boolean }> {
    return this.dashboardService.deleteProvider(id, installationId);
  }
}

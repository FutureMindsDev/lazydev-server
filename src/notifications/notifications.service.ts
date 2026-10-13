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
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { maskSecrets } from '../common/prompt-guard';

export interface NotificationPayload {
  title: string;
  description: string;
  color?: number; // Discord embed color (decimal)
  fields?: { name: string; value: string; inline?: boolean }[];
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  async sendDiscordNotification(payload: NotificationPayload): Promise<void> {
    const webhookUrl = this.configService.get<string>('DISCORD_WEBHOOK_URL');

    if (!webhookUrl) {
      this.logger.warn(
        'DISCORD_WEBHOOK_URL not configured, skipping notification.',
      );
      return;
    }

    // Fail closed on a misconfigured URL: secrets must only ever go to
    // Discord's real webhook endpoint, never an attacker's lookalike.
    if (!webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      this.logger.error(
        'DISCORD_WEBHOOK_URL does not start with https://discord.com/api/webhooks/ — refusing to send.',
      );
      return;
    }

    // Sink-side masking: scrub secret-looking values from everything we
    // forward, so a leaked token in a log line or payload can never reach
    // Discord even if a caller forgot to clean first.
    const safe = {
      title: maskSecrets(payload.title),
      description: maskSecrets(payload.description),
      fields: (payload.fields || []).map((f) => ({
        ...f,
        value: maskSecrets(f.value),
      })),
    };

    try {
      await firstValueFrom(
        this.httpService.post(webhookUrl, {
          embeds: [
            {
              title: safe.title,
              description: safe.description,
              color: payload.color || 3447003, // Default blue
              fields: safe.fields,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      );
      this.logger.log(
        `Successfully sent Discord notification: ${safe.title}`,
      );
    } catch (e: any) {
      this.logger.error(`Failed to send Discord notification: ${e.message}`);
    }
  }

  // Future-proofing for Slack if needed, but Discord is requested for now.
}

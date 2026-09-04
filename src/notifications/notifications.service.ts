/* eslint-disable */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

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

    try {
      await firstValueFrom(
        this.httpService.post(webhookUrl, {
          embeds: [
            {
              title: payload.title,
              description: payload.description,
              color: payload.color || 3447003, // Default blue
              fields: payload.fields || [],
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      );
      this.logger.log(
        `Successfully sent Discord notification: ${payload.title}`,
      );
    } catch (e: any) {
      this.logger.error(`Failed to send Discord notification: ${e.message}`);
    }
  }

  // Future-proofing for Slack if needed, but Discord is requested for now.
}

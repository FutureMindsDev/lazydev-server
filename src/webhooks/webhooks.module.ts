import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { IngestionModule } from '../ingestion/ingestion.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [IngestionModule, NotificationsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}

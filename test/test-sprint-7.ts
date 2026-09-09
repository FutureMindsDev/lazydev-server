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

import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { IngestionService } from '../src/ingestion/ingestion.service';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';

class MockIngestionService {
  async queueIssueEvent(payload: any) {
    console.log(`[MockIngestionService] Queued issue event (action: ${payload.action})`);
  }
}

async function runTest() {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ envFilePath: '.env' }),
      HttpModule,
    ],
    providers: [
      WebhooksService,
      { provide: IngestionService, useClass: MockIngestionService },
      NotificationsService,
    ],
  }).compile();

  const webhooksService = moduleFixture.get<WebhooksService>(WebhooksService);

  console.log('--- Simulating CI Failure Webhook ---');
  // Simulate an incoming webhook payload for a failed check_run on a fix branch
  await webhooksService.webhooks.receive({
    id: '123',
    name: 'check_run',
    payload: {
      action: 'completed',
      check_run: {
        conclusion: 'failure',
        html_url: 'https://github.com/test/logs',
        check_suite: {
          head_branch: 'lazydev/fix-42-test',
        },
      },
      repository: { full_name: 'test/repo' },
      installation: { id: 1 },
    } as any,
  });

  console.log('--- Test Complete ---');
}

runTest().catch(console.error);

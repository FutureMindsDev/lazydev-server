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

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import {
  Controller,
  Post,
  Headers,
  Res,
  HttpStatus,
  Logger,
  Request as ReqDecorator,
} from '@nestjs/common';
import type { Response } from 'express';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('github')
  async handleGithubWebhook(
    @Headers('x-github-event') eventName: string,
    @Headers('x-hub-signature-256') signature: string,
    @Headers('x-github-delivery') id: string,
    @ReqDecorator() req: any,
    @Res() res: Response,
  ) {
    if (!signature) {
      this.logger.error('No signature found in the request');
      return res.status(HttpStatus.UNAUTHORIZED).send('Signature missing');
    }

    try {
      const payload = req.rawBody
        ? req.rawBody.toString('utf8')
        : JSON.stringify(req.body);

      await this.webhooksService.webhooks.verifyAndReceive({
        id,
        name: eventName,
        payload,
        signature,
      });

      return res.status(HttpStatus.OK).send('OK');
    } catch (error: any) {
      this.logger.error(`Webhook verification failed: ${error.message}`);
      return res.status(HttpStatus.BAD_REQUEST).send('Webhook error');
    }
  }
}

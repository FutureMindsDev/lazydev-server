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
  Controller,
  Get,
  Post,
  Req,
  Res,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { AuthSession } from '../dashboard/dashboard.dto';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('session')
  async getSession(@Req() req: Request): Promise<AuthSession> {
    const raw = (req.cookies as Record<string, string> | undefined)?.[
      this.authService.cookieNameStr
    ];
    return this.authService.getSession(raw);
  }

  @Post('logout')
  async logout(@Res({ passthrough: true }) res: Response): Promise<{
    ok: boolean;
  }> {
    res.clearCookie(this.authService.cookieNameStr, this.authService.cookieOptions);
    return { ok: true };
  }

  @Get('github')
  async githubAuth(
    @Res() res: Response,
    @Query('next') next?: string,
  ): Promise<void> {
    if (!this.authService.isGithubOAuthEnabled()) {
      // OAuth not configured — redirect to frontend, which will show login.
      res.redirect(this.authService.frontendUrl);
      return;
    }
    // CSRF state: random token echoed back by GitHub. We pass it via cookie
    // so the callback can verify it without a server-side store.
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('ld_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 min
    });
    const authorizeUrl = this.authService.getAuthorizeUrl(state);
    res.redirect(authorizeUrl);
  }

  @Get('github/callback')
  async githubCallback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ): Promise<void> {
    if (!code) {
      res.redirect(`${this.authService.frontendUrl}/login?error=no_code`);
      return;
    }
    // Verify state cookie to prevent CSRF.
    const cookies = req.cookies as Record<string, string> | undefined;
    const expectedState = cookies?.['ld_oauth_state'];
    if (!state || !expectedState || state !== expectedState) {
      res.redirect(`${this.authService.frontendUrl}/login?error=state_mismatch`);
      return;
    }
    res.clearCookie('ld_oauth_state');

    const result = await this.authService.handleCallback(code);
    if (!result) {
      res.redirect(`${this.authService.frontendUrl}/login?error=oauth_failed`);
      return;
    }
    res.cookie(
      this.authService.cookieNameStr,
      result.cookieValue,
      this.authService.cookieOptions,
    );
    res.redirect(this.authService.frontendUrl);
  }
}

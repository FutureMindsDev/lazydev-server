/* eslint-disable */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';
import type { AuthSession } from '../dashboard/dashboard.dto';

/**
 * Mode B GitHub OAuth session management.
 *
 * In Mode A (selfhosted + auth none) every method short-circuits to
 * "unauthenticated" — the dashboard sidebar hides the user UI and the login
 * page auto-redirects to /.
 *
 * In Mode B (hosted + github-oauth) the flow is:
 *   1. GET /api/auth/github        → redirect to GitHub authorize URL
 *   2. GitHub redirects back to /api/auth/github/callback?code=...
 *   3. We exchange the code for an access token via the GitHub API
 *   4. We fetch the user's profile + installations
 *   5. We set an HMAC-signed cookie `ld_session` containing the user JSON
 *   6. /api/auth/session reads + verifies that cookie
 *
 * The cookie is signed with SESSION_SECRET (HMAC-SHA256). This is a
 * stateless session — no server-side store — so logout just clears the
 * cookie. Token expiry / refresh is out of scope for this scaffold.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly sessionSecret: string;
  private readonly cookieName = 'ld_session';
  private readonly cookieMaxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {
    // `||` so an empty SESSION_SECRET (from `SESSION_SECRET=` in .env) falls
    // back to the dev default rather than signing cookies with an empty key.
    this.sessionSecret =
      this.configService.get<string>('SESSION_SECRET') ||
      'insecure-dev-secret';
  }

  isGithubOAuthEnabled(): boolean {
    return (
      this.configService.get<string>('DASHBOARD_AUTH') === 'github-oauth' &&
      !!this.configService.get<string>('GITHUB_OAUTH_CLIENT_ID')
    );
  }

  getAuthorizeUrl(state: string): string {
    const clientId = this.configService.get<string>('GITHUB_OAUTH_CLIENT_ID');
    const callbackUrl = this.configService.get<string>(
      'GITHUB_OAUTH_CALLBACK_URL',
    );
    const params = new URLSearchParams({
      client_id: clientId ?? '',
      redirect_uri: callbackUrl ?? '',
      scope: 'repo read:org',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  async handleCallback(code: string): Promise<{
    user: AuthSession['user'];
    cookieValue: string;
  } | null> {
    const clientId = this.configService.get<string>('GITHUB_OAUTH_CLIENT_ID');
    const clientSecret = this.configService.get<string>(
      'GITHUB_OAUTH_CLIENT_SECRET',
    );
    if (!clientId || !clientSecret) return null;

    try {
      // Exchange code for access token.
      const tokenRes = await firstValueFrom(
        this.httpService.post(
          'https://github.com/login/oauth/access_token',
          {
            client_id: clientId,
            client_secret: clientSecret,
            code,
          },
          { headers: { Accept: 'application/json' } },
        ),
      );
      const accessToken: string | undefined = tokenRes.data?.access_token;
      if (!accessToken) return null;

      // Fetch the user profile.
      const userRes = await firstValueFrom(
        this.httpService.get('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
        }),
      );
      const u = userRes.data;
      const login: string = u.login;
      const avatarUrl: string = u.avatar_url;
      const name: string | null = u.name ?? null;

      // Fetch installations the user has access to.
      let installations: number[] = [];
      try {
        const instRes = await firstValueFrom(
          this.httpService.get('https://api.github.com/user/installations', {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
          }),
        );
        installations = (instRes.data?.installations ?? []).map(
          (i: any) => i.id as number,
        );
      } catch (e: any) {
        this.logger.warn(`Could not fetch installations: ${e.message}`);
      }

      const user = { login, avatarUrl, name, installations };
      const cookieValue = this.signSession(user);
      return { user, cookieValue };
    } catch (e: any) {
      this.logger.error(`GitHub OAuth callback failed: ${e.message}`);
      return null;
    }
  }

  /** Reads + verifies the session cookie. Returns null if absent/invalid. */
  readSession(rawCookie: string | undefined): AuthSession['user'] | null {
    if (!rawCookie) return null;
    const [payloadB64, sig] = rawCookie.split('.');
    if (!payloadB64 || !sig) return null;
    const expected = this.hmac(payloadB64);
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
    try {
      const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  getSession(rawCookie: string | undefined): AuthSession {
    const user = this.readSession(rawCookie);
    return user ? { authenticated: true, user } : { authenticated: false };
  }

  get cookieOptions() {
    return {
      httpOnly: true,
      secure: this.configService.get<string>('NODE_ENV') === 'production',
      sameSite: 'lax' as const,
      maxAge: this.cookieMaxAgeMs,
    };
  }

  get cookieNameStr(): string {
    return this.cookieName;
  }

  get frontendUrl(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') ||
      'http://localhost:3000'
    );
  }

  private signSession(user: AuthSession['user']): string {
    const json = JSON.stringify(user);
    const payloadB64 = Buffer.from(json, 'utf8').toString('base64url');
    const sig = this.hmac(payloadB64);
    return `${payloadB64}.${sig}`;
  }

  private hmac(data: string): string {
    return crypto
      .createHmac('sha256', this.sessionSecret)
      .update(data)
      .digest('hex');
  }
}

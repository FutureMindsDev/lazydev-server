import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const config = app.get(ConfigService);

  // Security Hardening (Sprint 8)
  // helmet's defaults include Cross-Origin-Resource-Policy: same-origin,
  // which blocks the browser from reading API responses even when CORS
  // headers are correct (CORP is a separate enforcement layer from CORS).
  // The dashboard frontend runs on a different origin than this API, so
  // relax CORP to cross-origin. CORS itself is still locked down below.
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
    }),
  );
  // Cookie parsing for Mode B GitHub OAuth session cookies.
  app.use(cookieParser());

  // CORS — locked to the dashboard frontend origin(s). The dashboard UI
  // (lazydev-frontend) runs on a different port/host than this API, and in
  // Mode B it sends credentials (session cookies), so credentials must be
  // enabled. Origins come from CORS_ORIGINS (comma-separated); defaults to
  // the local Next.js dev server.
  // Treat an empty CORS_ORIGINS the same as unset so the default kicks in
  // (dotenv parses `CORS_ORIGINS=` as an empty string, which ConfigService
  // returns verbatim — `||` falls back where the second arg would not).
  const rawOrigins =
    config.get<string>('CORS_ORIGINS') || 'http://localhost:3000';
  const origins = rawOrigins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins,
    credentials: true,
  });

  // Default 3200 rather than 3000: port 3000 is commonly taken by other local
  // agent tooling (e.g. the Hermes WhatsApp bridge). Override with PORT.
  await app.listen(process.env.PORT ?? 3200);
}
bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});

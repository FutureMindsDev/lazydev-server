/* eslint-disable */
import { Controller, Get, Query, Sse, MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import Redis from 'ioredis';
import type { PipelineEvent } from '../dashboard.dto';

/**
 * SSE live pipeline events (BACKEND_API_SPEC §15).
 *
 * Emits one Server-Sent Event per LangGraph node transition. Agents publish
 * events to the Redis channel `pipeline:events:{taskId}`; this endpoint
 * subscribes to that channel for the requested taskId and forwards each
 * message as an SSE `data:` line.
 *
 * The frontend's `usePipelineEvents` hook uses native `EventSource`, which
 * expects standard SSE format — NestJS's `@Sse` decorator handles that
 * framing; we only need to emit `MessageEvent` objects.
 *
 * Until the agents are wired to publish events, this endpoint stays open and
 * silent (the frontend has a "Simulate" fallback). A heartbeat comment line
 * is sent every 15s to keep proxies from closing the idle connection.
 */
@Controller('api/dashboard')
export class EventsController {
  private readonly redisHost: string;
  private readonly redisPort: number;

  constructor(private readonly configService: ConfigService) {
    this.redisHost = this.configService.get<string>('REDIS_HOST', 'localhost');
    this.redisPort = this.configService.get<number>('REDIS_PORT', 6379);
  }

  @Sse('events')
  getEvents(@Query('taskId') taskId: string): Observable<MessageEvent> {
    const channel = `pipeline:events:${taskId}`;

    return new Observable<MessageEvent>((subscriber) => {
      // Dedicated subscriber connection — BullMQ's connection is busy with
      // queue commands and ioredis doesn't allow SUBSCRIBE on a connection
      // that's also issuing other commands.
      const sub = new Redis({
        host: this.redisHost,
        port: this.redisPort,
        maxRetriesPerRequest: null,
      });

      let closed = false;

      sub.subscribe(channel).catch((err) => {
        subscriber.error(err);
      });

      sub.on('message', (_channel, message) => {
        try {
          const event: PipelineEvent = JSON.parse(message);
          subscriber.next({
            type: event.node,
            data: event,
          } as MessageEvent);
        } catch {
          // Ignore malformed payloads — never break the stream.
        }
      });

      // Heartbeat: SSE comment lines (starting with ':') are ignored by
      // EventSource but keep intermediary proxies from timing out.
      const heartbeat = setInterval(() => {
        if (!closed) subscriber.next({ data: ': heartbeat' } as MessageEvent);
      }, 15_000);

      // Cleanup on unsubscribe (client disconnect).
      return () => {
        closed = true;
        clearInterval(heartbeat);
        sub.unsubscribe(channel).catch(() => undefined);
        sub.quit().catch(() => undefined);
      };
    });
  }
}

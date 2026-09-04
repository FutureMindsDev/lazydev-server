import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { McpServerService } from './mcp-server.service';
import { McpTaskService } from './mcp-task.service';
import { McpController } from './mcp.controller';
import { GithubService } from '../github/github.service';
import { MCP_ENDPOINT } from './mcp.constants';

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
};

/** Reserves a free ephemeral port so the standalone-mode test cannot collide. */
const getFreePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe('McpServerService', () => {
  let service: McpServerService;
  let app: INestApplication;
  let nestApp: unknown;
  let config: Record<string, string | undefined>;

  const build = async (
    overrides: Record<string, string | undefined> = {},
  ): Promise<McpServerService> => {
    config = { ...overrides };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        McpServerService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
        { provide: McpTaskService, useValue: {} },
        { provide: GithubService, useValue: {} },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    nestApp = app.getHttpServer();

    return module.get(McpServerService);
  };

  afterEach(async () => {
    await app?.close();
    await service?.onModuleDestroy();
    jest.restoreAllMocks();
  });

  describe('Option A — mounted on the main Nest server', () => {
    beforeEach(async () => {
      service = await build();
    });

    it('answers the MCP initialize handshake on /mcp', async () => {
      const response = await request(nestApp)
        .post(MCP_ENDPOINT)
        .set('Accept', 'application/json, text/event-stream')
        .send(INITIALIZE_BODY);

      expect(response.status).toBe(200);
      expect(response.text).toContain('lazydev-agent');
    });

    it('advertises the four LazyDev tools via tools/list', async () => {
      // Streamable HTTP requires the initialize handshake first.
      await request(nestApp)
        .post(MCP_ENDPOINT)
        .set('Accept', 'application/json, text/event-stream')
        .send(INITIALIZE_BODY);

      const response = await request(nestApp)
        .post(MCP_ENDPOINT)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

      expect(response.status).toBe(200);
      for (const tool of [
        'trigger_issue_fix',
        'implement_new_feature',
        'get_pipeline_status',
        'provide_human_feedback',
      ]) {
        expect(response.text).toContain(tool);
      }
    });

    // Regression guard: in stateless mode the SDK skips session validation, so
    // handing a GET to the transport opens an SSE stream that never emits and
    // never closes — leaking a socket and a server/transport per request.
    it.each(['get', 'delete'] as const)(
      'rejects %s with 405 instead of hanging on an SSE stream',
      async (method) => {
        const response = await request(nestApp)
          [method](MCP_ENDPOINT)
          .set('Accept', 'application/json, text/event-stream')
          .timeout({ response: 2000, deadline: 3000 });

        expect(response.status).toBe(405);
        expect(response.headers['allow']).toBe('POST');
        expect(response.headers['content-type']).toMatch(/application\/json/);
      },
    );
  });

  describe('Option B — standalone isolated server', () => {
    let port: number;

    beforeEach(async () => {
      port = await getFreePort();
      service = await build({ MCP_SERVER_PORT: String(port) });
    });

    it('serves MCP on its own port', async () => {
      const response = await request(`http://127.0.0.1:${port}`)
        .post(MCP_ENDPOINT)
        .set('Accept', 'application/json, text/event-stream')
        .send(INITIALIZE_BODY);

      expect(response.status).toBe(200);
      expect(response.text).toContain('lazydev-agent');
    });

    it('does not expose MCP on the main API port', async () => {
      const response = await request(nestApp)
        .post(MCP_ENDPOINT)
        .set('Accept', 'application/json, text/event-stream')
        .send(INITIALIZE_BODY);

      expect(response.status).toBe(404);
    });
  });

  describe('bearer auth', () => {
    it('is skipped entirely when MCP_AUTH_TOKEN is unset', async () => {
      service = await build();

      const response = await request(nestApp)
        .post(MCP_ENDPOINT)
        .set('Accept', 'application/json, text/event-stream')
        .send(INITIALIZE_BODY);

      expect(response.status).toBe(200);
    });

    describe('when MCP_AUTH_TOKEN is set', () => {
      beforeEach(async () => {
        service = await build({ MCP_AUTH_TOKEN: 's3cret' });
      });

      it('accepts the correct bearer token', async () => {
        const response = await request(nestApp)
          .post(MCP_ENDPOINT)
          .set('Accept', 'application/json, text/event-stream')
          .set('Authorization', 'Bearer s3cret')
          .send(INITIALIZE_BODY);

        expect(response.status).toBe(200);
      });

      it.each([
        ['a missing header', undefined],
        ['a wrong token', 'Bearer nope'],
        ['a malformed scheme', 's3cret'],
      ])('rejects %s with 401', async (_label, header) => {
        const req = request(nestApp)
          .post(MCP_ENDPOINT)
          .set('Accept', 'application/json, text/event-stream');
        if (header) req.set('Authorization', header);

        const response = await req.send(INITIALIZE_BODY);

        expect(response.status).toBe(401);
        const body = response.body as { error: { message: string } };
        expect(body.error.message).toBe('Unauthorized');
      });
    });
  });

  describe('MCP_SERVER_ENABLED=false', () => {
    it('does not serve MCP at all', async () => {
      service = await build({ MCP_SERVER_ENABLED: 'false' });

      const response = await request(nestApp)
        .post(MCP_ENDPOINT)
        .set('Accept', 'application/json, text/event-stream')
        .send(INITIALIZE_BODY);
      expect(response.status).toBe(404);
    });
  });
});

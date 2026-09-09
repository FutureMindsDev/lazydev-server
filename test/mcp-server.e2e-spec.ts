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
import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { McpServerService } from '../src/mcp-server/mcp-server.service';
import { McpTaskService } from '../src/mcp-server/mcp-task.service';
import { McpController } from '../src/mcp-server/mcp.controller';
import { GithubService } from '../src/github/github.service';
import { MCP_ENDPOINT } from '../src/mcp-server/mcp.constants';

/**
 * End-to-end coverage of the LazyDev MCP server over real HTTP, driven by the
 * official MCP client — the same handshake Hermes and OpenClaw perform.
 *
 * The pipeline dependencies (BullMQ, GitHub) are stubbed so the test needs no
 * Redis, Postgres or network access.
 */
describe('LazyDev MCP Server (e2e)', () => {
  let app: INestApplication;
  let client: Client;
  let baseUrl: string;

  const enqueueTask = jest.fn().mockResolvedValue('mcp-e2e-task');
  const getTaskStatus = jest.fn().mockResolvedValue({
    taskId: 'mcp-e2e-task',
    state: 'waiting',
    repository: 'acme/widgets',
    issueNumber: 42,
  });
  const storeFeedback = jest.fn().mockResolvedValue(undefined);

  const config: Record<string, string | undefined> = {};

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as CallToolResult;
    return result.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        McpServerService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
        {
          provide: McpTaskService,
          useValue: {
            enqueueTask,
            getTaskStatus,
            storeFeedback,
            requeueWithFeedback: jest.fn().mockResolvedValue('mcp-requeued'),
            findInFlightTask: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: GithubService,
          useValue: {
            getRepoInstallationId: jest.fn().mockResolvedValue(4242),
            getInstallationOctokit: jest.fn().mockResolvedValue({
              rest: {
                issues: {
                  get: jest.fn().mockResolvedValue({
                    data: {
                      title: 'Broken login',
                      body: 'Nothing happens',
                      labels: [],
                    },
                  }),
                  create: jest.fn().mockResolvedValue({
                    data: {
                      number: 77,
                      html_url: 'https://github.com/acme/widgets/issues/77',
                    },
                  }),
                },
              },
            }),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);

    const server = app.getHttpServer() as Server;
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}${MCP_ENDPOINT}`;

    client = new Client({ name: 'e2e-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
  });

  it('completes the MCP handshake and reports the server identity', () => {
    expect(client.getServerVersion()).toEqual(
      expect.objectContaining({ name: 'lazydev-agent' }),
    );
  });

  it('advertises the four LazyDev tools with usable schemas', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_pipeline_status',
      'implement_new_feature',
      'provide_human_feedback',
      'trigger_issue_fix',
    ]);

    const trigger = tools.find((t) => t.name === 'trigger_issue_fix');
    expect(Object.keys(trigger?.inputSchema.properties ?? {}).sort()).toEqual([
      'issue_number',
      'priority',
      'repository',
    ]);
  });

  it('queues an issue fix and returns a task id', async () => {
    const text = await callTool('trigger_issue_fix', {
      repository: 'acme/widgets',
      issue_number: 42,
    });

    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'acme/widgets',
        issueNumber: 42,
        installationId: 4242,
        kind: 'fix',
      }),
      expect.anything(),
    );
    expect(text).toContain('mcp-e2e-task');
  });

  it('creates a tracking issue for a new feature request', async () => {
    const text = await callTool('implement_new_feature', {
      repository: 'acme/widgets',
      feature_description: 'Add a /health endpoint that returns uptime as JSON',
    });

    expect(text).toContain('https://github.com/acme/widgets/issues/77');
    expect(text).toContain('mcp-e2e-task');
  });

  it('reports pipeline status for a task id', async () => {
    const text = await callTool('get_pipeline_status', {
      task_id: 'mcp-e2e-task',
    });

    expect(getTaskStatus).toHaveBeenCalledWith('mcp-e2e-task');
    expect(text).toContain('waiting');
    expect(text).toContain('acme/widgets#42');
  });

  it('accepts human feedback for a running task', async () => {
    const text = await callTool('provide_human_feedback', {
      task_id: 'mcp-e2e-task',
      feedback: 'Prefer an existing helper over a new utility file',
    });

    expect(storeFeedback).toHaveBeenCalledWith(
      'mcp-e2e-task',
      'Prefer an existing helper over a new utility file',
    );
    expect(text).toContain('mcp-e2e-task');
  });

  it('surfaces tool-level failures as MCP errors rather than transport errors', async () => {
    const result = (await client.callTool({
      name: 'trigger_issue_fix',
      arguments: { repository: 'not-a-repo', issue_number: 1 },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(
      result.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
    ).toMatch(/Invalid repository/);
  });

  it('supports independent concurrent clients (stateless transport)', async () => {
    const second = new Client({ name: 'e2e-client-2', version: '1.0.0' });
    await second.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));

    try {
      const [a, b] = await Promise.all([
        client.listTools(),
        second.listTools(),
      ]);
      expect(a.tools).toHaveLength(4);
      expect(b.tools).toHaveLength(4);
    } finally {
      await second.close();
    }
  });
});

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response } from 'express';
import type { Server } from 'http';
import { McpTaskService } from './mcp-task.service';
import { MCP_ENDPOINT } from './mcp.constants';
import { GithubService } from '../github/github.service';
import { registerTriggerIssueFixTool } from './tools/trigger-issue-fix.tool';
import { registerImplementFeatureTool } from './tools/implement-feature.tool';
import { registerGetPipelineStatusTool } from './tools/get-pipeline-status.tool';
import { registerProvideFeedbackTool } from './tools/provide-feedback.tool';

/**
 * Hosts the LazyDev MCP Server over Streamable HTTP for external MCP clients
 * (Hermes, OpenClaw).
 *
 * Deployment modes (see docs/sprint-plan/lazydev_mcp_server_plan.md §1):
 *  - Option A (default): served on the main API port via `McpController`.
 *  - Option B (`MCP_SERVER_PORT` set): standalone listener, so the MCP port can
 *    be firewalled independently of the public API. `McpController` then 404s.
 *
 * The transport runs in *stateless* mode: every request is self-contained, which
 * is all our request/response tools need (no server-initiated streaming).
 */
@Injectable()
export class McpServerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(McpServerService.name);
  private enabled = false;
  /** True in Option A — the endpoint is served on the main API port. */
  private servedOnMainPort = false;
  private standaloneServer?: Server;

  constructor(
    private readonly configService: ConfigService,
    private readonly taskService: McpTaskService,
    private readonly githubService: GithubService,
  ) {}

  onApplicationBootstrap() {
    if (this.configService.get<string>('MCP_SERVER_ENABLED') === 'false') {
      this.logger.log('MCP Server disabled via MCP_SERVER_ENABLED=false');
      return;
    }
    this.enabled = true;

    const mcpPort = this.configService.get<string>('MCP_SERVER_PORT');
    if (mcpPort) {
      this.startStandaloneServer(parseInt(mcpPort, 10));
    } else {
      this.servedOnMainPort = true;
      this.logger.log(
        `MCP Server served on the main API port at ${MCP_ENDPOINT}`,
      );
    }
  }

  /**
   * Entry point for the main-port route (`McpController`). Reports 404 when the
   * server is disabled or running isolated on its own port, so the MCP surface
   * is only reachable where it is meant to be.
   */
  async handleMainPortRequest(req: Request, res: Response): Promise<void> {
    if (!this.enabled || !this.servedOnMainPort) {
      res.status(404).json({
        statusCode: 404,
        message: `Cannot ${req.method} ${MCP_ENDPOINT}`,
        error: 'Not Found',
      });
      return;
    }
    await this.handleRequest(req, res);
  }

  async onModuleDestroy() {
    if (this.standaloneServer) {
      await new Promise<void>((resolve) =>
        this.standaloneServer!.close(() => resolve()),
      );
      this.standaloneServer = undefined;
    }
  }

  /**
   * Builds a server instance with the 4 tools exposed to Hermes / OpenClaw.
   *
   * A fresh instance is created per request: the SDK forbids reusing a stateless
   * transport across requests (message-id collisions between clients), so the
   * server it is connected to is short-lived too. Construction is cheap — it is
   * only object wiring, no I/O.
   */
  private createServer(): McpServer {
    const server = new McpServer({ name: 'lazydev-agent', version: '1.0.0' });

    registerTriggerIssueFixTool(server, this.taskService, this.githubService);
    registerImplementFeatureTool(server, this.taskService, this.githubService);
    registerGetPipelineStatusTool(server, this.taskService);
    registerProvideFeedbackTool(server, this.taskService);

    return server;
  }

  /** Option B — isolated listener that can be firewalled separately. */
  private startStandaloneServer(port: number) {
    const app = express();
    app.use(express.json({ limit: '4mb' }));

    // Streamable HTTP in stateless mode only answers POST; the SDK replies 405
    // to GET/DELETE itself, so all methods route to the same handler.
    app.all(MCP_ENDPOINT, (req: Request, res: Response) => {
      void this.handleRequest(req, res);
    });

    this.standaloneServer = app.listen(port, () =>
      this.logger.log(
        `Standalone MCP Server listening on port ${port}${MCP_ENDPOINT}`,
      ),
    );
  }

  private async handleRequest(req: Request, res: Response): Promise<void> {
    if (!this.isAuthorized(req)) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
      return;
    }

    if (!this.enabled) {
      res.status(503).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'MCP Server not initialized' },
        id: null,
      });
      return;
    }

    // Reject non-POST before reaching the transport. In stateless mode the SDK
    // skips session validation, so a GET would open a standalone SSE stream
    // that can never emit (there is no session to push notifications to) and is
    // only closed when the client disconnects — leaking a socket plus the
    // per-request server/transport for every stray GET.
    if (req.method !== 'POST') {
      res
        .status(405)
        .set('Allow', 'POST')
        .json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message:
              'Method Not Allowed. This MCP server is stateless — use POST for all requests.',
          },
          id: null,
        });
      return;
    }

    // One server + transport per request (stateless mode requirement).
    const server = this.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    const cleanup = () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    };
    res.on('close', cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`MCP request failed: ${message}`);
      cleanup();
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }

  /**
   * Optional bearer auth. When `MCP_AUTH_TOKEN` is unset we rely on network
   * isolation only — strongly discouraged when running in Option A, where the
   * endpoint shares the public API port.
   */
  private isAuthorized(req: Request): boolean {
    const expected = this.configService.get<string>('MCP_AUTH_TOKEN');
    if (!expected) return true;

    const header = req.headers.authorization;
    return header === `Bearer ${expected}`;
  }
}

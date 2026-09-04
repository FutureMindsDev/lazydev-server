import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpServerService } from './mcp-server.service';

/**
 * Serves the MCP endpoint on the main API port (deployment Option A).
 *
 * A Nest controller is used rather than registering a route directly on the
 * Express instance: routes added to the adapter after `app.init()` are shadowed
 * by Nest's catch-all 404 handler. Going through the router also means global
 * middleware, guards and filters apply normally.
 *
 * When `MCP_SERVER_PORT` is configured (Option B) the service serves its own
 * isolated listener and this route deliberately reports 404, so the MCP surface
 * is not reachable on the public API port.
 */
@Controller()
export class McpController {
  constructor(private readonly mcpServerService: McpServerService) {}

  @All('mcp')
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.mcpServerService.handleMainPortRequest(req, res);
  }
}

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

/**
 * Manual smoke test for the LazyDev MCP Server against a *running* instance
 * (e.g. `docker compose up`). Connects as a real MCP client — the same way
 * Hermes and OpenClaw do — and exercises tool discovery plus a status call.
 *
 * Usage:
 *   npx ts-node test/test-mcp-server.ts
 *   MCP_URL=http://localhost:3334/mcp npx ts-node test/test-mcp-server.ts
 *   MCP_AUTH_TOKEN=s3cret npx ts-node test/test-mcp-server.ts
 *
 * Optional — actually queue a pipeline run (requires the GitHub App to be
 * installed on the repo):
 *   TRIGGER_REPO=owner/repo TRIGGER_ISSUE=42 npx ts-node test/test-mcp-server.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const MCP_URL = process.env.MCP_URL ?? 'http://localhost:3200/mcp';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

function textOf(result: unknown): string {
  const { content } = result as CallToolResult;
  return (content ?? [])
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

async function main() {
  console.log(`--- Connecting to LazyDev MCP Server at ${MCP_URL} ---`);

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: AUTH_TOKEN
      ? { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } }
      : undefined,
  });

  const client = new Client({ name: 'lazydev-smoke-test', version: '1.0.0' });
  await client.connect(transport);
  console.log(
    '✅ Connected. Server:',
    JSON.stringify(client.getServerVersion()),
  );

  console.log('\n--- Tool discovery (what Hermes/OpenClaw will see) ---');
  const { tools } = await client.listTools();
  for (const tool of tools) {
    const params = Object.keys(tool.inputSchema?.properties ?? {}).join(', ');
    console.log(`  • ${tool.name}(${params})`);
    console.log(`      ${tool.description}`);
  }

  const expected = [
    'trigger_issue_fix',
    'implement_new_feature',
    'get_pipeline_status',
    'provide_human_feedback',
  ];
  const missing = expected.filter(
    (name) => !tools.some((t) => t.name === name),
  );
  if (missing.length) {
    throw new Error(`Missing expected tools: ${missing.join(', ')}`);
  }
  console.log(`✅ All ${expected.length} tools present`);

  console.log(
    '\n--- get_pipeline_status with an unknown id (expect a graceful message) ---',
  );
  console.log(
    textOf(
      await client.callTool({
        name: 'get_pipeline_status',
        arguments: { task_id: 'mcp-does-not-exist' },
      }),
    ),
  );

  console.log('\n--- Input validation (expect a rejection, not a crash) ---');
  console.log(
    textOf(
      await client.callTool({
        name: 'trigger_issue_fix',
        arguments: { repository: 'not-a-repo', issue_number: 1 },
      }),
    ),
  );

  const repo = process.env.TRIGGER_REPO;
  const issue = process.env.TRIGGER_ISSUE;
  if (repo && issue) {
    console.log(`\n--- Queueing a real fix for ${repo}#${issue} ---`);
    const result = await client.callTool({
      name: 'trigger_issue_fix',
      arguments: { repository: repo, issue_number: Number(issue) },
    });
    const text = textOf(result);
    console.log(text);

    const taskId = /task_id:\s*(\S+)/.exec(text)?.[1];
    if (taskId) {
      console.log(`\n--- Polling status for ${taskId} ---`);
      const status = await client.callTool({
        name: 'get_pipeline_status',
        arguments: { task_id: taskId },
      });
      console.log(textOf(status));
    }
  } else {
    console.log(
      '\n(Skipping the live pipeline trigger — set TRIGGER_REPO and TRIGGER_ISSUE to enable.)',
    );
  }

  await client.close();
  console.log('\n✅ Smoke test complete');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('\n❌ Smoke test failed:', message);
  process.exit(1);
});

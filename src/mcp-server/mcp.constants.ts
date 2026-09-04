/** HTTP path the Streamable HTTP transport is served on. */
export const MCP_ENDPOINT = '/mcp';

/**
 * Marker embedded in the body of issues created by the `implement_new_feature`
 * tool. The webhook handler uses it to skip `issues.opened` events for issues
 * the MCP server has already queued work for.
 */
export const MCP_ISSUE_MARKER = '<!-- lazydev:mcp -->';

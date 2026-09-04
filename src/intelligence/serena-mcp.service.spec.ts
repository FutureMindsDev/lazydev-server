import { SerenaMcpService } from './serena-mcp.service';

/**
 * Verifies our wrapper methods call Serena with the exact parameter names its
 * real tools expect (confirmed against oraios/serena's tool source —
 * file_tools.py's CreateTextFileTool, symbol_tools.py's RenameSymbolTool and
 * SafeDeleteSymbol — since a wrong key fails silently as a schema mismatch
 * rather than a loud error).
 */
describe('SerenaMcpService — new multi-action wrapper methods', () => {
  let service: SerenaMcpService;
  let callTool: jest.Mock;

  beforeEach(() => {
    service = new SerenaMcpService();
    callTool = jest.fn().mockResolvedValue({ isError: false });
    // `client` and `callTool` are private; reach in for this focused unit test
    // rather than standing up a real MCP connection.
    (service as unknown as { client: unknown }).client = { callTool };
  });

  it('createTextFile calls create_text_file with relative_path and content', async () => {
    await service.createTextFile('src/new.ts', 'export const x = 1;');

    expect(callTool).toHaveBeenCalledWith({
      name: 'create_text_file',
      arguments: {
        relative_path: 'src/new.ts',
        content: 'export const x = 1;',
      },
    });
  });

  it('safeDeleteSymbol calls safe_delete_symbol with name_path_pattern and relative_path', async () => {
    await service.safeDeleteSymbol('src/app.ts', 'deadCode');

    expect(callTool).toHaveBeenCalledWith({
      name: 'safe_delete_symbol',
      arguments: { name_path_pattern: 'deadCode', relative_path: 'src/app.ts' },
    });
  });

  it('renameSymbol calls rename_symbol with name_path, relative_path and new_name', async () => {
    await service.renameSymbol('src/app.ts', 'oldName', 'newName');

    expect(callTool).toHaveBeenCalledWith({
      name: 'rename_symbol',
      arguments: {
        name_path: 'oldName',
        relative_path: 'src/app.ts',
        new_name: 'newName',
      },
    });
  });

  it('insertBeforeSymbol calls insert_before_symbol with name_path, relative_path and body', async () => {
    await service.insertBeforeSymbol('src/app.ts', 'run', 'import x from "y";');

    expect(callTool).toHaveBeenCalledWith({
      name: 'insert_before_symbol',
      arguments: {
        name_path: 'run',
        relative_path: 'src/app.ts',
        body: 'import x from "y";',
      },
    });
  });
});

/**
 * Verified live against a running Serena 1.28.1 MCP server (schemas fetched
 * via listTools(), then exercised against a real checked-out repo) rather
 * than assumed from docs, since `serena-mcp.service.spec.ts`'s own history
 * shows a silently-wrong schema (the memory methods, above) can pass
 * unnoticed for a long time if nothing checks `isError`.
 */
describe('SerenaMcpService — read/search/diagnostics wrapper methods', () => {
  let service: SerenaMcpService;
  let callTool: jest.Mock;

  beforeEach(() => {
    service = new SerenaMcpService();
    callTool = jest.fn().mockResolvedValue({ isError: false });
    (service as unknown as { client: unknown }).client = { callTool };
  });

  it('readFile sends only relative_path when no line range is given', async () => {
    await service.readFile('src/app.ts');

    expect(callTool).toHaveBeenCalledWith({
      name: 'read_file',
      arguments: { relative_path: 'src/app.ts' },
    });
  });

  it('readFile sends start_line/end_line when a range is given', async () => {
    await service.readFile('src/app.ts', 0, 10);

    expect(callTool).toHaveBeenCalledWith({
      name: 'read_file',
      arguments: { relative_path: 'src/app.ts', start_line: 0, end_line: 10 },
    });
  });

  it('findSymbol sends name_path_pattern with relative_path and substring_matching defaults', async () => {
    await service.findSymbol('Home');

    expect(callTool).toHaveBeenCalledWith({
      name: 'find_symbol',
      arguments: {
        name_path_pattern: 'Home',
        relative_path: '',
        substring_matching: false,
      },
    });
  });

  it('findSymbol forwards relativePath and substringMatching options', async () => {
    await service.findSymbol('Home', {
      relativePath: 'app/page.tsx',
      substringMatching: true,
    });

    expect(callTool).toHaveBeenCalledWith({
      name: 'find_symbol',
      arguments: {
        name_path_pattern: 'Home',
        relative_path: 'app/page.tsx',
        substring_matching: true,
      },
    });
  });

  it('getDiagnosticsForFile defaults min_severity to 4 (all severities)', async () => {
    await service.getDiagnosticsForFile('app/page.tsx');

    expect(callTool).toHaveBeenCalledWith({
      name: 'get_diagnostics_for_file',
      arguments: { relative_path: 'app/page.tsx', min_severity: 4 },
    });
  });

  it('getDiagnosticsForFile forwards a requested min_severity (e.g. 1 for errors only)', async () => {
    await service.getDiagnosticsForFile('app/page.tsx', 1);

    expect(callTool).toHaveBeenCalledWith({
      name: 'get_diagnostics_for_file',
      arguments: { relative_path: 'app/page.tsx', min_severity: 1 },
    });
  });
});

/**
 * Regression coverage for a real bug found via live testing against Serena
 * 1.28.1: `write_memory`/`read_memory` require `memory_name` (not `name`) and
 * take NO project-path argument at all — `list_memories` takes only an
 * optional `topic`. The previous wrappers sent `{ name, project_path }`,
 * which fails Serena's own pydantic validation with "Field required:
 * memory_name" every time. Because no caller checked `isError`, every prior
 * memory write/read silently did nothing.
 */
describe('SerenaMcpService — memory methods (Serena 1.28.1 schema)', () => {
  let service: SerenaMcpService;
  let callTool: jest.Mock;

  beforeEach(() => {
    service = new SerenaMcpService();
    callTool = jest.fn().mockResolvedValue({ isError: false });
    (service as unknown as { client: unknown }).client = { callTool };
  });

  it('writeMemory sends memory_name + content, and nothing else', async () => {
    await service.writeMemory(
      'global_repo_structure',
      'This is a Next.js app.',
    );

    expect(callTool).toHaveBeenCalledWith({
      name: 'write_memory',
      arguments: {
        memory_name: 'global_repo_structure',
        content: 'This is a Next.js app.',
      },
    });
  });

  it('readMemory sends only memory_name', async () => {
    await service.readMemory('global_repo_structure');

    expect(callTool).toHaveBeenCalledWith({
      name: 'read_memory',
      arguments: { memory_name: 'global_repo_structure' },
    });
  });

  it('listMemories sends no arguments (Serena defaults topic to "")', async () => {
    await service.listMemories();

    expect(callTool).toHaveBeenCalledWith({
      name: 'list_memories',
      arguments: {},
    });
  });
});

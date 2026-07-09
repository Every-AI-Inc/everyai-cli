import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');
const mockPreload = path.join(repoRoot, 'tests', 'helpers', 'mock-mcp-fetch.mjs');

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 5_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseJsonStdout(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed).not.toBe('');
  return JSON.parse(trimmed) as Record<string, unknown>;
}

interface MockMcpServer {
  baseUrl: string;
  stateFile: string;
  listCalls: number;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  clearToolCalls(): void;
  close(): Promise<void>;
}

interface MockState {
  listCalls: number;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
}

function readMockState(filePath: string): MockState {
  return JSON.parse(readFileSync(filePath, 'utf8')) as MockState;
}

function writeMockState(filePath: string, state: MockState): void {
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}

async function createMockMcpServer(): Promise<MockMcpServer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-mcp-spawn-'));
  const stateFile = path.join(dir, 'state.json');
  writeMockState(stateFile, { listCalls: 0, toolCalls: [] });

  return {
    baseUrl: 'https://mock-mcp.everyai.test',
    stateFile,
    get listCalls() {
      return readMockState(stateFile).listCalls;
    },
    get toolCalls() {
      return readMockState(stateFile).toolCalls;
    },
    clearToolCalls() {
      const state = readMockState(stateFile);
      state.toolCalls = [];
      writeMockState(stateFile, state);
    },
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

async function tempConfig(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'everyai-cli-spawn-'));
}

function mockEnv(server: MockMcpServer, configDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const preload = `--import=${pathToFileURL(mockPreload).href}`;
  return {
    EVERY_MCP_URL: server.baseUrl,
    EVERY_CONFIG_DIR: configDir,
    EVERY_TOKEN: 'test-token',
    EVERYAI_FORCE_FILE_STORE: '1',
    EVERYAI_MOCK_MCP: '1',
    EVERYAI_MOCK_MCP_STATE: server.stateFile,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '),
    ...extra,
  };
}

describe('CLI contract', () => {
  it('uses usage exit code 2 without stdout for human unknown commands', async () => {
    const result = await runCli(['frobnicate']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe("error: unknown command 'frobnicate'");
  });

  it('emits a JSON usage envelope for unknown commands in --json mode', async () => {
    const result = await runCli(['frobnicate', '--json']);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    const parsed = parseJsonStdout(result.stdout);
    expect(parsed).toMatchObject({
      ok: false,
      error: { code: 'usage' },
      schema_version: 1,
    });
    expect(JSON.stringify(parsed)).not.toContain('Error:');
  });

  it('maps subcommand option errors to usage exit code 2', async () => {
    const result = await runCli(['ping', '--bad-option', '--json']);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(parseJsonStdout(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'usage' },
      schema_version: 1,
    });
  });

  it('emits version through the JSON envelope when --json is set', async () => {
    const result = await runCli(['--json', '--version']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseJsonStdout(result.stdout)).toEqual({
      ok: true,
      data: { version: '0.0.0' },
      schema_version: 1,
    });
  });

  it('emits help through the JSON envelope when --json is set', async () => {
    const result = await runCli(['--json', '--help']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = parseJsonStdout(result.stdout);
    expect(parsed).toMatchObject({ ok: true, schema_version: 1 });
    expect((parsed.data as { help: string }).help).toContain('Usage: every');
  });

  it('emits auth status through the JSON envelope without requiring login', async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-status-'));
    try {
      const result = await runCli(['auth', 'status', '--json'], {
        EVERY_CONFIG_DIR: configDir,
        EVERYAI_FORCE_FILE_STORE: '1',
        EVERY_TOKEN: '',
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true,
        data: {
          logged_in: false,
          storage_backend: 'file',
          every_token: false,
        },
        schema_version: 1,
      });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('fails fast with exit 3 when login is run without a TTY', async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-login-'));
    try {
      const result = await runCli(['login', '--json'], {
        EVERY_CONFIG_DIR: configDir,
        EVERYAI_FORCE_FILE_STORE: '1',
        EVERY_TOKEN: '',
      });

      expect(result.code).toBe(3);
      expect(result.stderr).toBe('');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: 'auth',
          message: 'login requires a browser; set EVERY_TOKEN for headless use',
        },
        schema_version: 1,
      });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('blocks a non-interactive write without --yes before tools/call', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(['tool', 'call', 'create_invoice', '--json'], mockEnv(server, configDir));

      expect(result.code).toBe(4);
      expect(result.stderr).toBe('');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'permission', message: 'Re-run with --yes to confirm this write.' },
      });
      expect(server.toolCalls).toHaveLength(0);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('executes a non-interactive write with --yes', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['tool', 'call', 'create_invoice', '--yes', '--arg', 'total=123', '--json'],
        mockEnv(server, configDir),
      );

      expect(result.code).toBe(0);
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true,
        data: {
          tool: 'create_invoice',
          is_error: false,
          structured_content: { received: { total: 123 } },
        },
      });
      expect(server.toolCalls).toEqual([{ name: 'create_invoice', arguments: { total: 123 } }]);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('requires --allow-destructive in addition to --yes for destructive tools', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const blocked = await runCli(
        ['tool', 'call', 'send_invoice', '--yes', '--json'],
        mockEnv(server, configDir),
      );
      expect(blocked.code).toBe(4);
      expect(parseJsonStdout(blocked.stdout)).toMatchObject({
        ok: false,
        error: { code: 'permission' },
      });
      expect((parseJsonStdout(blocked.stdout).error as { message: string }).message).toContain(
        '--allow-destructive',
      );
      expect(server.toolCalls).toHaveLength(0);

      const allowed = await runCli(
        ['tool', 'call', 'send_invoice', '--yes', '--allow-destructive', '--json'],
        mockEnv(server, configDir),
      );
      expect(allowed.code).toBe(0);
      expect(server.toolCalls).toEqual([{ name: 'send_invoice', arguments: {} }]);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('enforces read-only mode from flag and environment', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const writeBlocked = await runCli(
        ['tool', 'call', 'create_invoice', '--read-only', '--yes', '--json'],
        mockEnv(server, configDir),
      );
      expect(writeBlocked.code).toBe(4);
      expect(server.toolCalls).toHaveLength(0);

      const readAllowed = await runCli(
        ['tool', 'call', 'list_invoices', '--read-only', '--json'],
        mockEnv(server, configDir),
      );
      expect(readAllowed.code).toBe(0);
      expect(server.toolCalls).toEqual([{ name: 'list_invoices', arguments: {} }]);

      server.clearToolCalls();
      const envBlocked = await runCli(
        ['tool', 'call', 'create_invoice', '--yes', '--json'],
        mockEnv(server, configDir, { EVERY_READ_ONLY: '1' }),
      );
      expect(envBlocked.code).toBe(4);
      expect(server.toolCalls).toHaveLength(0);

      const assistantBlocked = await runCli(
        ['tool', 'call', 'ask_assistant', '--read-only', '--yes', '--json'],
        mockEnv(server, configDir),
      );
      expect(assistantBlocked.code).toBe(4);
      expect(parseJsonStdout(assistantBlocked.stdout)).toMatchObject({
        ok: false,
        error: { code: 'permission' },
      });
      expect(server.toolCalls).toHaveLength(0);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('renders tool call text in human mode and the envelope in --json mode', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const human = await runCli(['tool', 'call', 'list_invoices'], mockEnv(server, configDir));
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('called list_invoices');
      expect(human.stdout).toContain('"received": {}');

      const json = await runCli(
        ['tool', 'call', 'list_invoices', '--arg', 'limit=2', '--json'],
        mockEnv(server, configDir),
      );
      expect(json.code).toBe(0);
      expect(parseJsonStdout(json.stdout)).toMatchObject({
        ok: true,
        data: {
          tool: 'list_invoices',
          is_error: false,
          content: [{ type: 'text', text: 'called list_invoices' }],
          structured_content: { received: { limit: 2 } },
        },
      });
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('maps tool-level isError:true to exit 1 with the content as the error message', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(['tool', 'call', 'tool_error', '--json'], mockEnv(server, configDir));

      expect(result.code).toBe(1);
      expect(result.stderr).toBe('');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'generic', message: 'tool exploded' },
      });
      expect(server.toolCalls).toEqual([{ name: 'tool_error', arguments: {} }]);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('explains ask_assistant policy offline without requiring auth or network', async () => {
    const configDir = await tempConfig();
    try {
      const result = await runCli(['policy', 'explain', 'ask_assistant', '--json'], {
        EVERY_CONFIG_DIR: configDir,
        EVERY_TOKEN: '',
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true,
        data: {
          tool: 'ask_assistant',
          level: 'ai-mediated',
          source: 'override',
        },
      });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

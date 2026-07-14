import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
  cwd = repoRoot,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
      cwd,
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

function runNode(args: string[], timeoutMs = 5_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`node did not exit within ${timeoutMs}ms: ${args.join(' ')}`));
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
  openidCalls: number;
  userinfoCalls: number;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  clearToolCalls(): void;
  close(): Promise<void>;
}

interface MockState {
  listCalls: number;
  openidCalls: number;
  userinfoCalls: number;
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
  writeMockState(stateFile, {
    listCalls: 0,
    openidCalls: 0,
    userinfoCalls: 0,
    toolCalls: [],
  });

  return {
    baseUrl: 'https://mock-mcp.everyai.test',
    stateFile,
    get listCalls() {
      return readMockState(stateFile).listCalls;
    },
    get openidCalls() {
      return readMockState(stateFile).openidCalls;
    },
    get userinfoCalls() {
      return readMockState(stateFile).userinfoCalls;
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
      env: 'production',
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
      env: 'production',
      schema_version: 1,
    });
  });

  it('emits version through the JSON envelope when --json is set', async () => {
    const result = await runCli(['--json', '--version']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const pkgVersion = (
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;
    expect(parseJsonStdout(result.stdout)).toEqual({
      ok: true,
      data: { version: pkgVersion },
      env: 'production',
      schema_version: 1,
    });
  });

  it('emits help through the JSON envelope when --json is set', async () => {
    const result = await runCli(['--json', '--help']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = parseJsonStdout(result.stdout);
    expect(parsed).toMatchObject({ ok: true, env: 'production', schema_version: 1 });
    expect((parsed.data as { help: string }).help).toContain('Usage: every');
  });

  it('documents account creation in login help', async () => {
    const result = await runCli(['login', '--help']);

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toContain('--create-account');
    expect(result.stdout + result.stderr).toContain(
      'Log in (or create an account) with browser-based OAuth and store tokens locally',
    );
  });

  it('keeps non-TTY bare invocation on the plain help path', async () => {
    const result = await runCli([]);

    expect(result.code).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain('Usage: every');
    expect(output).not.toContain('Welcome to Every AI');
  });

  it('keeps --json bare invocation on the help envelope path', async () => {
    const result = await runCli(['--json']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = parseJsonStdout(result.stdout);
    expect(parsed).toMatchObject({ ok: true, env: 'production', schema_version: 1 });
    expect((parsed.data as { help: string }).help).toContain('Usage: every');
  });

  it('prints offline docs with conventions and bundled workflows', async () => {
    const human = await runCli(['docs']);
    expect(human.code).toBe(0);
    expect(human.stderr).toBe('');
    expect(human.stdout).toContain('Exit codes:');
    expect(human.stdout).toContain('every tool call <name> --arg k=v');
    expect(human.stdout).toContain('Invoice flow:');

    const json = await runCli(['docs', '--json']);
    expect(json.code).toBe(0);
    expect(json.stderr).toBe('');
    const parsed = parseJsonStdout(json.stdout);
    expect(parsed).toMatchObject({ ok: true, env: 'production' });
    expect((parsed.data as { commands: string }).commands).toContain('every tools list');
    expect((parsed.data as { commands: string }).commands).toContain(
      'every login --create-account',
    );
    expect((parsed.data as { conventions: string }).conventions).toContain('--staging');
    expect((parsed.data as { workflows: string }).workflows).toContain('Invoice flow:');
  });

  it('postinstall exits 0 and prints the binary name', async () => {
    const result = await runNode(['scripts/postinstall.mjs']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('every');
    expect(result.stdout).toContain('everyai');
  });

  it('package.json exposes both every and everyai bins', () => {
    const pkgJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      bin: Record<string, string>;
    };

    expect(pkgJson.bin).toMatchObject({
      every: 'dist/index.js',
      everyai: 'dist/index.js',
    });
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
        env: 'production',
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
        env: 'production',
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

  it('whoami reports userinfo identity, org, environment, and tool count', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(['whoami', '--json'], mockEnv(server, configDir));

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Tip: teach your coding agent this CLI');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true,
        env: 'custom',
        data: {
          authenticated: true,
          user_id: 'user_123',
          subject: 'user_123',
          email: 'person@example.com',
          name: 'Person Example',
          org_id: 'org_123',
          org_slug: 'acme',
          org_name: 'Acme Co',
          environment: 'custom',
          base_url: server.baseUrl,
          tools: expect.any(Number),
        },
      });
      expect(server.userinfoCalls).toBe(1);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('org reports the userinfo org and keeps legacy organization fields', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(['org', '--json'], mockEnv(server, configDir));

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true,
        env: 'custom',
        data: {
          org_id: 'org_123',
          org_slug: 'acme',
          org_name: 'Acme Co',
          organization_id: 'org_123',
          organization_slug: 'acme',
          organization_name: 'Acme Co',
        },
      });
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('whoami uses the userinfo cache on a second call inside the TTL', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const first = await runCli(['whoami', '--json'], mockEnv(server, configDir));
      const second = await runCli(['whoami', '--json'], mockEnv(server, configDir));

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(server.userinfoCalls).toBe(1);
      expect(server.openidCalls).toBe(1);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('whoami maps userinfo 401 to exit 3', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['whoami', '--json'],
        mockEnv(server, configDir, { EVERYAI_MOCK_USERINFO_STATUS: '401' }),
      );

      expect(result.code).toBe(3);
      expect(result.stderr).toBe('');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: false,
        env: 'custom',
        error: { code: 'auth' },
      });
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('filters tools list by name or description in JSON mode', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['tools', 'list', '--filter', 'invoice', '--json'],
        mockEnv(server, configDir),
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Tip: teach your coding agent this CLI');
      const parsed = parseJsonStdout(result.stdout);
      expect(parsed).toMatchObject({ ok: true, env: 'custom' });
      const tools = parsed.data as Array<{ name: string; description?: string }>;
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((tool) => {
        const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
        return haystack.includes('invoice');
      })).toBe(true);
      expect(server.userinfoCalls).toBe(0);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('shows the coding-agent skill hint once and writes the marker', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const first = await runCli(['tools', 'list', '--json'], mockEnv(server, configDir));
      const second = await runCli(['tools', 'list', '--json'], mockEnv(server, configDir));

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(first.stderr).toContain('Tip: teach your coding agent this CLI');
      expect(second.stderr).toBe('');
      expect(parseJsonStdout(first.stdout)).toMatchObject({ ok: true });
      expect(JSON.parse(readFileSync(path.join(configDir, 'hints.json'), 'utf8'))).toMatchObject({
        skill_hint_shown: true,
      });
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('suppresses the skill hint when the local Claude skill already exists', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    const claudeRoot = path.join(repoRoot, '.claude');
    const skillsRoot = path.join(claudeRoot, 'skills');
    const skillDir = path.join(skillsRoot, 'use-every');
    const hadClaudeRoot = existsSync(claudeRoot);
    const hadSkillsRoot = existsSync(skillsRoot);
    const hadSkillDir = existsSync(skillDir);
    try {
      await mkdir(skillDir, { recursive: true });
      const result = await runCli(
        ['tools', 'list', '--json'],
        mockEnv(server, configDir),
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(parseJsonStdout(result.stdout)).toMatchObject({ ok: true, env: 'custom' });

      const targeted = await runCli(
        ['tools', 'list', '--json'],
        mockEnv(server, configDir, { CLAUDECODE: undefined, CODEX_FOO: '1' }),
      );
      expect(targeted.code).toBe(0);
      expect(targeted.stderr).toContain('every skills install codex');
      expect(parseJsonStdout(targeted.stdout)).toMatchObject({ ok: true, env: 'custom' });
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
      if (!hadSkillDir) await rm(skillDir, { recursive: true, force: true });
      if (!hadSkillsRoot) await rm(skillsRoot, { recursive: true, force: true });
      if (!hadClaudeRoot) await rm(claudeRoot, { recursive: true, force: true });
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
        env: 'custom',
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
      expect(result.stderr).toContain('Tip: teach your coding agent this CLI');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true,
        env: 'custom',
        data: {
          tool: 'create_invoice',
          is_error: false,
          structured_content: { received: { total: 123 } },
          org: { org_id: 'org_123', org_name: 'Acme Co' },
        },
      });
      expect(server.toolCalls).toEqual([{ name: 'create_invoice', arguments: { total: 123 } }]);
      expect(server.userinfoCalls).toBe(1);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('prints the target org and environment to stderr for human gated calls', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['tool', 'call', 'create_invoice', '--yes', '--arg', 'total=123'],
        mockEnv(server, configDir),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('called create_invoice');
      expect(result.stderr).toContain('→ Acme Co (org_123) · custom');
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
      const readEnvelope = parseJsonStdout(readAllowed.stdout);
      expect(readEnvelope).toMatchObject({
        ok: true,
        env: 'custom',
        data: { tool: 'list_invoices' },
      });
      expect((readEnvelope.data as Record<string, unknown>).org).toBeUndefined();
      expect(server.toolCalls).toEqual([{ name: 'list_invoices', arguments: {} }]);
      expect(server.userinfoCalls).toBe(0);

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
        env: 'custom',
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

  it.each([
    ['send_email', 'destructive', 'override'],
    ['draft_email', 'write', 'annotation'],
    ['cancel_booking', 'destructive', 'override'],
    ['run_recurring_invoice_now', 'destructive', 'override'],
  ])(
    'explains %s policy correctly without cached server metadata',
    async (toolName, level, source) => {
      const configDir = await tempConfig();
      try {
        const result = await runCli(['policy', 'explain', toolName, '--json'], {
          EVERY_CONFIG_DIR: configDir,
          EVERY_TOKEN: '',
        });

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(parseJsonStdout(result.stdout)).toMatchObject({
          ok: true,
          data: {
            tool: toolName,
            level,
            source,
          },
        });
      } finally {
        await rm(configDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      ['invoice', 'list', '--status', 'overdue', '--search', 'acme', '--limit', '3', '--json'],
      { name: 'list_invoices', arguments: { payment_status: 'overdue', search: 'acme', limit: 3 } },
    ],
    [
      ['invoice', 'send', 'inv_123', '--yes', '--allow-destructive', '--json'],
      { name: 'send_invoice', arguments: { invoice_id: 'inv_123' } },
    ],
    [
      ['deal', 'list', '--stage', 'opportunity', '--search', 'acme', '--limit', '4', '--json'],
      { name: 'list_deals', arguments: { stage: 'opportunity', search: 'acme', limit: 4 } },
    ],
    [
      ['deal', 'move', 'deal_123', 'won', '--yes', '--json'],
      { name: 'move_deal_stage', arguments: { deal_id: 'deal_123', stage: 'won' } },
    ],
    [
      ['contact', 'list', '--search', 'Brandon', '--limit', '2', '--json'],
      { name: 'list_contacts', arguments: { name: 'Brandon', limit: 2 } },
    ],
  ])('maps alias %s to the expected tool call', async (args, expectedCall) => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(args, mockEnv(server, configDir));

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Tip: teach your coding agent this CLI');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true,
        env: 'custom',
        data: {
          tool: expectedCall.name,
          is_error: false,
          structured_content: { received: expectedCall.arguments },
        },
      });
      expect(server.toolCalls).toEqual([expectedCall]);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('keeps the destructive gate on invoice send aliases', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(['invoice', 'send', 'inv_123', '--json'], mockEnv(server, configDir));

      expect(result.code).toBe(4);
      expect(result.stderr).toBe('');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'permission' },
      });
      expect(server.toolCalls).toHaveLength(0);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('renders the same JSON envelope for an alias and equivalent tool call', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const env = mockEnv(server, configDir);
      const alias = await runCli(
        ['deal', 'list', '--stage', 'lead', '--limit', '2', '--json'],
        env,
      );
      const direct = await runCli(
        ['tool', 'call', 'list_deals', '--arg', 'stage=lead', '--arg', 'limit=2', '--json'],
        env,
      );

      expect(alias.code).toBe(0);
      expect(direct.code).toBe(0);
      expect(parseJsonStdout(alias.stdout)).toEqual(parseJsonStdout(direct.stdout));
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

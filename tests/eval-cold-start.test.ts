import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseClientCandidates } from '../src/commands/aliases';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');
const mockPreload = path.join(repoRoot, 'tests', 'helpers', 'mock-mcp-fetch.mjs');

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface MockState {
  listCalls: number;
  openidCalls: number;
  userinfoCalls: number;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
}

interface MockMcpServer {
  baseUrl: string;
  stateFile: string;
  get toolCalls(): Array<{ name: string; arguments: Record<string, unknown> }>;
  clearToolCalls(): void;
  close(): Promise<void>;
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

function readMockState(filePath: string): MockState {
  return JSON.parse(readFileSync(filePath, 'utf8')) as MockState;
}

function writeMockState(filePath: string, state: MockState): void {
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}

async function createMockMcpServer(): Promise<MockMcpServer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-eval-mcp-'));
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
  return mkdtemp(path.join(os.tmpdir(), 'everyai-cli-eval-'));
}

function mockEnv(
  server: MockMcpServer,
  configDir: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
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

function withClients(clients: Array<Record<string, unknown>>): NodeJS.ProcessEnv {
  return { EVERYAI_MOCK_LIST_CLIENTS_JSON: JSON.stringify(clients) };
}

function callsNamed(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  name: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  return calls.filter((call) => call.name === name);
}

const brandonClient = {
  client_id: '00000000-0000-4000-8000-000000000001',
  name: 'Brandon Chu',
  email: 'brandon@example.com',
};

describe('cold-start invoice eval', () => {
  it('keeps the documented agent path within the round-trip budget', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    const invocations: CliResult[] = [];
    try {
      const env = mockEnv(server, configDir, withClients([brandonClient]));

      invocations.push(await runCli(['docs'], env));
      invocations.push(await runCli(['whoami', '--json'], env));
      invocations.push(await runCli(
        ['invoice', 'create', '--client', 'Brandon Chu', '--amount', '100', '--yes', '--json'],
        env,
      ));

      expect(invocations).toHaveLength(3);
      expect(invocations.length).toBeLessThanOrEqual(5);
      expect(invocations.every((result) => result.code === 0)).toBe(true);

      const createEnvelope = parseJsonStdout(invocations[2].stdout);
      expect(createEnvelope).toMatchObject({
        ok: true,
        env: 'custom',
        data: {
          resolved_client: {
            client_id: brandonClient.client_id,
            name: brandonClient.name,
          },
          org: { org_id: 'org_123', org_name: 'Acme Co' },
        },
      });

      const toolCalls = server.toolCalls;
      expect(callsNamed(toolCalls, 'list_clients')).toHaveLength(1);
      expect(callsNamed(toolCalls, 'create_invoice')).toHaveLength(1);
      expect(toolCalls).toEqual([
        { name: 'list_clients', arguments: { name: 'Brandon Chu' } },
        {
          name: 'create_invoice',
          arguments: {
            client_id: brandonClient.client_id,
            line_items: [
              { description: 'Services', quantity: 1, unit_price: 100 },
            ],
          },
        },
      ]);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('returns mechanical ambiguity candidates and supports a client-id retry', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    const invocations: CliResult[] = [];
    const ambiguousClients = [
      brandonClient,
      {
        client_id: '00000000-0000-4000-8000-000000000002',
        name: 'Brandon Projects LLC',
        email: 'ops@example.com',
      },
    ];

    try {
      const ambiguousEnv = mockEnv(server, configDir, withClients(ambiguousClients));
      invocations.push(await runCli(
        ['invoice', 'create', '--client', 'Brandon', '--amount', '100', '--yes', '--json'],
        ambiguousEnv,
      ));

      expect(invocations[0].code).toBe(6);
      const ambiguousEnvelope = parseJsonStdout(invocations[0].stdout);
      expect(ambiguousEnvelope).toMatchObject({
        ok: false,
        env: 'custom',
        error: { code: 'not_found' },
      });
      expect((ambiguousEnvelope.error as { candidates: unknown[] }).candidates).toHaveLength(2);
      expect(callsNamed(server.toolCalls, 'list_clients')).toHaveLength(1);
      expect(callsNamed(server.toolCalls, 'create_invoice')).toHaveLength(0);

      server.clearToolCalls();
      invocations.push(await runCli(
        [
          'invoice',
          'create',
          '--client-id',
          brandonClient.client_id,
          '--amount',
          '100',
          '--yes',
          '--json',
        ],
        ambiguousEnv,
      ));

      expect(invocations).toHaveLength(2);
      expect(invocations[1].code).toBe(0);
      expect(callsNamed(server.toolCalls, 'list_clients')).toHaveLength(0);
      expect(callsNamed(server.toolCalls, 'create_invoice')).toHaveLength(1);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('invoice client resolution parser', () => {
  const realShapeMarkdown = [
    'Found matching clients:',
    '- **Brandon Chu** — brandon@example.com [id: 00000000-0000-4000-8000-000000000001]',
    '- **Brandon Projects LLC** — ops@example.com [id: 00000000-0000-4000-8000-000000000002]',
  ].join('\n');

  it('parses one structured candidate', () => {
    expect(parseClientCandidates({
      structured_content: {
        clients: [{ client_id: 'client_1', name: 'Acme Co' }],
      },
    })).toEqual([{ client_id: 'client_1', name: 'Acme Co' }]);
  });

  it('parses zero candidates from empty or malformed text', () => {
    expect(parseClientCandidates({
      content: [{ type: 'text', text: 'No clients found.\n- Missing Id Corp\n- [id: client_no_name]' }],
    })).toEqual([]);
  });

  it('parses many markdown candidates with id markers', () => {
    expect(parseClientCandidates({
      structured_content: { result: realShapeMarkdown },
    })).toEqual([
      { client_id: '00000000-0000-4000-8000-000000000001', name: 'Brandon Chu' },
      { client_id: '00000000-0000-4000-8000-000000000002', name: 'Brandon Projects LLC' },
    ]);
  });

  it('ignores malformed lines while keeping valid candidates', () => {
    expect(parseClientCandidates({
      content: [{
        type: 'text',
        text: [
          '- No id Client',
          '- [id: client_no_name]',
          '- **Valid Client** [id: client_valid]',
        ].join('\n'),
      }],
    })).toEqual([{ client_id: 'client_valid', name: 'Valid Client' }]);
  });
});

describe('invoice create command guards', () => {
  it('returns usage exit 2 for invalid amounts before MCP tool calls', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['invoice', 'create', '--client', 'Brandon Chu', '--amount', '0', '--yes', '--json'],
        mockEnv(server, configDir, withClients([brandonClient])),
      );

      expect(result.code).toBe(2);
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'usage' },
      });
      expect(server.toolCalls).toHaveLength(0);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('requires either --client or --client-id', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['invoice', 'create', '--amount', '100', '--yes', '--json'],
        mockEnv(server, configDir),
      );

      expect(result.code).toBe(2);
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'usage' },
      });
      expect(server.toolCalls).toHaveLength(0);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('bypasses list_clients when --client-id is supplied', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        [
          'invoice',
          'create',
          '--client-id',
          brandonClient.client_id,
          '--amount',
          '100',
          '--yes',
          '--json',
        ],
        mockEnv(server, configDir, withClients([brandonClient])),
      );

      expect(result.code).toBe(0);
      expect(callsNamed(server.toolCalls, 'list_clients')).toHaveLength(0);
      expect(callsNamed(server.toolCalls, 'create_invoice')).toHaveLength(1);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('keeps the write gate before create_invoice without --yes', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['invoice', 'create', '--client', 'Brandon Chu', '--amount', '100', '--json'],
        mockEnv(server, configDir, withClients([brandonClient])),
      );

      expect(result.code).toBe(4);
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'permission' },
      });
      expect(callsNamed(server.toolCalls, 'list_clients')).toHaveLength(1);
      expect(callsNamed(server.toolCalls, 'create_invoice')).toHaveLength(0);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

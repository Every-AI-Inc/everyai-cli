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
  return { EVERYAI_MOCK_LIST_COMPANIES_JSON: JSON.stringify(clients) };
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

// create_invoice's live server contract (mcp_server/admin/financial_models.py
// InvoiceCreate, as of the party-argument migration): a UUID v4 operation_id.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function targetIdFor(label: string): string {
  const hex = Buffer.from(label.padEnd(12, '0').slice(0, 12)).toString('hex').slice(0, 12).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

describe('cold-start signup eval', () => {
  it('signs a brand-new user up in two agent invocations without a TTY', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const env = mockEnv(server, configDir, {
        EVERY_TOKEN: '',
        EVERYAI_MOCK_BROWSER: '1',
        EVERYAI_MOCK_SIGNUP: '1',
        EVERYAI_MOCK_SIGNUP_GATE: '1',
        EVERYAI_MOCK_CONFIRMATION_GATE: '1',
      });

      // Before signup finishes, other tools are refused with the stable code.
      const signup = await runCli(['signup', '--json'], env);
      const gated = await runCli(['tool', 'call', 'list_invoices', '--json'], env);
      const complete = await runCli(
        ['signup', 'complete', '--org-name', 'Acme Studio', '--yes', '--json'],
        env,
      );
      const after = await runCli(['tool', 'call', 'list_invoices', '--json'], env);

      // The documented agent path is exactly `signup` then `signup complete`.
      expect(signup.code, signup.stderr).toBe(0);
      const signupLines = signup.stdout.trim().split('\n').map((line) => JSON.parse(line));
      expect(signupLines[0]).toMatchObject({ event: 'authorization_required' });
      expect(signupLines.at(-1)).toMatchObject({ ok: true, data: { signup_status: 'needs_profile' } });
      expect(gated.code).toBe(1);
      expect(parseJsonStdout(gated.stdout)).toMatchObject({ error: { code: 'signup_incomplete' } });
      expect(complete.code, complete.stderr).toBe(0);
      expect(parseJsonStdout(complete.stdout)).toMatchObject({ ok: true, data: { account_ready: true } });
      expect(after.code, after.stderr).toBe(0);

      expect(callsNamed(server.toolCalls, 'complete_signup')).toHaveLength(2);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('cold-start invoice eval', () => {
  it('keeps the documented agent path within the round-trip budget', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    const invocations: CliResult[] = [];
    try {
      const env = mockEnv(server, configDir, {
        ...withClients([brandonClient]),
        EVERYAI_MOCK_CONFIRMATION_GATE: '1',
      });

      invocations.push(await runCli(['docs'], env));
      invocations.push(await runCli(['whoami', '--json'], env));
      invocations.push(await runCli(
        ['invoice', 'create', '--company', 'Brandon Chu', '--amount', '100', '--yes', '--json'],
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
            kind: 'company',
            name: brandonClient.name,
          },
          org: { org_id: 'org_123', org_name: 'Acme Co' },
        },
      });

      const toolCalls = server.toolCalls;
      expect(callsNamed(toolCalls, 'list_companies')).toHaveLength(1);
      const createCalls = callsNamed(toolCalls, 'create_invoice');
      expect(createCalls).toHaveLength(2);

      // The server's structured contract: create_invoice's single argument is
      // `command: {operation_id, party: {kind, id}, line_items}` (client_id is
      // retired on this tool). Both calls share one operation_id — the CLI's
      // built-in confirmation retry must reuse it, never mint a second UUID.
      const operationId = (createCalls[0].arguments.command as Record<string, unknown>)
        .operation_id as string;
      expect(operationId).toMatch(UUID_V4_RE);

      expect(toolCalls).toEqual([
        { name: 'list_companies', arguments: { query: 'Brandon Chu' } },
        {
          name: 'create_invoice',
          arguments: {
            command: {
              operation_id: operationId,
              party: { kind: 'company', id: brandonClient.client_id },
              line_items: [
                { description: 'Services', quantity: 1, unit_price: 100 },
              ],
            },
          },
        },
        {
          name: 'create_invoice',
          arguments: {
            command: {
              operation_id: operationId,
              party: { kind: 'company', id: brandonClient.client_id },
              line_items: [
                { description: 'Services', quantity: 1, unit_price: 100 },
              ],
            },
            confirmation: `create invoice ${brandonClient.client_id}`,
          },
        },
      ]);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('returns mechanical ambiguity candidates and supports a company-id retry', async () => {
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
        ['invoice', 'create', '--company', 'Brandon', '--amount', '100', '--yes', '--json'],
        ambiguousEnv,
      ));

      expect(invocations[0].code).toBe(6);
      const ambiguousEnvelope = parseJsonStdout(invocations[0].stdout);
      expect(ambiguousEnvelope).toMatchObject({
        ok: false,
        env: 'custom',
        error: {
          code: 'not_found',
          message: expect.stringContaining('Re-run with --company-id <id>'),
        },
      });
      expect((ambiguousEnvelope.error as { candidates: unknown[] }).candidates).toHaveLength(2);
      expect(callsNamed(server.toolCalls, 'list_companies')).toHaveLength(1);
      expect(callsNamed(server.toolCalls, 'create_invoice')).toHaveLength(0);

      server.clearToolCalls();
      invocations.push(await runCli(
        [
          'invoice',
          'create',
          '--company-id',
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
      expect(invocations[1].stderr).not.toContain('deprecated');
      expect(callsNamed(server.toolCalls, 'list_companies')).toHaveLength(0);
      expect(callsNamed(server.toolCalls, 'create_invoice')).toHaveLength(1);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

// Proves `every invoice create`'s built payload actually satisfies the live
// create_invoice schema (tests/fixtures/tools-alias-schemas.json, mirrored from
// mcp_server/admin/financial_models.py's InvoiceCreate/FinancialParty/NewLineItem).
// A fixture pinned to the old flat client_id shape is exactly what let this ship
// broken twice, so this reads the schema from the fixture rather than duplicating
// field names by hand.
describe('create_invoice payload matches the live server schema', () => {
  const fixturePath = path.join(repoRoot, 'tests', 'fixtures', 'tools-alias-schemas.json');
  const fixtureTools = JSON.parse(readFileSync(fixturePath, 'utf8')) as Array<{
    name: string;
    inputSchema: { $defs?: Record<string, { required?: string[]; properties?: Record<string, { enum?: unknown[] }> }> };
  }>;
  const defs = fixtureTools.find((tool) => tool.name === 'create_invoice')!.inputSchema.$defs!;
  const invoiceCreateDef = defs.InvoiceCreate;
  const financialPartyDef = defs.FinancialParty;
  const newLineItemDef = defs.NewLineItem;

  function assertRequiredKeys(value: Record<string, unknown>, required: string[] | undefined, label: string): void {
    for (const key of required ?? []) {
      expect(Object.prototype.hasOwnProperty.call(value, key), `${label} missing required "${key}"`).toBe(true);
    }
  }

  it.each([
    ['company' as const, targetIdFor('company')],
    ['person' as const, targetIdFor('person')],
  ])('sends a %s party under command that satisfies InvoiceCreate/FinancialParty/NewLineItem', async (kind, targetId) => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const args =
        kind === 'company'
          ? ['invoice', 'create', '--company', 'Acme', '--amount', '250', '--description', 'Consulting', '--quantity', '2', '--yes', '--json']
          // --person-id carries the Person kind itself; no name search runs.
          : ['invoice', 'create', '--person-id', targetId, '--amount', '250', '--description', 'Consulting', '--quantity', '2', '--yes', '--json'];
      const env =
        kind === 'company'
          ? mockEnv(server, configDir, withClients([{ client_id: targetId, name: 'Acme' }]))
          : mockEnv(server, configDir);

      const result = await runCli(args, env);
      expect(result.code).toBe(0);

      const createCall = callsNamed(server.toolCalls, 'create_invoice')[0];
      expect(createCall).toBeDefined();
      const command = createCall.arguments.command as Record<string, unknown>;

      assertRequiredKeys(command, invoiceCreateDef.required, 'command');
      expect(command.operation_id).toMatch(UUID_V4_RE);
      expect(Array.isArray(command.line_items)).toBe(true);
      expect((command.line_items as unknown[]).length).toBeGreaterThanOrEqual(1);
      expect(command).not.toHaveProperty('client_id');

      const party = command.party as Record<string, unknown>;
      assertRequiredKeys(party, financialPartyDef.required, 'command.party');
      expect(financialPartyDef.properties!.kind.enum).toContain(party.kind);
      expect(party.kind).toBe(kind);
      expect(party.id).toBe(targetId);

      for (const item of command.line_items as Record<string, unknown>[]) {
        assertRequiredKeys(item, newLineItemDef.required, 'command.line_items[]');
      }
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it.each([
    [['--company-id', targetIdFor('cid')], { kind: 'company', id: targetIdFor('cid') }],
    [['--person-id', targetIdFor('pid')], { kind: 'person', id: targetIdFor('pid') }],
    [['--company-id', targetIdFor('cid'), '--company', 'Acme'], { kind: 'company', id: targetIdFor('cid') }],
  ])('sends %j as the typed party without a name search or deprecation note', async (flags, party) => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['invoice', 'create', ...flags, '--amount', '100', '--yes', '--json'],
        mockEnv(server, configDir),
      );

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain('deprecated');
      expect(callsNamed(server.toolCalls, 'list_companies')).toHaveLength(0);
      expect(callsNamed(server.toolCalls, 'list_people')).toHaveLength(0);
      const command = callsNamed(server.toolCalls, 'create_invoice')[0].arguments.command as Record<string, unknown>;
      expect(command.party).toEqual(party);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it.each([
    // Deprecated --client-id keeps its old behaviour: company unless --person names a Person.
    [['--client-id', targetIdFor('bare')], { kind: 'company', id: targetIdFor('bare') }],
    [['--client-id', targetIdFor('bob'), '--person', 'Bob'], { kind: 'person', id: targetIdFor('bob') }],
  ])('keeps the deprecated %j working with a one-line stderr note', async (flags, party) => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['invoice', 'create', ...flags, '--amount', '100', '--yes', '--json'],
        mockEnv(server, configDir),
      );

      expect(result.code).toBe(0);
      const notes = result.stderr.split('\n').filter((line) => line.includes('deprecated'));
      expect(notes).toEqual(['Note: `--client-id` is deprecated; use `--company-id` or `--person-id`.']);
      expect(parseJsonStdout(result.stdout)).toMatchObject({ ok: true });
      const command = callsNamed(server.toolCalls, 'create_invoice')[0].arguments.command as Record<string, unknown>;
      expect(command.party).toEqual(party);
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

  it('does not surface a matched record\'s own nested affiliation as a second candidate', () => {
    // Real list_people/list_companies responses nest an `affiliations[].person`/
    // `.company` sub-object that itself carries its own id+name (staging
    // verified 2026-09-10: a single real person match was reported as
    // "Multiple persons matching" because the company from their own
    // affiliation record was picked up as a spurious sibling candidate).
    expect(parseClientCandidates({
      structured_content: {
        items: [
          {
            id: 'person_1',
            name: 'Primary Contact',
            affiliations: [
              {
                person: { id: 'person_1', name: 'Primary Contact' },
                company: { id: 'company_1', name: 'Ethan Hughes' },
              },
            ],
          },
        ],
        total: 1,
        has_more: false,
      },
    })).toEqual([{ client_id: 'person_1', name: 'Primary Contact' }]);
  });
});

describe('invoice create command guards', () => {
  it('returns usage exit 2 for invalid amounts before MCP tool calls', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['invoice', 'create', '--company', 'Brandon Chu', '--amount', '0', '--yes', '--json'],
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

  it.each([
    [[], 'One of --company, --person, --company-id, or --person-id is required'],
    [['--company-id', 'c1', '--person-id', 'p1'], 'Use only one of --company-id or --person-id'],
    [['--company-id', 'c1', '--client-id', 'x1'], 'Use only one of --company-id or --person-id'],
    [['--company-id', 'c1', '--person', 'Bob'], '--company-id names a company; use --person-id for a person'],
    [['--person-id', 'p1', '--company', 'Acme'], '--person-id names a person; use --company-id for a company'],
  ])('rejects recipient flags %j with a usage error before any tool call', async (flags, message) => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['invoice', 'create', ...flags, '--amount', '100', '--yes', '--json'],
        mockEnv(server, configDir),
      );

      expect(result.code).toBe(2);
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'usage', message: expect.stringContaining(message) },
      });
      expect(server.toolCalls).toHaveLength(0);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('keeps --client as a deprecated alias for --company', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['invoice', 'create', '--client', 'Brandon Chu', '--amount', '100', '--yes', '--json'],
        mockEnv(server, configDir, withClients([brandonClient])),
      );

      expect(result.code).toBe(0);
      const notes = result.stderr.split('\n').filter((line) => line.includes('deprecated'));
      expect(notes).toEqual(['Note: `--client` is deprecated; use `--company` (or `--person` for a Person).']);
      expect(server.toolCalls[0]).toEqual({ name: 'list_companies', arguments: { query: 'Brandon Chu' } });
      const command = callsNamed(server.toolCalls, 'create_invoice')[0].arguments.command as Record<string, unknown>;
      expect(command.party).toEqual({ kind: 'company', id: brandonClient.client_id });
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('hides the deprecated recipient flags from help', async () => {
    const help = await runCli(['invoice', 'create', '--help']);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--company-id <id>');
    expect(help.stdout).toContain('--person-id <id>');
    expect(help.stdout).not.toContain('--client');
  });

  it('keeps the write gate before create_invoice without --yes', async () => {
    const server = await createMockMcpServer();
    const configDir = await tempConfig();
    try {
      const result = await runCli(
        ['invoice', 'create', '--company', 'Brandon Chu', '--amount', '100', '--json'],
        mockEnv(server, configDir, withClients([brandonClient])),
      );

      expect(result.code).toBe(4);
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'permission' },
      });
      expect(callsNamed(server.toolCalls, 'list_companies')).toHaveLength(1);
      expect(callsNamed(server.toolCalls, 'create_invoice')).toHaveLength(0);
    } finally {
      await server.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

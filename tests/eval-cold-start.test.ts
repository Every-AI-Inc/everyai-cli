import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePartyPage } from '../src/commands/aliases';

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

const operationId = '00000000-0000-4000-8000-000000000099';
const person = {kind: 'person' as const, id: '00000000-0000-4000-8000-000000000001', name: 'Brandon Chu', avatar_url: 'https://example.test/avatar.png'};
const company = {...person, kind: 'company' as const};
const page = (items: unknown[], total = items.length, has_more = false) => ({items, total, has_more});
const baseArgs = ['invoice', 'create', '--amount', '100', '--operation-id', operationId, '--yes', '--json'];
function networkEnv(server: MockMcpServer, config: string, people = page([person]), companies = page([]), extra: NodeJS.ProcessEnv = {}) {
  return mockEnv(server, config, {EVERYAI_MOCK_PEOPLE: JSON.stringify(people), EVERYAI_MOCK_COMPANIES: JSON.stringify(companies), ...extra});
}

it('cold-start creates a Person invoice within three invocations, preserving operation and target on confirmation', async () => {
  const server = await createMockMcpServer(); const config = await tempConfig();
  try {
    const env = networkEnv(server, config, page([person]), page([]), {EVERYAI_MOCK_CONFIRMATION_GATE: '1'});
    const results = [];
    for (const args of [['docs'], ['whoami', '--json'], [...baseArgs, '--party', person.name]]) results.push(await runCli(args, env));
    expect(results).toHaveLength(3); expect(results.every(result => result.code === 0)).toBe(true);
    expect(parseJsonStdout(results[2].stdout)).toMatchObject({ok: true, data: {resolved_party: person, operation_id: operationId}});
    expect(server.toolCalls.map(call => call.name)).toEqual(['list_people', 'list_companies', 'create_invoice', 'create_invoice']);
    const command = {operation_id: operationId, party: {kind: 'person', id: person.id}, line_items: [{description: 'Services', quantity: 1, unit_price: 100}]};
    expect(server.toolCalls[2].arguments).toEqual({command});
    expect(server.toolCalls[3].arguments).toEqual({command, confirmation: 'create invoice'});
  } finally {await server.close(); await rm(config, {recursive: true, force: true});}
});

it('keeps same-name and same-UUID People/Companies distinct and preserves avatars in choices', async () => {
  const server = await createMockMcpServer(); const config = await tempConfig();
  try {
    const env = networkEnv(server, config, page([person]), page([company]));
    const result = await runCli([...baseArgs, '--party', person.name], env);
    expect(result.code).toBe(6); expect(parseJsonStdout(result.stdout)).toMatchObject({error: {candidates: [person, company]}});
    expect(server.toolCalls.map(call => call.name)).toEqual(['list_people', 'list_companies']);
    server.clearToolCalls();
    const selected = await runCli([...baseArgs, '--party-kind', 'company', '--party-id', company.id], env);
    expect(selected.code).toBe(0); expect(server.toolCalls).toHaveLength(1);
    expect(server.toolCalls[0].arguments).toMatchObject({command: {party: {kind: 'company', id: company.id}}});
  } finally {await server.close(); await rm(config, {recursive: true, force: true});}
});

it('queries secondary email through canonical People search without interpreting primary-only output', async () => {
  const server = await createMockMcpServer(); const config = await tempConfig();
  try {
    const result = await runCli([...baseArgs, '--party', 'secondary@example.test', '--party-kind', 'person'], networkEnv(server, config));
    expect(result.code).toBe(0); expect(server.toolCalls[0]).toEqual({name: 'list_people', arguments: {query: 'secondary@example.test', limit: 100, offset: 0}});
    expect(server.toolCalls).toHaveLength(2);
  } finally {await server.close(); await rm(config, {recursive: true, force: true});}
});

it('reads subsequent pages before inferring uniqueness and refuses truncated totals', async () => {
  const server = await createMockMcpServer(); const config = await tempConfig();
  try {
    for (const resultPage of [page([person], 2, false), page([], 1, true)]) {
      server.clearToolCalls();
      const result = await runCli([...baseArgs, '--party', 'Brandon'], networkEnv(server, config, resultPage));
      expect(result.code).toBe(6); expect(server.toolCalls.every(call => call.name.startsWith('list_'))).toBe(true);
    }
  } finally {await server.close(); await rm(config, {recursive: true, force: true});}
});

it.each([
  ['--party-id', person.id], ['--party-kind', 'client', '--party-id', person.id],
  ['--party-kind', 'person', '--party-id', person.id, '--party', 'Brandon'], [],
])('rejects mismatched typed flags %s without a tool call', async (...flags) => {
  const server = await createMockMcpServer(); const config = await tempConfig();
  try {
    const result = await runCli([...baseArgs, ...flags], networkEnv(server, config));
    expect(result.code).toBe(2); expect(server.toolCalls).toEqual([]);
  } finally {await server.close(); await rm(config, {recursive: true, force: true});}
});

it.each([['--read-only'], []])('gates writes before argument resolution %s', async (...flags) => {
  const server = await createMockMcpServer(); const config = await tempConfig();
  try {
    const result = await runCli([...baseArgs.filter(arg => arg !== '--yes'), '--party', 'Brandon', ...flags], networkEnv(server, config));
    expect(result.code).toBe(4); expect(server.toolCalls).toEqual([]);
  } finally {await server.close(); await rm(config, {recursive: true, force: true});}
});

it('rejects text/nested identities and wrong-kind rows as resolution evidence', () => {
  expect(() => parsePartyPage({structured_content: {result: '- Brandon [id: x]'}}, 'person')).toThrow();
  expect(() => parsePartyPage({structured_content: page([company])}, 'person')).toThrow();
  expect(parsePartyPage({structured_content: {...page([person]), other: {items: [company]}}}, 'person').items).toEqual([person]);
});

it('checks all subsequent pages before exposing ambiguous choices', async () => {
  const server = await createMockMcpServer(); const config = await tempConfig();
  const first = Array.from({length: 100}, (_, i) => ({...person, id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`}));
  try {
    const result = await runCli([...baseArgs, '--party', 'Brandon', '--party-kind', 'person'], mockEnv(server, config, {
      EVERYAI_MOCK_PEOPLE: JSON.stringify([page(first, 101, true), page([person], 101, false)]),
    }));
    expect(result.code).toBe(6);
    expect(server.toolCalls).toEqual([
      {name: 'list_people', arguments: {query: 'Brandon', limit: 100, offset: 0}},
      {name: 'list_people', arguments: {query: 'Brandon', limit: 100, offset: 100}},
    ]);
    expect((parseJsonStdout(result.stdout).error as {candidates: unknown[]}).candidates).toHaveLength(101);
  } finally {await server.close(); await rm(config, {recursive: true, force: true});}
});

it('a stale v1 catalog never triggers a legacy alias fallback, and --no-cache refreshes it', async () => {
  const {readdir} = await import('node:fs/promises');
  const server = await createMockMcpServer(); const config = await tempConfig();
  try {
    const env = networkEnv(server, config);
    expect((await runCli(['tools','list','--json'], env)).code).toBe(0);
    const cache = path.join(config, 'cache', (await readdir(path.join(config,'cache')))[0]);
    const oldTools = JSON.parse(readFileSync(path.join(repoRoot,'tests/fixtures/tools-alias-schemas-v1-historical.json'),'utf8'));
    const putCache = (age: number) => writeFileSync(cache, JSON.stringify({fetched_at: Date.now()-age, tools: oldTools}));
    putCache(0);
    expect((await runCli(['person','list','--json'], env)).code).toBe(6);
    expect(server.toolCalls).toEqual([]);
    expect((await runCli(['person','list','--no-cache','--json'], env)).code).toBe(0);
    expect(server.toolCalls.map(call=>call.name)).toEqual(['list_people']);
    server.clearToolCalls(); putCache(11*60*1000);
    expect((await runCli(['company','list','--json'], env)).code).toBe(0);
    expect(server.toolCalls.map(call=>call.name)).toEqual(['list_companies']);
  } finally {await server.close(); await rm(config, {recursive: true, force: true});}
});

it('passes a reviewed binding unchanged and never refreshes it on pending approval or later retry', async () => {
  const server = await createMockMcpServer(); const config = await tempConfig();
  const binding = {digest:'a'.repeat(64),to:'reviewed@example.com',cc:['z@example.com','a@example.com']};
  const file = path.join(config,'recipients.json'); writeFileSync(file,JSON.stringify(binding));
  const args = ['invoice','send',person.id,'--recipients',file,'--yes','--allow-destructive','--json'];
  try {
    const preview = await runCli(['invoice','preview-send',person.id,'--json'],mockEnv(server,config));
    expect(preview.code).toBe(0); expect(server.toolCalls).toEqual([{name:'preview_document_send',arguments:{document_kind:'invoice',document_id:person.id}}]);
    server.clearToolCalls();
    expect((await runCli(args,mockEnv(server,config,{EVERYAI_MOCK_DESTRUCTIVE_RESULT:'human_approval'}))).code).toBe(4);
    expect((await runCli(args,mockEnv(server,config))).code).toBe(0);
    expect(server.toolCalls).toEqual(Array(2).fill({name:'send_invoice',arguments:{invoice_id:person.id,recipients:binding}}));
    server.clearToolCalls(); writeFileSync(file,JSON.stringify({...binding, method_ids:['invented']}));
    expect((await runCli(args,mockEnv(server,config))).code).toBe(2); expect(server.toolCalls).toEqual([]);
  } finally {await server.close(); await rm(config,{recursive:true,force:true});}
});

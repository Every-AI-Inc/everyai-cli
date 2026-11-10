import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { argumentSummary } from '../src/commands/crm.js';
import { approvalsUrlForBaseUrl, PROD_BASE_URL, STAGING_BASE_URL } from '../src/lib/config.js';

// Short commands (company, person view/create, deal view/create/update,
// deal list sweep filters, deal outreach, approvals). Every write runs against
// the mock MCP fetch only.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');
const mockPreload = path.join(repoRoot, 'tests', 'helpers', 'mock-mcp-fetch.mjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APPROVALS_URL = 'https://app.every.ai/settings/approvals';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

type ToolCall = { name: string; arguments: Record<string, unknown> };

function runCli(args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 10_000): Promise<CliResult> {
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
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timeout); reject(err); });
    child.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

function parseJsonStdout(stdout: string): Record<string, any> {
  const trimmed = stdout.trim();
  expect(trimmed).not.toBe('');
  return JSON.parse(trimmed) as Record<string, any>;
}

interface Harness {
  run(args: string[], extra?: NodeJS.ProcessEnv): Promise<CliResult>;
  toolCalls(): ToolCall[];
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-short-'));
  const stateFile = path.join(dir, 'state.json');
  const configDir = path.join(dir, 'config');
  writeFileSync(stateFile, JSON.stringify({ listCalls: 0, openidCalls: 0, userinfoCalls: 0, toolCalls: [] }));
  const preload = `--import=${pathToFileURL(mockPreload).href}`;
  return {
    run: (args, extra = {}) => runCli(args, {
      EVERY_MCP_URL: 'https://mock-mcp.everyai.test',
      EVERY_CONFIG_DIR: configDir,
      EVERY_TOKEN: 'test-token',
      EVERYAI_FORCE_FILE_STORE: '1',
      EVERYAI_MOCK_MCP: '1',
      EVERYAI_MOCK_MCP_STATE: stateFile,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '),
      ...extra,
    }),
    toolCalls: () => (JSON.parse(readFileSync(stateFile, 'utf8')) as { toolCalls: ToolCall[] }).toolCalls,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

async function withHarness(test: (h: Harness) => Promise<void>): Promise<void> {
  const h = await harness();
  try {
    await test(h);
  } finally {
    await h.close();
  }
}

describe('short commands: argument mapping', () => {
  it.each<[string[], ToolCall[]]>([
    [['company', 'list', '--search', 'acme', '--limit', '3'],
      [{ name: 'list_companies', arguments: { query: 'acme', limit: 3 } }]],
    [['company', 'view', 'company_1'], [{ name: 'view_company', arguments: { company_id: 'company_1' } }]],
    [['person', 'view', 'person_1'], [{ name: 'view_person', arguments: { person_id: 'person_1' } }]],
    [['deal', 'view', 'deal_1'], [{ name: 'view_deal', arguments: { deal_id: 'deal_1' } }]],
    [['deal', 'view', 'deal_1', '--plan', '--auto-sends'],
      [{ name: 'view_deal', arguments: { deal_id: 'deal_1', include: ['plan', 'auto_sends'] } }]],
    [['deal', 'view', 'deal_1', '--plan', '--draft', '--auto-sends'],
      [{ name: 'view_deal', arguments: { deal_id: 'deal_1', include: ['plan', 'draft', 'auto_sends'] } }]],
    [['deal', 'list', '--attention', 'needs_reply,stale', '--attention', 'draft_ready', '--stale-days', '10',
      '--mine', '--since', '2026-11-01T00:00:00Z', '--sort', 'last_activity_at', '--limit', '5'],
    [{ name: 'list_deals', arguments: {
      attention: ['needs_reply', 'stale', 'draft_ready'], inactive_days: 10, owner: 'me',
      updated_since: '2026-11-01T00:00:00Z', sort: 'last_activity_at', limit: 5,
    } }]],
    [['deal', 'list', '--owner', 'pat@example.test', '--stage', 'lead'],
      [{ name: 'list_deals', arguments: { owner: 'pat@example.test', stage: 'lead' } }]],
    [['deal', 'update', 'deal_1', '--name', 'Q3 brand refresh', '--value', '1500', '--owner', 'me',
      '--goal', 'Brand work', '--company-id', 'company_1', '--add-member', 'user_1', '--add-member', 'user_2',
      '--remove-member', 'user_3', '--yes'],
    [{ name: 'update_deal', arguments: {
      deal_id: 'deal_1', name: 'Q3 brand refresh', value_estimate: 1500, owner: 'me', goal: { summary: 'Brand work' },
      party: { kind: 'company', id: 'company_1' }, members: { add: ['user_1', 'user_2'], remove: ['user_3'] },
    } }]],
    [['deal', 'update', 'deal_1', '--name', '', '--yes'], [{ name: 'update_deal', arguments: { deal_id: 'deal_1', name: '' } }]],
    [['deal', 'update', 'deal_1', '--value', '0', '--person-id', 'person_1', '--yes'],
      [{ name: 'update_deal', arguments: { deal_id: 'deal_1', value_estimate: 0, party: { kind: 'person', id: 'person_1' } } }]],
    [['deal', 'outreach', 'edit', 'deal_1', '--subject', 'Next steps', '--body', 'Hi Pat', '--recipient',
      'pat@example.test', '--thread', 'new', '--draft-version', 'dv1:old', '--yes'],
    [{ name: 'deal_outreach', arguments: {
      deal_id: 'deal_1', action: 'edit', subject: 'Next steps', body: 'Hi Pat', recipient: 'pat@example.test',
      thread_id: 'new', draft_version: 'dv1:old',
    } }]],
    [['deal', 'outreach', 'cancel', 'deal_1', '--send-id', 'send_1', '--yes'],
      [{ name: 'deal_outreach', arguments: { deal_id: 'deal_1', action: 'cancel', send_id: 'send_1' } }]],
    [['deal', 'outreach', 'send', 'deal_1', '--draft-version', 'dv1:given', '--yes', '--allow-destructive'],
      [{ name: 'deal_outreach', arguments: { deal_id: 'deal_1', action: 'send', draft_version: 'dv1:given' } }]],
  ])('maps %j', async (args, expected) => {
    await withHarness(async (h) => {
      const result = await h.run([...args, '--json']);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true, env: 'custom', schema_version: 1, data: { tool: expected[expected.length - 1].name, is_error: false },
      });
      expect(h.toolCalls()).toEqual(expected);
    });
  });

  it('creates a Company with a fresh operation_id and primary contact methods', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['company', 'create', '--name', 'Example Studio', '--email', 'hi@example.test',
        '--phone', '+1 555 0100', '--website', 'https://example.test', '--industry', 'Design',
        '--lead-source', 'Referral', '--notes', 'Met at a conference', '--yes', '--json']);
      expect(result.code, result.stdout).toBe(0);
      const [call] = h.toolCalls();
      expect(call.name).toBe('create_company');
      const command = call.arguments.command as Record<string, unknown>;
      expect(command.operation_id).toMatch(UUID);
      expect(command).toEqual({
        operation_id: command.operation_id,
        name: 'Example Studio',
        website: 'https://example.test',
        industry: 'Design',
        lead_source: 'Referral',
        notes: 'Met at a conference',
        methods: [
          { action: 'upsert', kind: 'email', display_value: 'hi@example.test', is_primary: true },
          { action: 'upsert', kind: 'phone', display_value: '+1 555 0100', is_primary: true },
        ],
      });
      expect(Object.keys(call.arguments)).toEqual(['command']);
    });
  });

  it('creates a Person with only the fields given', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['person', 'create', '--name', 'Pat Example', '--email', 'pat@example.test',
        '--job-title', 'Founder', '--company', 'Example Studio', '--yes', '--json']);
      expect(result.code, result.stdout).toBe(0);
      const [call] = h.toolCalls();
      expect(call.name).toBe('create_person');
      const command = call.arguments.command as Record<string, unknown>;
      expect(command).toEqual({
        operation_id: expect.stringMatching(UUID),
        name: 'Pat Example',
        job_title: 'Founder',
        company: 'Example Studio',
        methods: [{ action: 'upsert', kind: 'email', display_value: 'pat@example.test', is_primary: true }],
      });
    });
  });

  it('reuses one operation_id across the server text-confirmation retry', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['company', 'create', '--name', 'Example Studio', '--yes', '--json'],
        { EVERYAI_MOCK_FORCE_TEXT_CONFIRMATION_TOOL: 'create_company', EVERYAI_MOCK_EXPECTED_CONFIRMATION: 'create company' });
      expect(result.code, result.stdout).toBe(0);
      const calls = h.toolCalls();
      expect(calls).toHaveLength(2);
      expect(calls[1].arguments).toEqual({ ...calls[0].arguments, confirmation: 'create company' });
    });
  });

  it('creates a deal for an existing Person with the record name as target_name', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['deal', 'create', '--person-id', 'person_1', '--stage', 'Discovery booked',
        '--deal-name', 'Q3 brand refresh', '--value', '2500', '--owner', 'me', '--goal', 'A brand refresh', '--yes', '--json']);
      expect(result.code, result.stdout).toBe(0);
      expect(h.toolCalls()).toEqual([
        { name: 'view_person', arguments: { person_id: 'person_1' } },
        { name: 'create_deal', arguments: {
          target_name: 'Pat Example', party: { kind: 'person', id: 'person_1' }, stage: 'Discovery booked',
          name: 'Q3 brand refresh', value_estimate: 2500, owner: 'me', goal: { summary: 'A brand refresh' },
        } },
      ]);
    });
  });

  it('creates a deal for a new Person from --name and --email', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['deal', 'create', '--name', 'Sam New', '--email', 'sam@example.test', '--yes', '--json']);
      expect(result.code, result.stdout).toBe(0);
      expect(h.toolCalls()).toEqual([
        { name: 'create_deal', arguments: { target_name: 'Sam New', target_email: 'sam@example.test' } },
      ]);
    });
  });

  it('refuses a deal create without --yes before any read or write', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['deal', 'create', '--company-id', 'company_1', '--json']);
      expect(result.code).toBe(4);
      expect(parseJsonStdout(result.stdout)).toMatchObject({ ok: false, error: { code: 'permission' } });
      expect(h.toolCalls()).toEqual([]);
    });
  });

  it.each<[string[], string]>([
    [['deal', 'create', '--person-id', 'p1', '--company-id', 'c1', '--yes'], 'only one of --person-id or --company-id'],
    [['deal', 'create', '--person-id', 'p1', '--name', 'Pat', '--yes'], 'not both'],
    [['deal', 'create', '--yes'], '--person-id, --company-id, or --name'],
    [['deal', 'create', '--name', 'Pat', '--value', '-5', '--yes'], '--value'],
    [['deal', 'update', 'deal_1', '--yes'], 'Nothing to change'],
    [['deal', 'outreach', 'edit', 'deal_1', '--yes'], 'Nothing to change'],
    [['deal', 'outreach', 'edit', 'deal_1', '--body', 'a', '--body-file', 'b.txt', '--yes'], '--body or --body-file'],
    [['deal', 'list', '--attention', 'urgent'], '--attention'],
    [['deal', 'list', '--stale-days', '0'], '--stale-days'],
    [['deal', 'list', '--mine', '--owner', 'pat@example.test'], '--mine or --owner'],
    [['deal', 'list', '--since', 'yesterday'], '--since'],
    [['deal', 'list', '--sort', 'name'], '--sort'],
    [['company', 'create', '--name', ' ', '--yes'], '--name is required'],
  ])('returns usage exit 2 for %j', async (args, message) => {
    await withHarness(async (h) => {
      const result = await h.run([...args, '--json']);
      expect(result.code).toBe(2);
      const envelope = parseJsonStdout(result.stdout);
      expect(envelope).toMatchObject({ ok: false, error: { code: 'usage' } });
      expect(envelope.error.message).toContain(message);
      expect(h.toolCalls()).toEqual([]);
    });
  });

  it('reads the outreach body from --body-file', async () => {
    await withHarness(async (h) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-body-'));
      try {
        const file = path.join(dir, 'body.txt');
        writeFileSync(file, 'Hi Pat,\n\nA longer message.\n');
        const result = await h.run(['deal', 'outreach', 'edit', 'deal_1', '--body-file', file, '--yes', '--json']);
        expect(result.code, result.stdout).toBe(0);
        expect(h.toolCalls()).toEqual([{ name: 'deal_outreach', arguments: {
          deal_id: 'deal_1', action: 'edit', body: 'Hi Pat,\n\nA longer message.\n',
        } }]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('deal list output', () => {
  it('keeps the output of a call without the new flags unchanged', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['deal', 'list', '--stage', 'lead', '--limit', '2']);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`called list_deals\n${JSON.stringify({ received: { stage: 'lead', limit: 2 } }, null, 2)}\n`);
      expect(h.toolCalls()).toEqual([{ name: 'list_deals', arguments: { stage: 'lead', limit: 2 } }]);
    });
  });

  const sweepResult = {
    content: [{ type: 'text', text: '2 deals.' }],
    isError: false,
    structuredContent: {
      deals: [
        {
          id: 'deal_1', display_name: 'Pat Example', stage: 'lead', stage_label: 'Lead',
          last_activity_at: '2026-11-01T09:30:00Z',
          next_step: { id: 'step_1', kind: 'email', title: 'Send the follow-up', do_by: 'today' },
          attention: ['draft_ready', 'stale'],
        },
        { id: 'deal_2', name: 'Example Studio', stage: 'opportunity', stage_label: 'Opportunity', attention: ['stale'] },
      ],
      pagination: { total_matched: 7, returned_count: 2, offset: 0, limit: 2, has_more: true, next_offset: 2 },
    },
  };

  it('prints a table with last activity and next step for the sweep filters', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['deal', 'list', '--attention', 'stale', '--limit', '2'],
        { EVERYAI_MOCK_TOOL_RESULTS: JSON.stringify({ list_deals: sweepResult }) });
      expect(result.code).toBe(0);
      const lines = result.stdout.split('\n');
      expect(lines[0]).toMatch(/^id\s+deal\s+stage\s+last activity\s+next step\s+attention$/);
      expect(lines[2]).toMatch(/^deal_1\s+Pat Example\s+Lead\s+2026-11-01 09:30\s+Send the follow-up \(today\)\s+draft_ready, stale$/);
      expect(lines[3]).toMatch(/^deal_2\s+Example Studio\s+Opportunity\s+stale$/);
      expect(result.stdout).toContain('Showing 2 of 7 deals. Raise --limit to see more.');
    });
  });

  it('leaves out the columns that an older server does not return', async () => {
    await withHarness(async (h) => {
      const older = { ...sweepResult, structuredContent: { deals: [{ id: 'deal_2', name: 'Example Studio', stage: 'lead' }] } };
      const result = await h.run(['deal', 'list', '--mine'], { EVERYAI_MOCK_TOOL_RESULTS: JSON.stringify({ list_deals: older }) });
      expect(result.code).toBe(0);
      expect(result.stdout.split('\n')[0]).toMatch(/^id\s+deal\s+stage$/);
    });
  });

  it('keeps the raw tool result in the --json envelope', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['deal', 'list', '--attention', 'stale', '--json'],
        { EVERYAI_MOCK_TOOL_RESULTS: JSON.stringify({ list_deals: sweepResult }) });
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true, data: { tool: 'list_deals', structured_content: { deals: [{ id: 'deal_1' }, { id: 'deal_2' }] } },
      });
    });
  });
});

describe('company list output', () => {
  it('prints a table of Companies', async () => {
    await withHarness(async (h) => {
      const list = {
        content: [{ type: 'text', text: '1 Company.' }],
        isError: false,
        structuredContent: {
          items: [{ id: 'company_1', name: 'Example Studio', industry: 'Design', email: null, website: 'https://example.test' }],
          total: 4,
          has_more: true,
        },
      };
      const result = await h.run(['company', 'list', '--limit', '1'], { EVERYAI_MOCK_TOOL_RESULTS: JSON.stringify({ list_companies: list }) });
      expect(result.code).toBe(0);
      const lines = result.stdout.split('\n');
      expect(lines[0]).toMatch(/^id\s+name\s+industry\s+email\s+website$/);
      expect(lines[2]).toMatch(/^company_1\s+Example Studio\s+Design\s+https:\/\/example\.test$/);
      expect(result.stdout).toContain('Showing 1 of 4 Companies.');
    });
  });
});

describe('deal outreach safety tiers', () => {
  it('runs edit and cancel with --yes alone (ordinary writes)', async () => {
    await withHarness(async (h) => {
      const edit = await h.run(['deal', 'outreach', 'edit', 'deal_1', '--body', 'Hi', '--yes', '--json']);
      expect(edit.code, edit.stdout).toBe(0);
      const cancel = await h.run(['deal', 'outreach', 'cancel', 'deal_1', '--send-id', 'send_1', '--yes', '--json']);
      expect(cancel.code, cancel.stdout).toBe(0);
      expect(h.toolCalls().map((call) => call.arguments.action)).toEqual(['edit', 'cancel']);
    });
  });

  it('refuses edit without --yes when there is no TTY', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['deal', 'outreach', 'edit', 'deal_1', '--body', 'Hi', '--json']);
      expect(result.code).toBe(4);
      expect(parseJsonStdout(result.stdout).error.message).toContain('--yes');
      expect(h.toolCalls()).toEqual([]);
    });
  });

  it('refuses send without --allow-destructive when there is no TTY, before any read', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['deal', 'outreach', 'send', 'deal_1', '--yes', '--json']);
      expect(result.code).toBe(4);
      const envelope = parseJsonStdout(result.stdout);
      expect(envelope).toMatchObject({ ok: false, error: { code: 'permission' } });
      expect(envelope.error.message).toContain('--allow-destructive');
      expect(h.toolCalls()).toEqual([]);
    });
  });

  it('keeps every tool call deal_outreach destructive for every action', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['tool', 'call', 'deal_outreach', '--arg', 'deal_id=deal_1', '--arg', 'action=edit',
        '--arg', 'body=Hi', '--yes', '--json']);
      expect(result.code).toBe(4);
      expect(parseJsonStdout(result.stdout).error.message).toContain('--allow-destructive');
      expect(h.toolCalls()).toEqual([]);
    });
  });

  it('says in policy explain that the short commands gate by action', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['policy', 'explain', 'deal_outreach', '--json']);
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true,
        data: { level: 'destructive', short_commands: expect.stringContaining('gate by action') },
      });
      const other = await h.run(['policy', 'explain', 'update_deal', '--json']);
      expect(parseJsonStdout(other.stdout).data.short_commands).toBeUndefined();
    });
  });
});

describe('deal outreach send', () => {
  it('previews the draft and sends the draft_version it read', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['deal', 'outreach', 'send', 'deal_1', '--yes', '--allow-destructive', '--json']);
      expect(result.code, result.stdout).toBe(0);
      expect(h.toolCalls()).toEqual([
        { name: 'view_deal', arguments: { deal_id: 'deal_1', include: ['draft'] } },
        { name: 'deal_outreach', arguments: { deal_id: 'deal_1', action: 'send', draft_version: 'dv1:mock-version' } },
      ]);
      expect(result.stderr).toContain('Channel: email\nTo: pat@example.test\nSubject: Following up\nDraft version: dv1:mock-version\n\nHi Pat,\nChecking in on the proposal.\n');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true,
        data: { tool: 'deal_outreach', preview: { channel: 'email', to: 'pat@example.test', draft_version: 'dv1:mock-version' } },
      });
    });
  });

  it('stops when the deal has no unsent draft', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['deal', 'outreach', 'send', 'deal_1', '--yes', '--allow-destructive', '--json'],
        { EVERYAI_MOCK_NO_DRAFT: '1' });
      expect(result.code).toBe(6);
      expect(parseJsonStdout(result.stdout)).toMatchObject({ ok: false, error: { code: 'draft_not_found' } });
      expect(h.toolCalls()).toEqual([{ name: 'view_deal', arguments: { deal_id: 'deal_1', include: ['draft'] } }]);
    });
  });

  it('reports a held send with exit 4 and the Approvals link', async () => {
    await withHarness(async (h) => {
      const env = { EVERYAI_MOCK_DESTRUCTIVE_RESULT: 'human_approval' };
      const result = await h.run(['deal', 'outreach', 'send', 'deal_1', '--draft-version', 'dv1:given',
        '--yes', '--allow-destructive', '--json'], env);
      expect(result.code).toBe(4);
      const envelope = parseJsonStdout(result.stdout);
      expect(envelope).toMatchObject({
        ok: false,
        error: {
          code: 'permission',
          approvals_url: APPROVALS_URL,
          mcp_gate: { type: 'human_approval', status: 'pending', request_id: 'request-123' },
        },
      });
      expect(envelope.error.message).toContain(`Approve in Every: Settings > Approvals ${APPROVALS_URL}`);
      expect(envelope.error.message).toContain('Approval status: pending.');
      expect(h.toolCalls()).toHaveLength(1);

      const human = await h.run(['deal', 'outreach', 'send', 'deal_1', '--draft-version', 'dv1:given',
        '--yes', '--allow-destructive'], env);
      expect(human.code).toBe(4);
      expect(human.stderr).toContain(`Approve in Every: Settings > Approvals ${APPROVALS_URL}`);
      expect(human.stderr).toContain('run the same command again');
    });
  });
});

describe('every approvals', () => {
  it('shows the pending and approved requests of this connection by default', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['approvals', '--json']);
      expect(result.code).toBe(0);
      const data = parseJsonStdout(result.stdout).data;
      expect(data).toMatchObject({
        available: true, window_hours: 24, filter: 'pending_or_approved_this_connection',
        total: 4, hidden: 2, approvals_url: APPROVALS_URL,
      });
      expect(data.requests.map((request: { request_id: string }) => request.request_id)).toEqual(['req-pending', 'req-approved']);
      expect(h.toolCalls()).toEqual([{ name: 'get_workspace_priorities', arguments: {} }]);
    });
  });

  it('prints a table and marks the rows of another connection with --all', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['approvals', '--all']);
      expect(result.code).toBe(0);
      const lines = result.stdout.split('\n');
      expect(lines[0]).toMatch(/^status\s+tool\s+arguments\s+connection\s+created\s+expires$/);
      expect(lines[2]).toMatch(/^pending\s+deal_outreach\s+action=send deal_id=deal_1\s+Every CLI\s+2026-11-10 15:00\s+2026-11-11 15:00$/);
      expect(result.stdout).toMatch(/pending\s+deal_outreach\s+action=send deal_id=deal_3\s+Claude \(other connection\)/);
      expect(result.stdout).toMatch(/denied\s+delete_records\s+records=1/);
      expect(result.stdout).not.toContain('Private message text');
      expect(result.stdout).toContain(`Approve in Every: Settings > Approvals ${APPROVALS_URL}`);
    });
  });

  it('says how many rows the default view hides', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['approvals']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('2 more request(s) are hidden. Run every approvals --all to show every row.');
      expect(result.stdout).not.toContain('Claude');
    });
  });

  it('treats rows without this_connection (older server) as this connection', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['approvals', '--json'], { EVERYAI_MOCK_PRIORITIES: 'no_connection_field' });
      expect(result.code).toBe(0);
      const ids = parseJsonStdout(result.stdout).data.requests.map((request: { request_id: string }) => request.request_id);
      expect(ids).toEqual(['req-pending', 'req-approved', 'req-other']);
    });
  });

  it.each<[string, string, string]>([
    ['no_block', 'unsupported', 'does not report approval requests yet'],
    ['unavailable', 'unavailable', 'temporarily unavailable'],
  ])('exits 0 with a clear message when the server block is %s', async (variant, reason, message) => {
    await withHarness(async (h) => {
      const json = await h.run(['approvals', '--json'], { EVERYAI_MOCK_PRIORITIES: variant });
      expect(json.code).toBe(0);
      expect(parseJsonStdout(json.stdout)).toMatchObject({
        ok: true, data: { available: false, reason, requests: [], approvals_url: APPROVALS_URL },
      });
      const human = await h.run(['approvals'], { EVERYAI_MOCK_PRIORITIES: variant });
      expect(human.code).toBe(0);
      expect(human.stdout).toContain(message);
      expect(human.stdout).toContain(`Approve in Every: Settings > Approvals ${APPROVALS_URL}`);
    });
  });

  it('runs in read-only mode', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['approvals', '--read-only', '--json']);
      expect(result.code).toBe(0);
    });
  });

  it('summarizes only ids and the action', () => {
    expect(argumentSummary({ deal_id: 'd1', action: 'send', body: 'secret', draft_version: 'dv1:x' })).toBe('action=send deal_id=d1');
    expect(argumentSummary({ note: 'text only' })).toBe('1 argument(s)');
    expect(argumentSummary(undefined)).toBe('');
  });

  it('links the approvals page of the target environment', () => {
    expect(approvalsUrlForBaseUrl(PROD_BASE_URL)).toBe(APPROVALS_URL);
    expect(approvalsUrlForBaseUrl(STAGING_BASE_URL)).toBe('https://app.staging.every.ai/settings/approvals');
  });
});

describe('offline docs', () => {
  it('lists the short commands', async () => {
    const result = await runCli(['docs', '--json'], { EVERY_TOKEN: '' });
    const commands = parseJsonStdout(result.stdout).data.commands as string;
    for (const line of [
      'every company list --search <q> --limit <n>',
      'every company view <company_id>',
      'every company create --name <name>',
      'every person view <person_id>',
      'every person create --name <name>',
      'every deal view <deal_id> --plan --draft --auto-sends',
      'every deal create --person-id <id> --company-id <id>',
      'every deal update <deal_id> --name <name>',
      'every deal list --stage <s> --search <q> --limit <n> --attention <reason> --stale-days <n> --owner <owner> --mine --since <time> --sort <field>',
      'every deal outreach edit <deal_id> --subject <text>',
      'every deal outreach send <deal_id> --draft-version <v>',
      'every deal outreach cancel <deal_id> --send-id <id>',
      'every approvals --all',
    ]) {
      expect(commands).toContain(line);
    }
  });
});

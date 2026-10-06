import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoiceSendCommand, proposalSendCommand, recipientsGetCommand, recipientsSetCommand } from '../src/commands/aliases.js';
import { recipientLines } from '../src/lib/recipients.js';

const mocks = vi.hoisted(() => ({ call: vi.fn(), confirm: vi.fn() }));
vi.mock('../src/lib/mcp.js', () => ({
  callTool: mocks.call,
  listTools: async () => ['preview_document_send', 'send_invoice', 'send_proposal',
    'get_recipient_defaults', 'set_recipient_defaults', 'list_people', 'list_companies'].map((name) => ({
    name, annotations: { readOnlyHint: /^(preview|get|list)_/.test(name) },
  })),
}));
vi.mock('../src/lib/auth/tokens.js', () => ({ getToken: async () => 'mock-token' }));
vi.mock('../src/lib/auth/api-key.js', () => ({ activeCredentialIsApiKey: () => true }));
vi.mock('../src/lib/hints.js', () => ({ maybeShowSkillHint: async () => {} }));
vi.mock('../src/lib/policy.js', async (original) => ({
  ...await original<typeof import('../src/lib/policy.js')>(), promptForTool: mocks.confirm,
}));

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/recipient-envelopes.json', import.meta.url), 'utf8'));
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stderrTty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
let stderr: string;

beforeEach(() => {
  mocks.call.mockReset();
  mocks.confirm.mockReset().mockResolvedValue(true);
  stderr = '';
  vi.stubEnv('EVERY_READ_ONLY', '');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => { stderr += text; return true; });
  mocks.call.mockImplementation(async (_url, _token, name) => ({
    isError: false, content: [], structuredContent: name === 'preview_document_send'
      ? fixtures.preview : name === 'get_recipient_defaults' || name === 'set_recipient_defaults'
        ? fixtures.defaults : { items: [] },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
  else delete process.stdin.isTTY;
  if (stderrTty) Object.defineProperty(process.stderr, 'isTTY', stderrTty);
  else delete process.stderr.isTTY;
});

describe('recipient approval boundaries with a mocked MCP transport', () => {
  it.each([
    ['invoice', invoiceSendCommand], ['proposal', proposalSendCommand],
  ] as const)('shows the %s envelope before a yes/no prompt and sends that same object', async (kind, send) => {
    const binding = Object.freeze({ ...fixtures.preview.recipients, cc: Object.freeze([...fixtures.preview.recipients.cc]) });
    mocks.call.mockImplementation(async (_url, _token, name, args) => {
      if (name === 'preview_document_send') return { content: [], isError: false,
        structuredContent: { ...fixtures.preview, recipients: binding } };
      expect(mocks.confirm).toHaveBeenCalledOnce();
      expect(args.recipients).toBe(binding);
      return { content: [], isError: false };
    });
    mocks.confirm.mockImplementation(async (tool, level, prompt) => {
      expect(tool).toBe(`send_${kind}`);
      expect(level).toBe('destructive');
      expect(prompt).toBe('confirm');
      expect(stderr).toContain('To: Alex To <To.Exact@example.test>');
      expect(stderr).toContain('CC: Blair Second <second@example.test>');
      expect(stderr).toContain('CC: Casey First <first@example.test>');
      expect(mocks.call).toHaveBeenCalledOnce();
      return true;
    });
    await send('doc-id', { json: true });
    expect(mocks.call.mock.calls.map((call) => call[2])).toEqual(['preview_document_send', `send_${kind}`]);
  });

  it('stops after preview when the user rejects confirmation', async () => {
    mocks.confirm.mockResolvedValue(false);
    await expect(invoiceSendCommand('doc-id')).rejects.toMatchObject({ code: 'permission', exitCode: 4 });
    expect(mocks.call.mock.calls.map((call) => call[2])).toEqual(['preview_document_send']);
  });

  it('does not use extra or inconsistent display details as transport recipients', () => {
    const preview = { ...fixtures.preview, recipient_details: {
      to: { address: 'wrong@example.test', owner_name: 'Wrong' },
      cc: [{ address: 'extra@example.test', owner_name: 'Extra' }, ...fixtures.preview.recipient_details.cc].reverse(),
    } };
    expect(recipientLines(preview)).toBe('To: Name unavailable <To.Exact@example.test>\nCC: Blair Second <second@example.test>\nCC: Casey First <first@example.test>');
  });

  it('requires an explicit kind before a read or write', async () => {
    await expect(recipientsGetCommand('Alex')).rejects.toMatchObject({ code: 'usage', exitCode: 2 });
    await expect(recipientsSetCommand('Alex', { kind: 'other', to: 'To.Exact@example.test' }))
      .rejects.toMatchObject({ code: 'usage', exitCode: 2 });
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it('resolves a Person name without a Company match', async () => {
    mocks.call.mockImplementation(async (_url, _token, name) => ({ content: [], isError: false,
      structuredContent: name === 'list_people' ? { items: [{ id: 'person-id', name: 'Alex' }] }
        : name === 'list_companies' ? { items: [] } : fixtures.defaults,
    }));
    await recipientsGetCommand('Alex', { kind: 'proposal', json: true });
    expect(mocks.call.mock.calls.at(-1)?.[3]).toEqual({ party_kind: 'person', party_id: 'person-id',
      document_kind: 'proposal', kind: 'proposal' });
  });

  it('refuses ambiguity across Person and Company namespaces before a write', async () => {
    mocks.call.mockResolvedValue({ content: [], isError: false, structuredContent: {
      items: [{ id: 'same-id', name: 'Alex' }],
    } });
    await expect(recipientsSetCommand('Alex', { kind: 'invoice', to: 'To.Exact@example.test', yes: true }))
      .rejects.toMatchObject({ code: 'not_found', details: { candidates: [
        { kind: 'company', client_id: 'same-id' }, { kind: 'person', client_id: 'same-id' },
      ] } });
    expect(mocks.call.mock.calls.map((call) => call[2])).toEqual(['list_companies', 'list_people']);
  });

  it('refuses an ambiguous mailbox and requires its method ID', async () => {
    mocks.call.mockResolvedValue({ content: [], isError: false, structuredContent: {
      ...fixtures.defaults, eligible_methods: [...fixtures.defaults.eligible_methods,
        { ...fixtures.defaults.eligible_methods[0], id: 'other-method-id' }],
    } });
    await expect(recipientsSetCommand('Alex', { personId: 'person-id', kind: 'invoice',
      to: 'To.Exact@example.test', yes: true })).rejects.toMatchObject({ code: 'usage',
      message: expect.stringContaining('Use a method ID') });
    expect(mocks.call.mock.calls.map((call) => call[2])).toEqual(['get_recipient_defaults']);
  });

  it('shows proposed recipients before the write-tier prompt', async () => {
    mocks.confirm.mockImplementation(async (_name, level, prompt) => {
      expect(level).toBe('write');
      expect(prompt).toBe('confirm');
      expect(stderr).toContain('To: Casey First <first@example.test>\nCC: none');
      return false;
    });
    await expect(recipientsSetCommand('Acme', { companyId: 'company-id', kind: 'proposal',
      to: 'first@example.test', clearCc: true })).rejects.toMatchObject({ code: 'permission' });
    expect(mocks.call.mock.calls.map((call) => call[2])).toEqual(['get_recipient_defaults']);
  });
});

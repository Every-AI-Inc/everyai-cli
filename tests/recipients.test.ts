import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoiceSendCommand, proposalSendCommand, recipientsGetCommand, recipientsSetCommand } from '../src/commands/aliases.js';
import { recipientLines } from '../src/lib/recipients.js';
import { toolCallCommand } from '../src/commands/tools.js';

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
  mocks.call.mockImplementation(async (_url, _token, name, args) => ({
    isError: false, content: [], structuredContent: name === 'preview_document_send'
      ? { ...fixtures.preview, document_kind: args.document_kind, document_id: args.document_id } : name === 'get_recipient_defaults' || name === 'set_recipient_defaults'
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
  it.each(['send_invoice', 'send_proposal'])('displays a direct %s binding before typed confirmation', async (name) => {
    const binding = fixtures.preview.recipients;
    mocks.confirm.mockImplementation(async (tool, level, prompt) => {
      expect(tool).toBe(name);
      expect(level).toBe('destructive');
      expect(prompt).toBe('typed');
      expect(stderr).toContain('To: Name unavailable <To.Exact@example.test>');
      expect(stderr).toContain('CC: Name unavailable <second@example.test>\nCC: Name unavailable <first@example.test>');
      expect(mocks.call).not.toHaveBeenCalled();
      return false;
    });
    await expect(toolCallCommand(name, { arg: [`recipients=${JSON.stringify(binding)}`] }))
      .rejects.toMatchObject({ code: 'permission' });
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it.each([
    undefined, {}, { ...fixtures.preview.recipients, cc: 'not-an-array' },
    { ...fixtures.preview.recipients, digest: 'not-a-digest' },
    { ...fixtures.preview.recipients, injected: 'extra' },
  ])('refuses missing or malformed direct bindings locally: %s', async (binding) => {
    await expect(toolCallCommand('send_invoice', { arg: binding ? [`recipients=${JSON.stringify(binding)}`] : [],
      yes: true, allowDestructive: true })).rejects.toMatchObject({ code: 'usage', exitCode: 2 });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it.each([
    ['invoice', invoiceSendCommand], ['proposal', proposalSendCommand],
  ] as const)('shows the %s envelope before a yes/no prompt and sends that same object', async (kind, send) => {
    const binding = Object.freeze({ ...fixtures.preview.recipients, cc: Object.freeze([...fixtures.preview.recipients.cc]) });
    mocks.call.mockImplementation(async (_url, _token, name, args) => {
      if (name === 'preview_document_send') return { content: [], isError: false,
        structuredContent: { ...fixtures.preview, document_kind: kind, document_id: 'doc-id', recipients: binding } };
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

  it('rejects a mismatched approved digest before interactive confirmation', async () => {
    await expect(proposalSendCommand('doc-id', { expectDigest: 'b'.repeat(64) }))
      .rejects.toMatchObject({ code: 'send_preparation_stale', message: expect.stringContaining('get approval') });
    expect(stderr).toContain('To: Alex To <To.Exact@example.test>');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.call.mock.calls.map((call) => call[2])).toEqual(['preview_document_send']);
  });

  it('rejects a malformed expected digest before any server call', async () => {
    await expect(invoiceSendCommand('doc-id', { expectDigest: 'a typo' }))
      .rejects.toMatchObject({ code: 'usage', exitCode: 2 });
    expect(mocks.call).not.toHaveBeenCalled();
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

  it('shows proposed recipients before the destructive prompt', async () => {
    mocks.confirm.mockImplementation(async (_name, level, prompt) => {
      expect(level).toBe('destructive');
      expect(prompt).toBe('typed');
      expect(stderr).toContain('To: Casey First <first@example.test>\nCC: none');
      return false;
    });
    await expect(recipientsSetCommand('Acme', { companyId: 'company-id', kind: 'proposal',
      to: 'first@example.test', clearCc: true })).rejects.toMatchObject({ code: 'permission' });
    expect(mocks.call.mock.calls.map((call) => call[2])).toEqual(['get_recipient_defaults']);
  });

  it.each([undefined, null, 'unavailable', [null], [1], ['not-a-method-id']])('refuses incomplete exclusion data: %s', async (noneIds) => {
    mocks.call.mockResolvedValue({ content: [], isError: false,
      structuredContent: { ...fixtures.defaults, none_method_ids: noneIds } });
    await expect(recipientsSetCommand('Acme', { companyId: 'company-id', kind: 'invoice',
      to: 'To.Exact@example.test', yes: true, allowDestructive: true }))
      .rejects.toMatchObject({ code: 'recipient_exclusions_unavailable' });
    expect(mocks.call.mock.calls.map((call) => call[2])).toEqual(['get_recipient_defaults']);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('allows the v2 contract when the current exclusion list is empty', async () => {
    mocks.call.mockResolvedValue({ content: [], isError: false,
      structuredContent: { ...fixtures.defaults, model_state: 'v2', none_method_ids: [] } });
    await recipientsSetCommand('Acme', { companyId: 'company-id', kind: 'invoice',
      to: 'To.Exact@example.test', yes: true, allowDestructive: true });
    expect(mocks.call.mock.calls.at(-1)?.[3].command.none_method_ids).toEqual([]);
  });

  it('does not remove an exclusion to accommodate a requested To', async () => {
    await expect(recipientsSetCommand('Acme', { companyId: 'company-id', kind: 'invoice',
      to: 'excluded@example.test', yes: true, allowDestructive: true }))
      .rejects.toMatchObject({ code: 'usage', message: expect.stringContaining('preserves exclusions') });
    expect(mocks.call.mock.calls.map((call) => call[2])).toEqual(['get_recipient_defaults']);
  });

  it('carries the exclusion array unchanged in the full command', async () => {
    const exclusions = Object.freeze([fixtures.defaults.none_method_ids[0], '00000000-0000-4000-8000-000000000009']);
    mocks.call.mockImplementation(async (_url, _token, name, args) => {
      if (name === 'set_recipient_defaults') expect(args.command.none_method_ids).toBe(exclusions);
      return { content: [], isError: false, structuredContent: { ...fixtures.defaults, none_method_ids: exclusions } };
    });
    await recipientsSetCommand('Acme', { companyId: 'company-id', kind: 'invoice',
      to: 'To.Exact@example.test', clearCc: true, yes: true, allowDestructive: true });
    expect(mocks.call.mock.calls.map((call) => call[2])).toEqual(['get_recipient_defaults', 'set_recipient_defaults']);
  });
});

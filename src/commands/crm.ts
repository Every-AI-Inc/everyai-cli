import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { approvalsUrlForBaseUrl, resolveBaseUrl } from '../lib/config.js';
import { CliError } from '../lib/errors.js';
import { ExitCode } from '../lib/exit-codes.js';
import { emit } from '../lib/output.js';
import { record } from '../lib/recipients.js';
import { renderTable, shortTime, TableColumn } from '../lib/table.js';
import { addLimit, nonEmpty } from './aliases.js';
import {
  executeToolCall,
  invokeToolCall,
  ToolCallData,
  toolCallHuman,
  ToolExecutionOptions,
} from './tools.js';

// Short commands for People, Companies, Deals, deal outreach and approvals
// (2026-11). Each one calls one admin MCP tool with the tool's real parameter
// names. `every tool call <tool>` stays valid for every tool.

export interface CompanyListOptions extends ToolExecutionOptions {
  search?: string;
  limit?: string;
}

interface ContactFields {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  industry?: string;
}

export interface CompanyCreateOptions extends ToolExecutionOptions, ContactFields {
  website?: string;
  leadSource?: string;
}

export interface PersonCreateOptions extends ToolExecutionOptions, ContactFields {
  jobTitle?: string;
  company?: string;
  location?: string;
  headline?: string;
}

export interface DealViewOptions extends ToolExecutionOptions {
  plan?: boolean;
  draft?: boolean;
  autoSends?: boolean;
}

interface DealFieldOptions {
  value?: string;
  owner?: string;
  goal?: string;
  personId?: string;
  companyId?: string;
}

export interface DealCreateOptions extends ToolExecutionOptions, DealFieldOptions {
  /** A new Person's name (target_name). */
  name?: string;
  /** A new Person's email (target_email). */
  email?: string;
  stage?: string;
  dealName?: string;
}

export interface DealUpdateOptions extends ToolExecutionOptions, DealFieldOptions {
  /** The deal name. An empty string resets it to the default name. */
  name?: string;
  addMember?: string[];
  removeMember?: string[];
}

export interface OutreachEditOptions extends ToolExecutionOptions {
  subject?: string;
  body?: string;
  bodyFile?: string;
  recipient?: string;
  thread?: string;
  draftVersion?: string;
}

export interface OutreachSendOptions extends ToolExecutionOptions {
  draftVersion?: string;
}

export interface OutreachCancelOptions extends ToolExecutionOptions {
  sendId?: string;
}

export interface ApprovalsOptions extends ToolExecutionOptions {
  all?: boolean;
}

function usage(message: string): CliError {
  return new CliError(message, ExitCode.USAGE, 'usage');
}

function requireId(value: string, label: string): string {
  const id = value.trim();
  if (!id) throw usage(`${label} is required`);
  return id;
}

/** Copy each flag that has a value to the tool argument of the same meaning. */
function scalarFields(source: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [option, argument] of Object.entries(mapping)) {
    const value = source[option];
    if (typeof value === 'string' && value.trim()) fields[argument] = value.trim();
  }
  return fields;
}

/** Email and phone go in as primary contact methods (create_person/create_company `methods`). */
function contactMethods(opts: ContactFields): Record<string, unknown>[] | undefined {
  const methods: Record<string, unknown>[] = [];
  for (const kind of ['email', 'phone'] as const) {
    const value = nonEmpty(opts[kind]);
    if (value) methods.push({ action: 'upsert', kind, display_value: value, is_primary: true });
  }
  return methods.length ? methods : undefined;
}

function requiredName(value: string | undefined): string {
  const name = nonEmpty(value);
  if (!name) throw usage('--name is required');
  return name;
}

function parseValue(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
    throw usage('--value must be a number, 0 or more');
  }
  return parsed;
}

type PartyKind = 'person' | 'company';

interface Party {
  kind: PartyKind;
  id: string;
}

function partyFromIds(opts: DealFieldOptions): Party | undefined {
  const personId = nonEmpty(opts.personId);
  const companyId = nonEmpty(opts.companyId);
  if (personId && companyId) throw usage('Use only one of --person-id or --company-id');
  if (personId) return { kind: 'person', id: personId };
  if (companyId) return { kind: 'company', id: companyId };
  return undefined;
}

function ownerValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const owner = nonEmpty(value);
  if (!owner) throw usage('--owner must be me, a teammate\'s email, or a user id');
  return owner;
}

function goalValue(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const summary = nonEmpty(value);
  if (!summary) throw usage('--goal must describe what the deal sells');
  return { summary };
}

function memberList(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const members = Array.from(new Set(values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)));
  return members.length ? members : undefined;
}

/** The approvals page for the environment this call targets. */
function approvalsUrl(opts: ToolExecutionOptions): string {
  return approvalsUrlForBaseUrl(resolveBaseUrl({ staging: opts.staging }));
}

/**
 * A request that waits for a person's approval stays a permission result
 * (exit 4, `error.mcp_gate`). This adds where to approve it and what to do next.
 */
async function withApprovalLink(opts: ToolExecutionOptions, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    const gate = err instanceof CliError ? record(err.details?.mcp_gate) : {};
    if (!(err instanceof CliError) || gate.type !== 'human_approval') throw err;
    const url = approvalsUrl(opts);
    const status = typeof gate.status === 'string' ? gate.status : 'pending';
    throw new CliError([
      err.message,
      `Approval status: ${status}.`,
      `Approve in Every: Settings > Approvals ${url}`,
      'After the approval, run the same command again. `every approvals` lists the requests.',
    ].join('\n'), err.exitCode, err.code, { ...err.details, approvals_url: url });
  }
}

// ── Companies ───────────────────────────────────────────────────────────────

export function companyTableHuman(data: ToolCallData): string {
  const structured = record(data.structured_content);
  if (!Array.isArray(structured.items)) return toolCallHuman(data);
  const items = structured.items.map(record);
  if (items.length === 0) return 'No Companies found.';
  const columns: TableColumn[] = [
    { header: 'id', max: 36 },
    { header: 'name', max: 40 },
    { header: 'industry', max: 24 },
    { header: 'email', max: 32 },
    { header: 'website' },
  ];
  const rows = items.map((item) => [item.id, item.name, item.industry, item.email, item.website]
    .map((value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))));
  const lines = [renderTable(columns, rows)];
  if (structured.has_more === true) {
    const total = typeof structured.total === 'number' ? ` of ${structured.total}` : '';
    lines.push('', `Showing ${items.length}${total} Companies. Raise --limit (up to 100) or narrow --search to see more.`);
  }
  return lines.join('\n');
}

export async function companyListCommand(opts: CompanyListOptions = {}): Promise<void> {
  const args: Record<string, unknown> = {};
  if (opts.search !== undefined) args.query = opts.search;
  addLimit(args, opts.limit);
  await executeToolCall('list_companies', opts, async () => args, undefined, undefined, companyTableHuman);
}

export async function companyViewCommand(companyId: string, opts: ToolExecutionOptions = {}): Promise<void> {
  const id = requireId(companyId, '<company_id>');
  await executeToolCall('view_company', opts, async () => ({ company_id: id }));
}

export async function companyCreateCommand(opts: CompanyCreateOptions = {}): Promise<void> {
  const name = requiredName(opts.name);
  const methods = contactMethods(opts);
  // One operation_id per invocation, so the one confirmation retry reuses it.
  const command: Record<string, unknown> = {
    operation_id: randomUUID(),
    name,
    ...scalarFields(opts as Record<string, unknown>, {
      website: 'website', industry: 'industry', address: 'address', notes: 'notes', leadSource: 'lead_source',
    }),
    ...(methods ? { methods } : {}),
  };
  await executeToolCall('create_company', opts, async () => ({ command }));
}

// ── People ──────────────────────────────────────────────────────────────────

export async function personViewCommand(personId: string, opts: ToolExecutionOptions = {}): Promise<void> {
  const id = requireId(personId, '<person_id>');
  await executeToolCall('view_person', opts, async () => ({ person_id: id }));
}

export async function personCreateCommand(opts: PersonCreateOptions = {}): Promise<void> {
  const name = requiredName(opts.name);
  const methods = contactMethods(opts);
  const command: Record<string, unknown> = {
    operation_id: randomUUID(),
    name,
    ...scalarFields(opts as Record<string, unknown>, {
      jobTitle: 'job_title', company: 'company', location: 'location', headline: 'headline',
      industry: 'industry', address: 'address', notes: 'notes',
    }),
    ...(methods ? { methods } : {}),
  };
  await executeToolCall('create_person', opts, async () => ({ command }));
}

// ── Deals ───────────────────────────────────────────────────────────────────

export async function dealViewCommand(dealId: string, opts: DealViewOptions = {}): Promise<void> {
  const id = requireId(dealId, '<deal_id>');
  const include = [
    opts.plan ? 'plan' : undefined,
    opts.draft ? 'draft' : undefined,
    opts.autoSends ? 'auto_sends' : undefined,
  ].filter((value): value is string => value !== undefined);
  await executeToolCall('view_deal', opts, async () => ({ deal_id: id, ...(include.length ? { include } : {}) }));
}

/** create_deal requires target_name. For an existing record it is the record's own name. */
async function partyName(party: Party, opts: ToolExecutionOptions): Promise<string> {
  const tool = party.kind === 'person' ? 'view_person' : 'view_company';
  const result = await invokeToolCall(tool, opts, async () => ({ [`${party.kind}_id`]: party.id }));
  const structured = record(result.structured_content);
  const name = record(structured.party).name ?? structured.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new CliError(`${tool} returned no name for ${party.id}. No deal was created.`, ExitCode.NOT_FOUND, 'not_found');
  }
  return name.trim();
}

export async function dealCreateCommand(opts: DealCreateOptions = {}): Promise<void> {
  const party = partyFromIds(opts);
  const personName = nonEmpty(opts.name);
  const personEmail = nonEmpty(opts.email);
  if (party && (personName || personEmail)) {
    throw usage('Use --name and --email for a new Person, or --person-id or --company-id for an existing record, not both');
  }
  if (!party && !personName) {
    throw usage('Name who the deal is with: --person-id, --company-id, or --name (and --email) for a new Person');
  }
  const value = parseValue(opts.value);
  const owner = ownerValue(opts.owner);
  const goal = goalValue(opts.goal);
  const stage = nonEmpty(opts.stage);
  const dealName = nonEmpty(opts.dealName);

  let args: Record<string, unknown> = {};
  const build = (targetName: string): Record<string, unknown> => ({
    target_name: targetName,
    ...(party ? { party } : {}),
    ...(personEmail ? { target_email: personEmail } : {}),
    ...(stage ? { stage } : {}),
    ...(dealName ? { name: dealName } : {}),
    ...(value !== undefined ? { value_estimate: value } : {}),
    ...(owner ? { owner } : {}),
    ...(goal ? { goal } : {}),
  });
  if (personName) args = build(personName);

  await withApprovalLink(opts, () => executeToolCall('create_deal', opts, async () => args, undefined, {
    // The record read runs after the local write gate, so a refused call reads nothing.
    beforeConfirmation: party ? async () => { args = build(await partyName(party, opts)); } : undefined,
  }));
}

export async function dealUpdateCommand(dealId: string, opts: DealUpdateOptions = {}): Promise<void> {
  const id = requireId(dealId, '<deal_id>');
  const party = partyFromIds(opts);
  const value = parseValue(opts.value);
  const owner = ownerValue(opts.owner);
  const add = memberList(opts.addMember);
  const remove = memberList(opts.removeMember);

  const args: Record<string, unknown> = { deal_id: id };
  // An absent flag means no change. `--name ""` resets the name to the default.
  if (opts.name !== undefined) args.name = opts.name.trim();
  if (value !== undefined) args.value_estimate = value;
  if (party) args.party = party;
  if (owner) args.owner = owner;
  if (add || remove) args.members = { ...(add ? { add } : {}), ...(remove ? { remove } : {}) };
  // No --goal here: update_deal replaces the whole goal, so a summary alone
  // clears the services and the targeting. Use `every tool call update_deal`.
  if (Object.keys(args).length === 1) {
    throw usage('Nothing to change. Pass at least one of --name, --value, --owner, --person-id, --company-id, --add-member or --remove-member');
  }

  await withApprovalLink(opts, () => executeToolCall('update_deal', opts, async () => args));
}

// ── Deal outreach ───────────────────────────────────────────────────────────

async function readBody(opts: OutreachEditOptions): Promise<string | undefined> {
  if (opts.body !== undefined && opts.bodyFile !== undefined) throw usage('Use --body or --body-file, not both');
  if (opts.bodyFile === undefined) return opts.body;
  if (opts.bodyFile === '-') {
    process.stdin.setEncoding('utf8');
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return text;
  }
  try {
    return await readFile(opts.bodyFile, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw usage(`Could not read --body-file: ${detail}`);
  }
}

export async function outreachEditCommand(dealId: string, opts: OutreachEditOptions = {}): Promise<void> {
  const id = requireId(dealId, '<deal_id>');
  const body = await readBody(opts);
  const changes: Record<string, unknown> = {};
  if (opts.subject !== undefined) changes.subject = opts.subject;
  if (body !== undefined) changes.body = body;
  if (opts.recipient !== undefined) changes.recipient = opts.recipient.trim();
  if (opts.thread !== undefined) changes.thread_id = opts.thread.trim();
  if (Object.keys(changes).length === 0) {
    throw usage('Nothing to change. Pass at least one of --subject, --body, --body-file, --recipient or --thread');
  }
  const draftVersion = nonEmpty(opts.draftVersion);
  const args = { deal_id: id, action: 'edit', ...changes, ...(draftVersion ? { draft_version: draftVersion } : {}) };
  // Edit changes only the stored draft: an ordinary write, as `deal move` is.
  await withApprovalLink(opts, () =>
    executeToolCall('deal_outreach', opts, async () => args, undefined, { level: 'write' }));
}

export async function outreachCancelCommand(dealId: string, opts: OutreachCancelOptions = {}): Promise<void> {
  const id = requireId(dealId, '<deal_id>');
  const sendId = nonEmpty(opts.sendId);
  if (!sendId) throw usage('--send-id is required. Read it with every deal view <deal_id> --auto-sends');
  // Cancel stops a send, so nothing reaches a recipient: an ordinary write.
  await withApprovalLink(opts, () =>
    executeToolCall('deal_outreach', opts, async () => ({ deal_id: id, action: 'cancel', send_id: sendId }),
      undefined, { level: 'write' }));
}

/** A view_deal block: at the top of the result, or under `deal` or `result`. */
function viewBlock(structured: unknown, key: string): unknown {
  const top = record(structured);
  for (const candidate of [top, record(top.deal), record(top.result)]) {
    if (key in candidate) return candidate[key];
  }
  return undefined;
}

export interface OutreachPreview {
  channel: string;
  to: string | null;
  subject: string | null;
  body: string | null;
  draft_version: string;
}

export function outreachPreviewLines(preview: OutreachPreview): string {
  return [
    `Channel: ${preview.channel}`,
    `To: ${preview.to ?? 'the recipient on the draft'}`,
    ...(preview.subject !== null ? [`Subject: ${preview.subject}`] : []),
    `Draft version: ${preview.draft_version}`,
    '',
    preview.body ?? '(The message text is not available to this connection.)',
    '',
  ].join('\n');
}

async function readDraft(dealId: string, opts: ToolExecutionOptions): Promise<OutreachPreview> {
  const result = await invokeToolCall('view_deal', opts, async () => ({ deal_id: dealId, include: ['draft'] }));
  const draft = viewBlock(result.structured_content, 'draft');
  if (!draft || typeof draft !== 'object') {
    throw new CliError('This deal has no unsent draft. Nothing was sent.', ExitCode.NOT_FOUND, 'draft_not_found');
  }
  const fields = record(draft);
  const version = fields.draft_version;
  if (typeof version !== 'string' || !version) {
    throw new CliError('The server returned the draft without a draft_version. Nothing was sent.',
      ExitCode.GENERIC, 'draft_version_missing');
  }
  const text = (key: string): string | null => (typeof fields[key] === 'string' ? fields[key] as string : null);
  return {
    channel: text('channel') ?? 'message',
    to: text('to') ?? text('profile_url') ?? text('recipient_name'),
    subject: text('subject'),
    body: text('body'),
    draft_version: version,
  };
}

export async function outreachSendCommand(dealId: string, opts: OutreachSendOptions = {}): Promise<void> {
  const id = requireId(dealId, '<deal_id>');
  const given = nonEmpty(opts.draftVersion);
  let preview: OutreachPreview | undefined;
  let draftVersion = given;
  await withApprovalLink(opts, () => executeToolCall('deal_outreach', opts,
    async () => ({ deal_id: id, action: 'send', draft_version: draftVersion }),
    (data) => (preview ? { ...data, preview } : data), {
      level: 'destructive',
      // Without --draft-version, show the exact draft and send that version.
      // The read runs after the local destructive gate and before the prompt.
      beforeConfirmation: given ? undefined : async () => {
        preview = await readDraft(id, opts);
        draftVersion = preview.draft_version;
        process.stderr.write(outreachPreviewLines(preview));
      },
    }));
}

// ── Approvals ───────────────────────────────────────────────────────────────

const ARGUMENT_SUMMARY_KEYS = [
  'action', 'deal_id', 'send_id', 'invoice_id', 'proposal_id', 'prospect_id', 'person_id', 'company_id', 'stage',
];

/** Ids and the action only: arguments can hold message text, which this line never shows. */
export function argumentSummary(value: unknown): string {
  const args = record(value);
  const parts = ARGUMENT_SUMMARY_KEYS
    .filter((key) => typeof args[key] === 'string' || typeof args[key] === 'number')
    .map((key) => `${key}=${String(args[key])}`);
  if (Array.isArray(args.records)) parts.push(`records=${args.records.length}`);
  if (parts.length) return parts.join(' ');
  const count = Object.keys(args).length;
  return count ? `${count} argument(s)` : '';
}

function connectionLabel(request: Record<string, unknown>): string {
  const name = typeof request.connection_name === 'string' && request.connection_name ? request.connection_name : 'unknown';
  return request.this_connection === false ? `${name} (other connection)` : name;
}

export async function approvalsCommand(opts: ApprovalsOptions = {}): Promise<void> {
  const data = await invokeToolCall('get_workspace_priorities', opts);
  const url = approvalsUrl(opts);
  const approveLine = `Approve in Every: Settings > Approvals ${url}`;
  const block = (record(data.structured_content) as Record<string, unknown>).pending_approvals;

  let result: Record<string, unknown>;
  let human: string;
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    // A server before 2026-11-09 has no pending_approvals block.
    const message = 'This Every server does not report approval requests yet.';
    result = { available: false, reason: 'unsupported', message, requests: [], approvals_url: url };
    human = `${message}\n${approveLine}`;
  } else if (record(block).available === false) {
    const raw = record(block).message;
    const message = typeof raw === 'string' && raw ? raw : 'Approval requests are unavailable right now.';
    result = { available: false, reason: 'unavailable', message, requests: [], approvals_url: url };
    human = `${message}\n${approveLine}`;
  } else {
    const requests = Array.isArray(record(block).requests) ? (record(block).requests as unknown[]).map(record) : [];
    // A server before 2026-11-10 sends no this_connection field: its rows are this connection's.
    const shown = opts.all ? requests : requests.filter((request) =>
      (request.status === 'pending' || request.status === 'approved') && request.this_connection !== false);
    const hidden = requests.length - shown.length;
    result = {
      available: true,
      window_hours: record(block).window_hours ?? null,
      filter: opts.all ? 'all' : 'pending_or_approved_this_connection',
      requests: shown,
      total: requests.length,
      hidden,
      approvals_url: url,
    };
    const lines: string[] = [];
    if (shown.length === 0) {
      lines.push(opts.all
        ? 'No approval requests in the last 24 hours.'
        : 'No approval requests are pending or approved for this connection.');
    } else {
      lines.push(renderTable([
        { header: 'status', max: 9 },
        { header: 'tool', max: 24 },
        { header: 'arguments', max: 60 },
        { header: 'connection', max: 40 },
        { header: 'created', max: 16 },
        { header: 'expires' },
      ], shown.map((request) => [
        String(request.status ?? ''),
        String(request.tool ?? ''),
        argumentSummary(request.arguments),
        connectionLabel(request),
        shortTime(request.created_at),
        shortTime(request.expires_at),
      ])));
    }
    if (hidden > 0) lines.push(`${hidden} more request(s) are hidden. Run every approvals --all to show every row.`);
    lines.push('', approveLine);
    human = lines.join('\n');
  }

  if (opts.json) emit(result, { json: true, staging: opts.staging });
  else process.stdout.write(`${human}\n`);
}

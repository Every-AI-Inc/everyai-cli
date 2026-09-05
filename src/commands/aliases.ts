import { readFile } from 'node:fs/promises';
import { CliError } from '../lib/errors.js';
import { ExitCode } from '../lib/exit-codes.js';
import {
  executeToolCall,
  invokeToolCall,
  ToolCallData,
  ToolExecutionOptions,
} from './tools.js';

interface ListOptions extends ToolExecutionOptions {
  search?: string;
  limit?: string;
}

interface InvoiceListOptions extends ListOptions {
  status?: string;
}

interface DealListOptions extends ListOptions {
  stage?: string;
}

interface NetworkListOptions extends ListOptions { offset?: string; }

interface InvoiceSendOptions extends ToolExecutionOptions { recipients?: string; }

interface InvoiceCreateOptions extends ToolExecutionOptions {
  party?: string;
  partyKind?: string;
  partyId?: string;
  operationId?: string;
  amount?: string;
  description?: string;
  quantity?: string;
}

interface DealMoveOptions extends ToolExecutionOptions {}

const INVOICE_STATUSES = new Set(['draft', 'issued', 'void']);
const PAYMENT_STATUSES = new Set(['unpaid', 'paid', 'overdue', 'partial']);
const DEAL_STAGES = new Set(['lead', 'opportunity', 'won', 'lost']);
export type PartyKind = 'person' | 'company';
export interface PartyCandidate {
  kind: PartyKind;
  id: string;
  name: string;
  avatar_url?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUuid(value: string | undefined, flag: string): string {
  if (!value || !UUID.test(value)) {
    throw new CliError(`${flag} must be a UUID`, ExitCode.USAGE, 'usage');
  }
  return value;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new CliError('--limit must be a non-negative integer', ExitCode.USAGE, 'usage');
  }
  return limit;
}

function assertDealStage(stage: string): void {
  if (!DEAL_STAGES.has(stage)) {
    throw new CliError(
      `stage must be one of: ${Array.from(DEAL_STAGES).join(', ')}`,
      ExitCode.USAGE,
      'usage',
    );
  }
}

function addLimit(args: Record<string, unknown>, value: string | undefined): void {
  const limit = parseLimit(value);
  if (limit !== undefined) args.limit = limit;
}

function addInvoiceStatus(args: Record<string, unknown>, value: string | undefined): void {
  if (value === undefined) return;

  if (PAYMENT_STATUSES.has(value)) {
    args.payment_status = value;
    return;
  }

  if (INVOICE_STATUSES.has(value)) {
    args.status = value;
    return;
  }

  throw new CliError(
    `--status must be one of: ${[
      ...Array.from(INVOICE_STATUSES),
      ...Array.from(PAYMENT_STATUSES),
    ].join(', ')}`,
    ExitCode.USAGE,
    'usage',
  );
}

function parsePositiveNumber(value: string | undefined, flag: string): number {
  if (value === undefined || value.trim() === '') {
    throw new CliError(`${flag} is required`, ExitCode.USAGE, 'usage');
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`${flag} must be a positive number`, ExitCode.USAGE, 'usage');
  }
  return parsed;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Only the public Network page is authoritative. Nested affiliations and
// reflectable text may contain unrelated IDs; neither is resolution evidence.
export function parsePartyPage(result: { structured_content?: unknown }, kind: PartyKind): {
  items: PartyCandidate[]; has_more: boolean; total: number;
} {
  const page = result.structured_content as Record<string, unknown> | undefined;
  if (!page || !Array.isArray(page.items) || typeof page.has_more !== 'boolean' ||
      !Number.isInteger(page.total) || (page.total as number) < 0) {
    throw new CliError('Network results are incomplete. Refresh the tool catalog with --no-cache and choose an explicit --party-kind and --party-id.', ExitCode.NOT_FOUND, 'not_found');
  }
  const items = page.items.map((row: unknown): PartyCandidate => {
    const item = row as Record<string, unknown> | null;
    if (!item || item.kind !== kind || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.name !== 'string') {
      throw new CliError('Network results contain an invalid typed identity; choose a verified --party-kind and --party-id.', ExitCode.NOT_FOUND, 'not_found');
    }
    return { kind, id: item.id, name: item.name,
      ...(typeof item.avatar_url === 'string' || item.avatar_url === null ? { avatar_url: item.avatar_url } : {}) };
  });
  return { items, has_more: page.has_more, total: page.total as number };
}

function selectionError(query: string, candidates: PartyCandidate[], incomplete = false): CliError {
  return new CliError([
    incomplete ? `Search for "${query}" is incomplete; no invoice was created.` : `Choose a Person or Company matching "${query}".`,
    ...candidates.map(item => `${item.kind}:${item.id}  ${item.name}`),
    'Re-run with --party-kind person|company --party-id <id> and the same --operation-id.',
  ].join('\n'), ExitCode.NOT_FOUND, 'not_found', { candidates, incomplete });
}

async function resolveParty(opts: InvoiceCreateOptions): Promise<PartyCandidate | { kind: PartyKind; id: string }> {
  const kind = opts.partyKind as PartyKind | undefined;
  const query = nonEmpty(opts.party);
  if (kind && kind !== 'person' && kind !== 'company') {
    throw new CliError('--party-kind must be person or company', ExitCode.USAGE, 'usage');
  }
  if (opts.partyId) {
    if (!kind || query) throw new CliError('--party-id requires --party-kind and cannot be combined with --party.', ExitCode.USAGE, 'usage');
    return { kind, id: requireUuid(opts.partyId, '--party-id') };
  }
  if (!query) throw new CliError('--party or both --party-kind and --party-id are required.', ExitCode.USAGE, 'usage');
  const candidates = new Map<string, PartyCandidate>();
  for (const selectedKind of kind ? [kind] : ['person', 'company'] as PartyKind[]) {
    let offset = 0;
    let expectedTotal: number | undefined;
    for (let pageNumber = 0; ; pageNumber++) {
      const result = await invokeToolCall(selectedKind === 'person' ? 'list_people' : 'list_companies', opts,
        async () => ({ query, limit: 100, offset }));
      const page = parsePartyPage(result, selectedKind);
      if ((expectedTotal !== undefined && expectedTotal !== page.total) ||
          page.items.length > 100 || (page.has_more && page.items.length === 0)) {
        throw selectionError(query, [...candidates.values()], true);
      }
      expectedTotal = page.total;
      for (const item of page.items) {
        const key = `${item.kind}:${item.id}`;
        if (candidates.has(key)) throw selectionError(query, [...candidates.values()], true);
        candidates.set(key, item);
      }
      offset += page.items.length;
      if (!page.has_more) {
        if (offset !== page.total) throw selectionError(query, [...candidates.values()], true);
        break;
      }
      // Bounded calls never imply uniqueness from a partial result set.
      if (pageNumber >= 9 || offset >= page.total) throw selectionError(query, [...candidates.values()], true);
    }
  }
  if (candidates.size !== 1) throw selectionError(query, [...candidates.values()]);
  return [...candidates.values()][0];
}

export async function invoiceListCommand(opts: InvoiceListOptions = {}): Promise<void> {
  const args: Record<string, unknown> = {};
  addInvoiceStatus(args, opts.status);
  if (opts.search !== undefined) args.search = opts.search;
  addLimit(args, opts.limit);

  await executeToolCall('list_invoices', opts, async () => args);
}

export async function invoicePreviewSendCommand(invoiceId: string, opts: ToolExecutionOptions = {}): Promise<void> {
  await executeToolCall('preview_document_send', opts, async () => ({ document_kind: 'invoice', document_id: invoiceId }));
}

export async function invoiceSendCommand(invoiceId: string, opts: InvoiceSendOptions = {}): Promise<void> {
  await executeToolCall('send_invoice', opts, async () => {
    if (!opts.recipients) throw new CliError('--recipients <file> is required; first run invoice preview-send and save its reviewed recipients object.', ExitCode.USAGE, 'usage');
    let recipients: unknown;
    try { recipients = JSON.parse(await readFile(opts.recipients, 'utf8')); }
    catch { throw new CliError('--recipients must be a readable JSON file containing the reviewed recipients object.', ExitCode.USAGE, 'usage'); }
    const binding = recipients as Record<string, unknown> | null;
    if (!binding || Array.isArray(binding) || Object.keys(binding).some(key => !['digest', 'to', 'cc'].includes(key)) ||
        typeof binding.digest !== 'string' || !/^[a-f0-9]{64}$/.test(binding.digest) ||
        typeof binding.to !== 'string' || !binding.to || !Array.isArray(binding.cc) ||
        binding.cc.some(value => typeof value !== 'string')) {
      throw new CliError('--recipients must contain exactly the preview digest, to and cc. Do not edit or regenerate it for an approved retry.', ExitCode.USAGE, 'usage');
    }
    return { invoice_id: invoiceId, recipients };
  });
}

export async function invoiceCreateCommand(opts: InvoiceCreateOptions = {}): Promise<void> {
  const amount = parsePositiveNumber(opts.amount, '--amount');
  const quantity = opts.quantity === undefined ? 1 : parsePositiveNumber(opts.quantity, '--quantity');
  const operationId = requireUuid(opts.operationId, '--operation-id');
  let resolvedParty: Awaited<ReturnType<typeof resolveParty>>;
  await executeToolCall('create_invoice', opts, async () => {
    // The write gate runs before resolution or any other tool call.
    resolvedParty = await resolveParty(opts);
    return { command: { operation_id: operationId, party: { kind: resolvedParty.kind, id: resolvedParty.id },
      line_items: [{ description: opts.description ?? 'Services', quantity, unit_price: amount }] } };
  }, (data: ToolCallData) => ({ ...data, resolved_party: resolvedParty, operation_id: operationId }));
}

export async function dealListCommand(opts: DealListOptions = {}): Promise<void> {
  const args: Record<string, unknown> = {};
  if (opts.stage !== undefined) {
    assertDealStage(opts.stage);
    args.stage = opts.stage;
  }
  if (opts.search !== undefined) args.search = opts.search;
  addLimit(args, opts.limit);

  await executeToolCall('list_deals', opts, async () => args);
}

export async function dealMoveCommand(
  dealId: string,
  stage: string,
  opts: DealMoveOptions = {},
): Promise<void> {
  assertDealStage(stage);
  await executeToolCall('move_deal_stage', opts, async () => ({ deal_id: dealId, stage }));
}

export async function networkListCommand(kind: PartyKind, opts: NetworkListOptions = {}): Promise<void> {
  const args: Record<string, unknown> = {};
  if (opts.search !== undefined) args.query = opts.search;
  const limit = parseLimit(opts.limit);
  if (limit !== undefined) {
    if (limit < 1 || limit > 100) throw new CliError('--limit must be between 1 and 100.', ExitCode.USAGE, 'usage');
    args.limit = limit;
  }
  if (opts.offset !== undefined) args.offset = parseLimit(opts.offset);
  await executeToolCall(kind === 'person' ? 'list_people' : 'list_companies', opts, async () => args);
}

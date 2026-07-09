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

interface ContactListOptions extends ListOptions {}

interface InvoiceSendOptions extends ToolExecutionOptions {}

interface InvoiceCreateOptions extends ToolExecutionOptions {
  client?: string;
  clientId?: string;
  amount?: string;
  description?: string;
  quantity?: string;
}

interface DealMoveOptions extends ToolExecutionOptions {}

const INVOICE_STATUSES = new Set(['draft', 'issued', 'void']);
const PAYMENT_STATUSES = new Set(['unpaid', 'paid', 'overdue', 'partial']);
const DEAL_STAGES = new Set(['lead', 'opportunity', 'won', 'lost']);
const LIST_CLIENTS_NAME_PARAM = 'name';
const CREATE_INVOICE_CLIENT_ID_PARAM = 'client_id';
const CREATE_INVOICE_LINE_ITEMS_PARAM = 'line_items';
const LINE_ITEM_DESCRIPTION_PARAM = 'description';
const LINE_ITEM_QUANTITY_PARAM = 'quantity';
const LINE_ITEM_UNIT_PRICE_PARAM = 'unit_price';

export interface ClientCandidate {
  client_id: string;
  name: string;
}

export interface ResolvedClient {
  client_id: string;
  name: string | null;
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

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .replace(/\[(.*?)\]\([^)]*\)/g, '$1');
}

function cleanClientNameFromLine(value: string): string | undefined {
  let name = stripMarkdown(value)
    .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '')
    .replace(/^client(?:\s+name)?:\s*/i, '')
    // Drop a trailing status parenthetical like "(active)" / "(archived)".
    .replace(/\s*\((?:active|inactive|archived)\)\s*$/i, '')
    .trim();

  if (name.includes('|')) {
    const cells = name.split('|').map((cell) => cell.trim()).filter(Boolean);
    name = cells.find((cell) => !/^id$/i.test(cell) && !/@/.test(cell)) ?? cells[0] ?? '';
  }

  name = name
    .replace(/\s+[–—]\s+.*$/, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+<[^>]+>\s*$/, '')
    .replace(/\s+\([^)]*@[^)]*\)\s*$/, '')
    .trim();

  return name || undefined;
}

function parseClientCandidatesFromText(text: string): ClientCandidate[] {
  const candidates: ClientCandidate[] = [];

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/\[id:\s*([^\]\s]+)\s*\]/i);
    if (!match?.[1]) continue;

    const name = cleanClientNameFromLine(line.slice(0, match.index));
    if (!name) continue;

    candidates.push({ client_id: match[1], name });
  }

  return candidates;
}

function candidateFromObject(value: Record<string, unknown>): ClientCandidate | undefined {
  const clientId = stringField(value, ['client_id', 'clientId', 'id']);
  const name = stringField(value, ['name', 'client_name', 'clientName']);
  if (!clientId || !name) return undefined;
  return { client_id: clientId, name };
}

function collectStructuredCandidates(value: unknown, seen = new Set<unknown>()): ClientCandidate[] {
  if (!value || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStructuredCandidates(entry, seen));
  }

  const record = value as Record<string, unknown>;
  const direct = candidateFromObject(record);
  const nested = Object.values(record).flatMap((entry) => collectStructuredCandidates(entry, seen));
  return direct ? [direct, ...nested] : nested;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return undefined;
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string'
        ? candidate.text
        : undefined;
    })
    .filter((text): text is string => text !== undefined)
    .join('\n');
}

function textFromStructuredContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const result = (value as { result?: unknown }).result;
  return typeof result === 'string' ? result : '';
}

function dedupeCandidates(candidates: ClientCandidate[]): ClientCandidate[] {
  const seen = new Set<string>();
  const deduped: ClientCandidate[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.client_id}\0${candidate.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

export function parseClientCandidates(result: {
  structured_content?: unknown;
  content?: unknown;
}): ClientCandidate[] {
  return dedupeCandidates([
    ...collectStructuredCandidates(result.structured_content),
    ...parseClientCandidatesFromText(textFromStructuredContent(result.structured_content)),
    ...parseClientCandidatesFromText(textFromContent(result.content)),
  ]);
}

function clientCandidatesMessage(query: string, candidates: ClientCandidate[]): string {
  return [
    `Multiple clients matching "${query}".`,
    ...candidates.map((candidate) => `${candidate.client_id}  ${candidate.name}`),
    'Re-run with --client-id <id>',
  ].join('\n');
}

async function resolveClient(opts: InvoiceCreateOptions): Promise<ResolvedClient> {
  const clientId = nonEmpty(opts.clientId);
  const clientName = nonEmpty(opts.client);

  if (clientId) return { client_id: clientId, name: clientName ?? null };
  if (!clientName) {
    throw new CliError('--client or --client-id is required', ExitCode.USAGE, 'usage');
  }

  const result = await invokeToolCall('list_clients', opts, async () => ({
    [LIST_CLIENTS_NAME_PARAM]: clientName,
  }));
  const candidates = parseClientCandidates(result);

  if (candidates.length === 1) return candidates[0];

  if (candidates.length === 0) {
    throw new CliError(
      `No client matching "${clientName}". Run: every tool call list_clients --json`,
      ExitCode.NOT_FOUND,
      'not_found',
    );
  }

  throw new CliError(
    clientCandidatesMessage(clientName, candidates),
    ExitCode.NOT_FOUND,
    'not_found',
    { candidates },
  );
}

export async function invoiceListCommand(opts: InvoiceListOptions = {}): Promise<void> {
  const args: Record<string, unknown> = {};
  addInvoiceStatus(args, opts.status);
  if (opts.search !== undefined) args.search = opts.search;
  addLimit(args, opts.limit);

  await executeToolCall('list_invoices', opts, async () => args);
}

export async function invoiceSendCommand(
  invoiceId: string,
  opts: InvoiceSendOptions = {},
): Promise<void> {
  await executeToolCall('send_invoice', opts, async () => ({ invoice_id: invoiceId }));
}

export async function invoiceCreateCommand(opts: InvoiceCreateOptions = {}): Promise<void> {
  const amount = parsePositiveNumber(opts.amount, '--amount');
  const quantity = opts.quantity === undefined
    ? 1
    : parsePositiveNumber(opts.quantity, '--quantity');
  const resolvedClient = await resolveClient(opts);

  const args: Record<string, unknown> = {
    [CREATE_INVOICE_CLIENT_ID_PARAM]: resolvedClient.client_id,
    [CREATE_INVOICE_LINE_ITEMS_PARAM]: [
      {
        [LINE_ITEM_DESCRIPTION_PARAM]: opts.description ?? 'Services',
        [LINE_ITEM_QUANTITY_PARAM]: quantity,
        [LINE_ITEM_UNIT_PRICE_PARAM]: amount,
      },
    ],
  };

  await executeToolCall(
    'create_invoice',
    opts,
    async () => args,
    (data: ToolCallData) => ({ ...data, resolved_client: resolvedClient }),
  );
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

export async function contactListCommand(opts: ContactListOptions = {}): Promise<void> {
  const args: Record<string, unknown> = {};
  if (opts.search !== undefined) args.name = opts.search;
  addLimit(args, opts.limit);

  await executeToolCall('list_contacts', opts, async () => args);
}

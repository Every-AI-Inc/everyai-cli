import { CliError } from '../lib/errors.js';
import { ExitCode } from '../lib/exit-codes.js';
import { executeToolCall, ToolExecutionOptions } from './tools.js';

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

interface DealMoveOptions extends ToolExecutionOptions {}

const INVOICE_STATUSES = new Set(['draft', 'issued', 'void']);
const PAYMENT_STATUSES = new Set(['unpaid', 'paid', 'overdue', 'partial']);
const DEAL_STAGES = new Set(['lead', 'opportunity', 'won', 'lost']);

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

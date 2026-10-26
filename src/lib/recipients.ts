import { CliError } from './errors.js';
import { ExitCode } from './exit-codes.js';

export type DocumentKind = 'invoice' | 'proposal';

export function documentKind(value: string | undefined): DocumentKind {
  if (value !== 'invoice' && value !== 'proposal') {
    throw new CliError('--kind must be invoice or proposal', ExitCode.USAGE, 'usage');
  }
  return value;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export interface RecipientBinding extends Record<string, unknown> {
  digest: string;
  to: string;
  cc: string[];
}

/** Validate the server object without changing any binding field. */
export function recipientBinding(value: unknown, source: 'preview' | 'argument' = 'preview'): RecipientBinding {
  const binding = record(value);
  if (Object.keys(binding).sort().join(',') !== 'cc,digest,to' ||
      typeof binding.digest !== 'string' || !/^[a-f0-9]{64}$/.test(binding.digest) ||
      typeof binding.to !== 'string' || binding.to.length === 0 ||
      !Array.isArray(binding.cc) || !binding.cc.every((address) => typeof address === 'string')) {
    if (source === 'argument') {
      throw new CliError('Document sends require a recipients binding with exactly {digest, to, cc} from preview_document_send.',
        ExitCode.USAGE, 'usage');
    }
    throw new CliError('The server returned an invalid recipient preview. No document was sent.');
  }
  return binding as RecipientBinding;
}

/** Older servers omit model_state but return the complete exclusion list. */
export function preservedExclusions(defaults: Record<string, unknown>): string[] {
  const ids = defaults.none_method_ids;
  const state = defaults.model_state;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))) {
    throw new CliError('The server cannot confirm current recipient exclusions. No defaults were changed.',
      ExitCode.PERMISSION, 'recipient_exclusions_unavailable');
  }
  if ((state !== undefined && state !== 'v1' && state !== 'v2') || (state === 'v2' && ids.length > 0)) {
    throw new CliError('This recipient model cannot preserve the existing exclusions. No defaults were changed.',
      ExitCode.PERMISSION, 'recipient_exclusions_unavailable', { model_state: state });
  }
  return ids;
}

/** Use transport addresses as authority. Optional display details supply names only. */
export function recipientLines(data: Record<string, unknown>): string {
  const envelope = record(data.recipients ?? data.recipient_preview);
  const details = record(data.recipient_details);
  const detailRows = [details.to, ...(Array.isArray(details.cc) ? details.cc : [])].map(record);
  const methods = (Array.isArray(data.eligible_methods) ? data.eligible_methods : []).map(record);
  const line = (role: string, address: string): string => {
    const detail = detailRows.find((entry) => entry.address === address);
    const method = methods.find((entry) => entry.delivery_address === address);
    const name = detail?.owner_name ?? record(method?.owner).name;
    return `${role}: ${typeof name === 'string' && name ? name : 'Name unavailable'} <${address}>`;
  };
  const cc = Array.isArray(envelope.cc) ? envelope.cc : [];
  return [
    typeof envelope.to === 'string' ? line('To', envelope.to) : 'To: none',
    ...cc.map((address) => line('CC', String(address))),
    ...(cc.length === 0 ? ['CC: none'] : []),
    ...(envelope.error ? [`Recipient error: ${envelope.error}`] : []),
  ].join('\n');
}

import type { Writable } from 'node:stream';
import { resolveBaseUrl } from '../lib/config.js';
import { CliError } from '../lib/errors.js';
import { ExitCode } from '../lib/exit-codes.js';
import { formatSuccess } from '../lib/output.js';
import { invalidateUserInfoCache } from '../lib/auth/userinfo.js';
import { afterBrowserLogin, BrowserLoginDependencies, completeBrowserLogin } from './auth.js';
import { InvokeHooks, invokeToolCall, ToolCallData } from './tools.js';

export const SIGNUP_STATUS_TOOL = 'get_signup_status';
export const SIGNUP_COMPLETE_TOOL = 'complete_signup';
export const SIGNUP_UNSUPPORTED_MESSAGE = 'this server does not support agent signup yet';
export const DEFAULT_SIGNUP_TIMEOUT_SECONDS = 300;

const MAX_ORG_NAME_LENGTH = 256;
const MAX_PUBLIC_LINKS = 10;

export interface SignupOptions {
  json?: boolean;
  staging?: boolean;
  timeout?: string;
}

export interface SignupStatusOptions {
  json?: boolean;
  staging?: boolean;
}

export interface SignupCompleteOptions {
  json?: boolean;
  staging?: boolean;
  orgName?: string;
  description?: string;
  link?: string[];
  yes?: boolean;
  readOnly?: boolean;
}

export type SignupDependencies = BrowserLoginDependencies;

/** The server's signup envelope (see the plan's "Tool contracts"); fields beyond these pass through. */
export interface SignupEnvelope {
  signup_status?: string;
  account_ready?: boolean;
  user?: { email?: string | null; name?: string | null } | null;
  organization?: { org_id?: string | null; name?: string | null } | null;
  required_fields?: string[];
  current_profile?: {
    organization_name?: string | null;
    description?: string | null;
    public_links?: string[];
  } | null;
  profile_suggestions?: {
    status?: string;
    reason?: string | null;
    organization_name?: Suggestion | null;
    description?: Suggestion | null;
    public_links?: Array<{ url?: string; kind?: string; source?: string; confidence?: string }> | null;
  } | null;
  background_setup?: {
    state?: string;
    business_dna?: string;
    improve_with?: string[];
  } | null;
  saved_fields?: string[];
  optional_setup_url?: string | null;
  optional_setup_url_reason?: string | null;
  next_tool?: string | null;
  [key: string]: unknown;
}

interface Suggestion {
  value?: string;
  source?: string;
  confidence?: string;
}

const signupHooks: InvokeHooks = {
  missingTool: () =>
    new CliError(
      `${SIGNUP_UNSUPPORTED_MESSAGE}. Finish setting up your account in the Every web app.`,
      ExitCode.NOT_FOUND,
      'signup_unsupported',
    ),
};

function parseTimeoutSeconds(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SIGNUP_TIMEOUT_SECONDS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError('--timeout must be a positive number of seconds', ExitCode.USAGE, 'usage');
  }
  return seconds;
}

function writeLine(output: Writable, value: unknown): void {
  output.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

function emitEnvelope(
  output: Writable,
  envelope: SignupEnvelope,
  opts: { json?: boolean; staging?: boolean },
): void {
  writeLine(output, opts.json
    ? formatSuccess(envelope, { json: true, staging: opts.staging })
    : signupHuman(envelope));
}

/** The tool's structured result is the envelope; tolerate a server that only sends it as JSON text. */
function envelopeFrom(data: ToolCallData): SignupEnvelope {
  const structured = data.structured_content;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    return structured as SignupEnvelope;
  }
  const text = Array.isArray(data.content)
    ? data.content
        .map((block) => (block && typeof block === 'object' ? (block as { text?: unknown }).text : undefined))
        .filter((value): value is string => typeof value === 'string')
        .join('')
    : '';
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as SignupEnvelope;
  } catch {
    // Fall through to the error below.
  }
  throw new CliError(`${data.tool} returned no signup status`, ExitCode.GENERIC, 'generic');
}

function quoted(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function suggestionLine(label: string, suggestion: Suggestion | null | undefined): string | undefined {
  if (!suggestion?.value) return undefined;
  const provenance = [suggestion.source, suggestion.confidence].filter(Boolean).join(', ');
  return `  ${label}: ${suggestion.value}${provenance ? ` (${provenance})` : ''}`;
}

export function signupHuman(envelope: SignupEnvelope): string {
  const lines: string[] = [];
  const orgName = envelope.organization?.name ?? envelope.current_profile?.organization_name ?? null;
  const orgId = envelope.organization?.org_id ?? null;
  const workspace = orgName ? `${orgName}${orgId ? ` (${orgId})` : ''}` : orgId;

  if (envelope.account_ready) {
    lines.push(`Account ready${workspace ? ` · workspace ${workspace}` : ''}.`);
  } else {
    lines.push(`Signup is not finished${workspace ? ` · workspace ${workspace}` : ''}.`);
  }
  if (envelope.user?.email) lines.push(`Signed in as ${envelope.user.email}`);
  if (envelope.saved_fields?.length) lines.push(`Saved: ${envelope.saved_fields.join(', ')}`);

  if (!envelope.account_ready) {
    const required = envelope.required_fields?.length ? envelope.required_fields : ['organization_name'];
    lines.push(`Required: ${required.join(', ')}`);
    const suggestions = envelope.profile_suggestions;
    if (suggestions?.status === 'ready') {
      lines.push('Suggestions (unverified candidates from the mailbox and public web; confirm with the user):');
      const linkLines = (suggestions.public_links ?? [])
        .filter((link) => link?.url)
        .map((link) => {
          const provenance = [link.source, link.confidence].filter(Boolean).join(', ');
          return `  link: ${link.url}${provenance ? ` (${provenance})` : ''}`;
        });
      lines.push(...[
        suggestionLine('name', suggestions.organization_name),
        suggestionLine('description', suggestions.description),
        ...linkLines,
      ].filter((line): line is string => Boolean(line)));
    } else if (suggestions?.status) {
      lines.push(`Suggestions: ${suggestions.status}${suggestions.reason ? ` (${suggestions.reason})` : ''}`);
    }
    const nameHint = suggestions?.organization_name?.value ?? '<name>';
    lines.push(
      `Finish: every signup complete --org-name ${quoted(nameHint)} [--description "<text>"] [--link <url>] --yes`,
    );
  }

  const background = envelope.background_setup;
  if (background?.state) {
    const dna = background.business_dna ? `, business DNA ${background.business_dna}` : '';
    lines.push(`Background setup: ${background.state}${dna} (does not affect account readiness)`);
    if (background.improve_with?.length) {
      lines.push(`  Improve it by adding: ${background.improve_with.join(', ')}`);
    }
  }
  if (envelope.optional_setup_url) lines.push(`Optional browser setup: ${envelope.optional_setup_url}`);
  return lines.join('\n');
}

function resumeHint(err: unknown, timeoutSeconds: number): unknown {
  if (!(err instanceof CliError) || err.code !== 'auth') return err;
  const timedOut = err.details?.reason === 'timeout';
  const message = timedOut
    ? `Signup timed out after ${timeoutSeconds}s waiting for the browser authorization. ` +
      'Run `every signup` again to get a new link (add --timeout <seconds> for more time).'
    : `${err.message}. Run \`every signup\` again to retry.`;
  return new CliError(message, err.exitCode, err.code, err.details);
}

async function fetchSignupStatus(opts: { staging?: boolean }): Promise<SignupEnvelope> {
  const data = await invokeToolCall(
    SIGNUP_STATUS_TOOL,
    { staging: opts.staging, noCache: true },
    async () => ({}),
    signupHooks,
  );
  return envelopeFrom(data);
}

async function forgetCachedIdentity(staging: boolean | undefined): Promise<void> {
  // A new or renamed workspace makes the cached userinfo org name wrong.
  await invalidateUserInfoCache(resolveBaseUrl({ staging })).catch(() => undefined);
}

/**
 * `every signup`: one browser authorization, then the server's signup status.
 *
 * Built for coding agents, which run commands without a TTY: it never waits for
 * Enter and never opens the web sign-up page. The authorization URL is printed
 * before the browser is tried (in --json mode as the first NDJSON line), so an
 * agent can hand it to the user when no browser opens. The last line is the
 * normal envelope.
 */
export async function signupCommand(
  opts: SignupOptions = {},
  deps: SignupDependencies = {},
): Promise<void> {
  if (process.env.EVERY_TOKEN) {
    throw new CliError(
      'EVERY_TOKEN is set. It is an automation override and never a signup path; ' +
        'unset EVERY_TOKEN, then run `every signup`.',
      ExitCode.USAGE,
      'usage',
    );
  }
  const timeoutSeconds = parseTimeoutSeconds(opts.timeout);
  const output = deps.output ?? process.stdout;
  const errorOutput = deps.errorOutput ?? process.stderr;

  try {
    await completeBrowserLogin({ json: opts.json, staging: opts.staging }, {
      ...deps,
      flow: {
        timeoutMs: timeoutSeconds * 1000,
        onAuthorizationUrl(url) {
          if (opts.json) writeLine(output, { event: 'authorization_required', url });
          else writeLine(errorOutput, `Authorize Every in your browser: ${url}`);
        },
        onBrowserOpened(opened) {
          if (opts.json) {
            writeLine(output, {
              event: 'waiting_for_authorization',
              browser_opened: opened,
              timeout_seconds: timeoutSeconds,
            });
            return;
          }
          if (!opened) writeLine(errorOutput, 'Could not open a browser. Open the URL above to continue.');
          writeLine(errorOutput, `Waiting up to ${timeoutSeconds}s for the browser step to finish...`);
        },
      },
    });
  } catch (err) {
    throw resumeHint(err, timeoutSeconds);
  }

  const envelope = await fetchSignupStatus(opts);
  await forgetCachedIdentity(opts.staging);
  emitEnvelope(output, envelope, opts);
  await afterBrowserLogin({ json: opts.json }, deps);
}

/** `every signup status`: the current signup envelope for the stored login. */
export async function signupStatusCommand(opts: SignupStatusOptions = {}): Promise<void> {
  const envelope = await fetchSignupStatus(opts);
  emitEnvelope(process.stdout, envelope, opts);
}

function normalizeLinks(links: string[]): string[] {
  const normalized = links.map((link) => link.trim()).filter(Boolean);
  if (normalized.length > MAX_PUBLIC_LINKS) {
    throw new CliError(`--link accepts at most ${MAX_PUBLIC_LINKS} links`, ExitCode.USAGE, 'usage');
  }
  for (const link of normalized) {
    let url: URL | undefined;
    try {
      url = new URL(link);
    } catch {
      url = undefined;
    }
    if (url?.protocol !== 'https:') {
      throw new CliError(`--link must be an https URL: ${link}`, ExitCode.USAGE, 'usage');
    }
  }
  return Array.from(new Set(normalized));
}

export function completeSignupArgs(opts: SignupCompleteOptions): Record<string, unknown> {
  const name = opts.orgName?.trim() ?? '';
  if (!name) {
    throw new CliError('--org-name is required and must not be blank', ExitCode.USAGE, 'usage');
  }
  if (name.length > MAX_ORG_NAME_LENGTH) {
    throw new CliError(`--org-name must be at most ${MAX_ORG_NAME_LENGTH} characters`, ExitCode.USAGE, 'usage');
  }
  const args: Record<string, unknown> = { organization_name: name };
  const description = opts.description?.trim();
  if (description) args.description = description;
  const links = normalizeLinks(opts.link ?? []);
  if (links.length) args.public_links = links;
  return args;
}

/**
 * `every signup complete`: commit the profile the user confirmed. It is an
 * ordinary write, so it needs --yes when non-interactive and never
 * --allow-destructive; the server's text confirmation is retried once by the
 * shared executor.
 */
export async function signupCompleteCommand(opts: SignupCompleteOptions = {}): Promise<void> {
  const args = completeSignupArgs(opts);
  const data = await invokeToolCall(
    SIGNUP_COMPLETE_TOOL,
    { json: opts.json, staging: opts.staging, noCache: true, yes: opts.yes, readOnly: opts.readOnly },
    async () => args,
    signupHooks,
  );
  const envelope = envelopeFrom(data);
  await forgetCachedIdentity(opts.staging);
  emitEnvelope(process.stdout, envelope, opts);
}

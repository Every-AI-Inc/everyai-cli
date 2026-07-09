import { resolveBaseUrl } from '../lib/config.js';
import { CliError } from '../lib/errors.js';
import { ExitCode } from '../lib/exit-codes.js';
import { mcpCall } from '../lib/mcp.js';
import { loginFlow } from '../lib/auth/flow.js';
import { decodeJwtClaims, JwtClaims } from '../lib/auth/jwt.js';
import {
  AuthStatus,
  createTokenStore,
  deleteTokenFromAllStores,
  getAuthStatus,
  getToken,
  resolveAuthTarget,
} from '../lib/auth/tokens.js';
import { emit } from '../lib/output.js';

const WHOAMI_TIMEOUT_MS = 10_000;

export interface AuthCommandOptions {
  json?: boolean;
  staging?: boolean;
}

interface LoginResult {
  logged_in: boolean;
  issuer: string | null;
  subject: string | null;
  email: string | null;
  storage_backend: 'keyring' | 'file' | null;
  every_token: boolean;
}

interface LogoutResult {
  logged_out: true;
  environment: string;
}

interface WhoamiResult {
  authenticated: true;
  subject: string | null;
  email: string | null;
  org_id: string | null;
  tools: number;
}

interface OrgResult {
  org_id: string | null;
  org_slug: string | null;
  org_name: string | null;
  organization_id: string | null;
  organization_slug: string | null;
  organization_name: string | null;
}

function emitCommand<T>(data: T, human: string, opts: AuthCommandOptions): void {
  if (opts.json) emit(data, { json: true });
  else process.stdout.write(`${human}\n`);
}

function identityFromToken(token: string): Pick<LoginResult, 'subject' | 'email'> {
  const claims = decodeJwtClaims(token);
  return {
    subject: claims?.sub ?? null,
    email: claims?.email ?? null,
  };
}

function loginHuman(data: LoginResult): string {
  if (data.every_token) return 'EVERY_TOKEN is set; login is unnecessary.';
  const identity = data.email ?? data.subject;
  return identity ? `Logged in as ${identity}` : 'Logged in';
}

function statusHuman(status: AuthStatus): string {
  return [
    `Logged in: ${status.logged_in ? 'yes' : 'no'}`,
    `Environment: ${status.environment}`,
    `Base URL: ${status.base_url}`,
    `Storage: ${status.storage_backend}`,
    `EVERY_TOKEN: ${status.every_token ? 'overriding' : 'not set'}`,
    `Issuer: ${status.issuer ?? 'none'}`,
    `Expires: ${status.expires ?? 'unknown'}`,
    `Refresh token: ${status.refresh_token ? 'yes' : 'no'}`,
  ].join('\n');
}

function orgFromClaims(claims: JwtClaims | null): OrgResult {
  return {
    org_id: typeof claims?.org_id === 'string' ? claims.org_id : null,
    org_slug: typeof claims?.org_slug === 'string' ? claims.org_slug : null,
    org_name: typeof claims?.org_name === 'string' ? claims.org_name : null,
    organization_id:
      typeof claims?.organization_id === 'string' ? claims.organization_id : null,
    organization_slug:
      typeof claims?.organization_slug === 'string' ? claims.organization_slug : null,
    organization_name:
      typeof claims?.organization_name === 'string' ? claims.organization_name : null,
  };
}

function orgHuman(org: OrgResult): string {
  const lines = [
    `org_id: ${org.org_id ?? 'none'}`,
    `org_slug: ${org.org_slug ?? 'none'}`,
    `org_name: ${org.org_name ?? 'none'}`,
  ];

  if (org.organization_id || org.organization_slug || org.organization_name) {
    lines.push(`organization_id: ${org.organization_id ?? 'none'}`);
    lines.push(`organization_slug: ${org.organization_slug ?? 'none'}`);
    lines.push(`organization_name: ${org.organization_name ?? 'none'}`);
  }

  return lines.join('\n');
}

async function verifyMcpLiveness(
  baseUrl: string,
  token: string,
): Promise<{ authenticated: true; tools: number }> {
  const body = await mcpCall<{ tools?: unknown[] }>(
    baseUrl,
    token,
    'tools/list',
    {},
    { timeoutMs: WHOAMI_TIMEOUT_MS },
  );
  return {
    authenticated: true,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
  };
}

export async function loginCommand(opts: AuthCommandOptions = {}): Promise<void> {
  if (process.env.EVERY_TOKEN) {
    const identity = identityFromToken(process.env.EVERY_TOKEN);
    const data: LoginResult = {
      logged_in: true,
      issuer: null,
      subject: identity.subject,
      email: identity.email,
      storage_backend: null,
      every_token: true,
    };
    emitCommand(data, loginHuman(data), opts);
    return;
  }

  if (!process.stdout.isTTY) {
    throw new CliError(
      'login requires a browser; set EVERY_TOKEN for headless use',
      ExitCode.AUTH,
      'auth',
    );
  }

  const baseUrl = resolveBaseUrl({ staging: opts.staging });
  const { environmentKey } = resolveAuthTarget({ baseUrl });
  const tokenSet = await loginFlow({
    baseUrl,
    onAuthorizationUrl(url) {
      process.stderr.write(`Open this URL to log in:\n${url}\n`);
    },
  });

  const store = await createTokenStore();
  await store.set(environmentKey, tokenSet);

  const identity = identityFromToken(tokenSet.access_token);
  const data: LoginResult = {
    logged_in: true,
    issuer: tokenSet.issuer,
    subject: identity.subject,
    email: identity.email,
    storage_backend: store.backend,
    every_token: false,
  };
  emitCommand(data, loginHuman(data), opts);
}

export async function logoutCommand(opts: AuthCommandOptions = {}): Promise<void> {
  const { environmentKey } = resolveAuthTarget({ staging: opts.staging });
  await deleteTokenFromAllStores(environmentKey);

  const data: LogoutResult = {
    logged_out: true,
    environment: environmentKey,
  };
  emitCommand(data, 'Logged out', opts);
}

export async function authStatusCommand(opts: AuthCommandOptions = {}): Promise<void> {
  const status = await getAuthStatus({ staging: opts.staging });
  emitCommand(status, statusHuman(status), opts);
}

export async function whoamiCommand(opts: AuthCommandOptions = {}): Promise<void> {
  const baseUrl = resolveBaseUrl({ staging: opts.staging });
  const token = await getToken({ baseUrl });
  const claims = decodeJwtClaims(token);
  const liveness = await verifyMcpLiveness(baseUrl, token);
  const data: WhoamiResult = {
    authenticated: liveness.authenticated,
    subject: claims?.sub ?? null,
    email: claims?.email ?? null,
    org_id:
      typeof claims?.org_id === 'string'
        ? claims.org_id
        : typeof claims?.organization_id === 'string'
          ? claims.organization_id
          : null,
    tools: liveness.tools,
  };

  const identity = data.email ?? data.subject ?? 'unknown';
  emitCommand(
    data,
    [
      `Authenticated: yes`,
      `User: ${identity}`,
      `Org: ${data.org_id ?? 'none'}`,
      `Tools: ${data.tools}`,
    ].join('\n'),
    opts,
  );
}

export async function orgCommand(opts: AuthCommandOptions = {}): Promise<void> {
  const token = await getToken({ staging: opts.staging });
  const org = orgFromClaims(decodeJwtClaims(token));
  emitCommand(org, orgHuman(org), opts);
}

import { environmentNameForBaseUrl, resolveBaseUrl } from '../lib/config.js';
import { CliError } from '../lib/errors.js';
import { ExitCode } from '../lib/exit-codes.js';
import { mcpCall } from '../lib/mcp.js';
import { loginFlow } from '../lib/auth/flow.js';
import { decodeJwtClaims } from '../lib/auth/jwt.js';
import {
  AuthStatus,
  createTokenStore,
  deleteTokenFromAllStores,
  getAuthStatus,
  getToken,
  resolveAuthTarget,
} from '../lib/auth/tokens.js';
import { fetchUserInfo, UserInfo } from '../lib/auth/userinfo.js';
import { maybeShowSkillHint } from '../lib/hints.js';
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
  user_id: string | null;
  subject: string | null;
  email: string | null;
  name: string | null;
  org_id: string | null;
  org_slug: string | null;
  org_name: string | null;
  environment: string;
  base_url: string;
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
  if (opts.json) emit(data, { json: true, staging: opts.staging });
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

function loginNextSteps(): string {
  return [
    'Next steps:',
    '  every whoami',
    '  every tools list',
    '  every skills install claude|codex',
  ].join('\n');
}

function emitLogin(data: LoginResult, opts: AuthCommandOptions): void {
  const human = `${loginHuman(data)}\n${loginNextSteps()}`;
  if (opts.json) {
    emit(data, { json: true, staging: opts.staging });
    process.stderr.write(`${loginNextSteps()}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
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

function orgFromUserInfo(userinfo: UserInfo): OrgResult {
  return {
    org_id: userinfo.org_id,
    org_slug: userinfo.org_slug,
    org_name: userinfo.org_name,
    organization_id: userinfo.org_id,
    organization_slug: userinfo.org_slug,
    organization_name: userinfo.org_name,
  };
}

function orgHuman(org: OrgResult): string {
  const lines = [
    `Org: ${formatOrg(org.org_name, org.org_id)}`,
    `Slug: ${org.org_slug ?? 'none'}`,
    'Note: the server scopes writes to this org.',
  ];

  return lines.join('\n');
}

function formatUser(userinfo: UserInfo): string {
  if (userinfo.name && userinfo.email) return `${userinfo.name} (${userinfo.email})`;
  return userinfo.name ?? userinfo.email ?? userinfo.user_id ?? 'unknown';
}

function formatOrg(orgName: string | null, orgId: string | null): string {
  if (orgName && orgId) return `${orgName} (${orgId})`;
  return orgName ?? orgId ?? 'none';
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
    emitLogin(data, opts);
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
  emitLogin(data, opts);
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
  const userinfo = await fetchUserInfo({ baseUrl });
  const token = await getToken({ baseUrl });
  const liveness = await verifyMcpLiveness(baseUrl, token);
  const environment = environmentNameForBaseUrl(baseUrl);
  const data: WhoamiResult = {
    authenticated: liveness.authenticated,
    user_id: userinfo.user_id,
    subject: userinfo.user_id,
    email: userinfo.email,
    name: userinfo.name,
    org_id: userinfo.org_id,
    org_slug: userinfo.org_slug,
    org_name: userinfo.org_name,
    environment,
    base_url: baseUrl,
    tools: liveness.tools,
  };

  emitCommand(
    data,
    [
      `Authenticated: yes`,
      `User: ${formatUser(userinfo)}`,
      `Org: ${formatOrg(userinfo.org_name, userinfo.org_id)}`,
      `Environment: ${environment} (${baseUrl})`,
      `Tools: ${data.tools}`,
    ].join('\n'),
    opts,
  );
  await maybeShowSkillHint();
}

export async function orgCommand(opts: AuthCommandOptions = {}): Promise<void> {
  const baseUrl = resolveBaseUrl({ staging: opts.staging });
  const org = orgFromUserInfo(await fetchUserInfo({ baseUrl }));
  emitCommand(org, orgHuman(org), opts);
}

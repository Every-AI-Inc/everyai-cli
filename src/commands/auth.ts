import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import {
  apiKeysUrlForBaseUrl,
  environmentNameForBaseUrl,
  resolveBaseUrl,
  signupUrlForBaseUrl,
} from '../lib/config.js';
import { CliError } from '../lib/errors.js';
import { ExitCode } from '../lib/exit-codes.js';
import { mcpCall } from '../lib/mcp.js';
import { loginFlow, openBrowser as openBrowserDefault } from '../lib/auth/flow.js';
import { activeCredentialIsApiKey, AuthMethod, isApiKeyToken } from '../lib/auth/api-key.js';
import { decodeJwtClaims } from '../lib/auth/jwt.js';
import {
  AuthStatus,
  createTokenStore,
  deleteTokenFromAllStores,
  getAuthStatus,
  getToken,
  resolveAuthTarget,
  TokenStore,
} from '../lib/auth/tokens.js';
import {
  fetchUserInfo,
  invalidateUserInfoCache,
  readCachedUserInfo,
  requestUserInfo,
  UserInfo,
  writeUserInfoCache,
} from '../lib/auth/userinfo.js';
import {
  HintsFile,
  maybeShowSkillHint,
  readHints,
  writeHints,
} from '../lib/hints.js';
import { emit } from '../lib/output.js';
import { installBundledSkill } from './skills.js';

const WHOAMI_TIMEOUT_MS = 10_000;
const SKILL_OFFER_PROMPT =
  'Teach your coding agent to use Every? Install the use-every skill: [1] Claude Code [2] Codex [3] Both [Enter=skip]';

type SkillOfferTarget = 'claude' | 'codex';
type TtyReadable = Readable & { isTTY?: boolean };
type TtyWritable = Writable & { isTTY?: boolean };

export interface SkillOfferFileSystem {
  pathExists(filePath: string): Promise<boolean>;
  readHints(): Promise<HintsFile>;
  writeHints(hints: HintsFile): Promise<void>;
}

export interface PostLoginSkillOfferOptions {
  json?: boolean;
  input?: TtyReadable;
  output?: TtyWritable;
  errorOutput?: Writable;
  cwd?: string;
  homeDir?: string;
  fileSystem?: SkillOfferFileSystem;
  installSkill?: (target: SkillOfferTarget) => Promise<{ installed_to: string }>;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const defaultSkillOfferFileSystem: SkillOfferFileSystem = {
  pathExists,
  readHints,
  writeHints,
};

function hostPaths(cwd: string, homeDir: string): Record<
  SkillOfferTarget,
  { markers: string[]; installed: string[] }
> {
  return {
    claude: {
      markers: [path.join(cwd, '.claude'), path.join(homeDir, '.claude')],
      installed: [
        path.join(cwd, '.claude', 'skills', 'use-every'),
        path.join(homeDir, '.claude', 'skills', 'use-every'),
      ],
    },
    codex: {
      markers: [path.join(cwd, '.agents'), path.join(homeDir, '.codex')],
      installed: [
        path.join(cwd, '.agents', 'skills', 'use-every'),
        path.join(homeDir, '.codex', 'skills', 'use-every'),
        path.join(homeDir, '.agents', 'skills', 'use-every'),
      ],
    },
  };
}

async function anyPathExists(
  fileSystem: SkillOfferFileSystem,
  paths: string[],
): Promise<boolean> {
  const matches = await Promise.all(paths.map((filePath) => fileSystem.pathExists(filePath)));
  return matches.some(Boolean);
}

function targetsForAnswer(answer: string): SkillOfferTarget[] {
  if (answer === '1') return ['claude'];
  if (answer === '2') return ['codex'];
  if (answer === '3') return ['claude', 'codex'];
  return [];
}

function targetLabel(target: SkillOfferTarget): string {
  return target === 'claude' ? 'Claude Code' : 'Codex';
}

/** Best-effort interactive offer shown only after a browser login succeeds. */
export async function maybeOfferSkillAfterLogin(
  opts: PostLoginSkillOfferOptions = {},
): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const errorOutput = opts.errorOutput ?? process.stderr;

  const promptsToProcessStderr = opts.errorOutput === undefined || opts.errorOutput === process.stderr;
  if (
    opts.json ||
    input.isTTY !== true ||
    output.isTTY !== true ||
    (promptsToProcessStderr && process.stderr.isTTY !== true)
  ) return;

  try {
    const fileSystem = opts.fileSystem ?? defaultSkillOfferFileSystem;
    const hints = await fileSystem.readHints();
    if (hints.skill_offer_declined) return;

    const cwd = opts.cwd ?? process.cwd();
    const paths = hostPaths(cwd, opts.homeDir ?? os.homedir());
    const [claudeDetected, claudeInstalled, codexDetected, codexInstalled] = await Promise.all([
      anyPathExists(fileSystem, paths.claude.markers),
      anyPathExists(fileSystem, paths.claude.installed),
      anyPathExists(fileSystem, paths.codex.markers),
      anyPathExists(fileSystem, paths.codex.installed),
    ]);
    if (!(claudeDetected && !claudeInstalled) && !(codexDetected && !codexInstalled)) return;

    const rl = createInterface({ input, output: errorOutput, terminal: false });
    let answer: string;
    try {
      answer = (await rl.question(`${SKILL_OFFER_PROMPT}\n`)).trim();
    } finally {
      rl.close();
    }

    if (answer === '') {
      await fileSystem.writeHints({ ...hints, skill_offer_declined: true });
      return;
    }

    const installSkill = opts.installSkill ?? ((target: SkillOfferTarget) => {
      const installRoot = target === 'claude'
        ? path.join(cwd, '.claude', 'skills')
        : path.join(cwd, '.agents', 'skills');
      return installBundledSkill(target, { dir: installRoot });
    });

    for (const target of targetsForAnswer(answer)) {
      const installed = await installSkill(target);
      output.write(
        `Installed use-every for ${targetLabel(target)} to ${installed.installed_to} — commit it to share with your team.\n`,
      );
    }
  } catch {
    // An optional offer must never turn a successful login into a failure.
  }
}

export interface AuthCommandOptions {
  json?: boolean;
  staging?: boolean;
  createAccount?: boolean;
  skipMenu?: boolean;
  org?: string;
}

export interface CreateAccountFlowOptions extends AuthCommandOptions {
  input?: TtyReadable;
  output?: TtyWritable;
  errorOutput?: Writable;
  openBrowser?: (url: string) => void | Promise<void>;
  runLogin?: () => Promise<void>;
}

export interface LoginResult {
  user_id: string | null;
  org_id: string | null;
  org_slug: string | null;
  org_name: string | null;
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
  auth_method: AuthMethod;
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
  auth_method: AuthMethod;
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
  // An API key carries no claims; decoding its secret half as a JWT payload
  // could only produce noise.
  const claims = isApiKeyToken(token) ? null : decodeJwtClaims(token);
  return {
    subject: claims?.sub ?? null,
    email: claims?.email ?? null,
  };
}

function loginHuman(data: LoginResult): string {
  if (data.every_token) return 'EVERY_TOKEN is set; login is unnecessary.';
  const identity = data.email ?? data.subject;
  return `Logged in as ${identity ?? 'unknown'} · workspace ${formatOrg(data.org_name, data.org_id)}\nSwitch workspace: every org switch`;
}

function loginNextSteps(): string {
  return [
    'Next steps:',
    '  every whoami',
    '  every tools list',
    '  every skills install claude|codex',
  ].join('\n');
}

function emitLogin(
  data: LoginResult,
  opts: AuthCommandOptions,
  output: Writable = process.stdout,
  errorOutput: Writable = process.stderr,
): void {
  const human = `${loginHuman(data)}\n${loginNextSteps()}`;
  if (opts.json) {
    emit(data, { json: true, staging: opts.staging });
    errorOutput.write(`${loginNextSteps()}\n`);
  } else {
    output.write(`${human}\n`);
  }
}

function everyTokenStatusLabel(status: AuthStatus): string {
  if (!status.every_token) return 'not set';
  return status.auth_method === 'api_key' ? 'overriding (Every API key)' : 'overriding';
}

function statusHuman(status: AuthStatus): string {
  return [
    `Logged in: ${status.logged_in ? 'yes' : 'no'}`,
    `Environment: ${status.environment}`,
    `Base URL: ${status.base_url}`,
    `Storage: ${status.storage_backend}`,
    `EVERY_TOKEN: ${everyTokenStatusLabel(status)}`,
    `Issuer: ${status.issuer ?? 'none'}`,
    `Expires: ${status.expires ?? 'unknown'}`,
    `Refresh token: ${status.refresh_token ? 'yes' : 'no'}`,
  ].join('\n');
}

function orgFromUserInfo(userinfo: UserInfo): OrgResult {
  return {
    auth_method: 'oauth',
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
    'Switch: every org switch [--org <name|slug|id>]',
  ];

  return lines.join('\n');
}

/**
 * What an API key can truthfully say about its workspace.
 *
 * The key IS bound to exactly one org, but that binding lives server-side: the
 * MCP surface hands a key no org identity (the only tool that reports one,
 * `get_home`, is denied to keys), and the OAuth userinfo endpoint cannot resolve
 * the key at all. So the workspace is stated as unavailable rather than guessed
 * at, and there is no `every org switch` suggestion — a key cannot switch.
 */
const API_KEY_ORG_LINE =
  'Org: not reported for API keys — the key is bound to one workspace on the server';

function apiKeyOrgHuman(environment: string, baseUrl: string): string {
  return [
    API_KEY_ORG_LINE,
    'Authenticated: yes (Every API key)',
    `Environment: ${environment} (${baseUrl})`,
    'Note: the server scopes writes to the key\'s workspace.',
    `Manage keys in Every: Settings → API keys (${apiKeysUrlForBaseUrl(baseUrl)})`,
  ].join('\n');
}

function apiKeyWhoamiHuman(data: WhoamiResult): string {
  return [
    'Authenticated: yes (Every API key)',
    API_KEY_ORG_LINE,
    `Environment: ${data.environment} (${data.base_url})`,
    `Tools: ${data.tools} available to this key`,
    `Manage keys in Every: Settings → API keys (${apiKeysUrlForBaseUrl(data.base_url)})`,
  ].join('\n');
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

function validateOrgTarget(target: string): void {
  if (!target.trim()) {
    throw new CliError('--org must not be empty or whitespace-only', ExitCode.USAGE, 'usage');
  }
}

/** IDs are exact; slugs ignore case; display names also trim and normalize Unicode. */
export function matchesOrg(target: string, info: UserInfo): boolean {
  validateOrgTarget(target);
  const name = (value: string) => value.trim().normalize('NFC').toLowerCase();
  return target === info.org_id ||
    (info.org_slug !== null && target.toLowerCase() === info.org_slug.toLowerCase()) ||
    (info.org_name !== null && name(target) === name(info.org_name));
}

function validateBrowserLogin(opts: AuthCommandOptions, switching = false): void {
  if (opts.org !== undefined) validateOrgTarget(opts.org);
  if (process.env.EVERY_TOKEN && (switching || opts.org !== undefined)) {
    throw new CliError(
      activeCredentialIsApiKey()
        ? 'An Every API key is bound to one workspace and cannot switch. ' +
          'Workspace switching requires stored credentials; unset EVERY_TOKEN and try again, ' +
          'or mint a key in the other workspace under Settings → API keys.'
        : 'Workspace switching requires stored credentials; unset EVERY_TOKEN and try again.',
      ExitCode.USAGE,
      'usage',
    );
  }
}

export interface BrowserLoginDependencies {
  input?: TtyReadable;
  output?: TtyWritable;
  errorOutput?: Writable;
  loginFlow?: typeof loginFlow;
  store?: TokenStore;
}

/** Exchange, verify, then commit. A failed assertion never mutates stored auth or identity. */
export async function completeBrowserLogin(
  opts: AuthCommandOptions,
  deps: BrowserLoginDependencies = {},
  switching = false,
): Promise<LoginResult> {
  validateBrowserLogin(opts, switching);
  const errorOutput = deps.errorOutput ?? process.stderr;
  const baseUrl = resolveBaseUrl({ staging: opts.staging });
  const { environmentKey } = resolveAuthTarget({ baseUrl });
  errorOutput.write(opts.org === undefined
    ? "Pick the workspace in the consent page's selector.\n"
    : `In the consent page's selector, pick "${opts.org}".\n`);
  const tokenSet = await (deps.loginFlow ?? loginFlow)({
    baseUrl,
    onAuthorizationUrl(url) {
      errorOutput.write(`Open this URL to log in:\n${url}\n`);
    },
  });

  let userinfo: UserInfo | undefined;
  try {
    userinfo = await requestUserInfo({ baseUrl, accessToken: tokenSet.access_token });
  } catch {
    if (switching || opts.org !== undefined) {
      throw new CliError(
        'Could not verify the workspace because userinfo is unreachable. Previous credentials kept; try again.',
        ExitCode.NETWORK,
        'network',
      );
    }
  }
  if (opts.org !== undefined && userinfo && !matchesOrg(opts.org, userinfo)) {
    throw new CliError(
      `Token is bound to workspace ${formatOrg(userinfo.org_name, userinfo.org_id)}, but requested "${opts.org}". ` +
      `Retry: every org switch --org "${opts.org}" and pick that workspace in the consent page. ` +
      'Use the workspace id as the unambiguous form.',
      ExitCode.GENERIC,
      'org_mismatch',
    );
  }

  const store = deps.store ?? await createTokenStore();
  const previous = await store.get(environmentKey);
  try {
    await store.set(environmentKey, tokenSet);
  } catch (err) {
    try {
      if (previous) await store.set(environmentKey, previous);
      else await store.delete(environmentKey);
    } catch {
      errorOutput.write('Warning: could not restore previous credentials after a storage failure.\n');
    }
    throw err;
  }

  if (userinfo) {
    try {
      await writeUserInfoCache(baseUrl, userinfo);
    } catch {
      // A failed write may have left the old identity behind. Remove it if possible.
      await invalidateUserInfoCache(baseUrl).catch(() => undefined);
      errorOutput.write('Warning: logged in, but could not cache the current identity.\n');
    }
  } else {
    await invalidateUserInfoCache(baseUrl).catch(() => {
      errorOutput.write('Warning: could not invalidate the previous identity cache.\n');
    });
    errorOutput.write('Warning: logged in, but userinfo is unreachable; workspace identity is unknown.\n');
  }

  const identity = identityFromToken(tokenSet.access_token);
  return {
    logged_in: true,
    issuer: tokenSet.issuer,
    subject: userinfo?.user_id ?? identity.subject,
    email: userinfo?.email ?? identity.email,
    storage_backend: store.backend,
    every_token: false,
    user_id: userinfo?.user_id ?? null,
    org_id: userinfo?.org_id ?? null,
    org_slug: userinfo?.org_slug ?? null,
    org_name: userinfo?.org_name ?? null,
  };
}

export async function runBrowserLogin(
  opts: AuthCommandOptions,
  deps: BrowserLoginDependencies = {},
): Promise<void> {
  const data = await completeBrowserLogin(opts, deps);
  emitLogin(data, opts, deps.output, deps.errorOutput);
  await maybeOfferSkillAfterLogin({ json: opts.json, ...deps });
}

export async function orgSwitchCommand(
  opts: AuthCommandOptions = {},
  deps: BrowserLoginDependencies = {},
): Promise<void> {
  validateBrowserLogin(opts, true);
  if (!(deps.output ?? process.stdout).isTTY) {
    throw new CliError('org switch requires a browser and an interactive terminal', ExitCode.AUTH, 'auth');
  }
  const baseUrl = resolveBaseUrl({ staging: opts.staging });
  const previous = await readCachedUserInfo(baseUrl, { allowStale: true }).catch(() => undefined);
  const login = await completeBrowserLogin(opts, deps, true);
  const data = {
    switched: true,
    org_id: login.org_id,
    org_slug: login.org_slug,
    org_name: login.org_name,
    previous_org_id: previous?.org_id ?? null,
    environment: environmentNameForBaseUrl(baseUrl),
  };
  if (opts.json) emit(data, { json: true, staging: opts.staging });
  else (deps.output ?? process.stdout).write(
    `Switched to ${formatOrg(data.org_name, data.org_id)} · ${login.email ?? 'unknown'}\n`,
  );
  await maybeOfferSkillAfterLogin({ json: opts.json, ...deps });
}

export async function createAccountFlow(
  opts: CreateAccountFlowOptions = {},
): Promise<void> {
  validateBrowserLogin(opts);
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const errorOutput = opts.errorOutput ?? process.stderr;
  const signupUrl = signupUrlForBaseUrl(resolveBaseUrl({ staging: opts.staging }));

  errorOutput.write(
    `Opening the Every sign-up page:\n  ${signupUrl}\nCreate your account and set up your workspace in the browser.\n`,
  );
  await (opts.openBrowser ?? openBrowserDefault)(signupUrl);

  const rl = createInterface({ input, output: errorOutput, terminal: false });
  try {
    await rl.question("When you're done, press Enter to connect your terminal... ");
  } finally {
    rl.close();
  }

  const runLogin = opts.runLogin ?? (() => runBrowserLogin(opts, { input, output, errorOutput }));
  await runLogin();
}

async function promptForLoggedOutAction(): Promise<'login' | 'createAccount'> {
  process.stderr.write(
    [
      "You're not signed in to Every.",
      '  1) Log in — I already have an account',
      '  2) Create an account',
    ].join('\n') + '\n',
  );

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: false,
  });
  try {
    const answer = (await rl.question('Choose [1]: ')).trim();
    if (answer === '2') return 'createAccount';
    if (answer !== '' && answer !== '1') {
      process.stderr.write('Unrecognized choice; continuing with log in.\n');
    }
    return 'login';
  } finally {
    rl.close();
  }
}

export async function loginCommand(opts: AuthCommandOptions = {}): Promise<void> {
  validateBrowserLogin(opts);
  if (process.env.EVERY_TOKEN) {
    const identity = identityFromToken(process.env.EVERY_TOKEN);
    const data: LoginResult = {
      logged_in: true,
      issuer: null,
      subject: identity.subject,
      email: identity.email,
      storage_backend: null,
      every_token: true,
      user_id: null,
      org_id: null,
      org_slug: null,
      org_name: null,
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

  if (opts.createAccount) {
    // The pause-for-signup prompt reads stdin; a piped/closed stdin would hang there.
    if (process.stdin.isTTY !== true) {
      throw new CliError(
        'create-account requires an interactive terminal; set EVERY_TOKEN for headless use',
        ExitCode.AUTH,
        'auth',
      );
    }
    await createAccountFlow(opts);
    return;
  }

  const baseUrl = resolveBaseUrl({ staging: opts.staging });
  if (
    !opts.json &&
    !opts.skipMenu &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    process.stderr.isTTY === true &&
    !(await getAuthStatus({ baseUrl })).logged_in
  ) {
    const action = await promptForLoggedOutAction();
    if (action === 'createAccount') {
      await createAccountFlow(opts);
      return;
    }
  }

  await runBrowserLogin(opts);
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

/**
 * `every whoami` for an org API key.
 *
 * The key is verified where it is actually valid — the MCP server — instead of
 * at the Clerk userinfo endpoint, which knows nothing about it and answers 401.
 * `tools/list` is the right probe: it needs no scope of its own, and the server
 * filters it to the key's scopes, so the count doubles as "what this key can
 * do". A rejected key surfaces its own reason from mcpCall, never a login
 * prompt. Identity fields stay null because no reachable surface reports them
 * for a key — never guessed from a cache written by some other credential.
 */
async function apiKeyWhoami(baseUrl: string, opts: AuthCommandOptions): Promise<void> {
  const token = await getToken({ baseUrl });
  const liveness = await verifyMcpLiveness(baseUrl, token);
  const data: WhoamiResult = {
    authenticated: liveness.authenticated,
    auth_method: 'api_key',
    user_id: null,
    subject: null,
    email: null,
    name: null,
    org_id: null,
    org_slug: null,
    org_name: null,
    environment: environmentNameForBaseUrl(baseUrl),
    base_url: baseUrl,
    tools: liveness.tools,
  };

  emitCommand(data, apiKeyWhoamiHuman(data), opts);
  await maybeShowSkillHint();
}

export async function whoamiCommand(opts: AuthCommandOptions = {}): Promise<void> {
  const baseUrl = resolveBaseUrl({ staging: opts.staging });
  if (activeCredentialIsApiKey()) return apiKeyWhoami(baseUrl, opts);

  const userinfo = await fetchUserInfo({ baseUrl });
  const token = await getToken({ baseUrl });
  const liveness = await verifyMcpLiveness(baseUrl, token);
  const environment = environmentNameForBaseUrl(baseUrl);
  const data: WhoamiResult = {
    authenticated: liveness.authenticated,
    auth_method: 'oauth',
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
  if (activeCredentialIsApiKey()) {
    // Still verify the credential against the MCP server, so a dead key reports
    // itself as rejected rather than quietly returning an empty workspace.
    await verifyMcpLiveness(baseUrl, await getToken({ baseUrl }));
    const org: OrgResult = {
      auth_method: 'api_key',
      org_id: null,
      org_slug: null,
      org_name: null,
      organization_id: null,
      organization_slug: null,
      organization_name: null,
    };
    emitCommand(org, apiKeyOrgHuman(environmentNameForBaseUrl(baseUrl), baseUrl), opts);
    return;
  }

  const org = orgFromUserInfo(await fetchUserInfo({ baseUrl }));
  emitCommand(org, orgHuman(org), opts);
}

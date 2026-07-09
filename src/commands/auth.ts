import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
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

  if (
    opts.json ||
    input.isTTY !== true ||
    output.isTTY !== true ||
    (opts.errorOutput === undefined && process.stderr.isTTY !== true)
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
  await maybeOfferSkillAfterLogin({ json: opts.json });
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

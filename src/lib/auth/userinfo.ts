import { mkdir, readFile, rename, stat, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDir } from '../config.js';
import { CliError } from '../errors.js';
import { ExitCode } from '../exit-codes.js';
import { discoverOAuth, fetchJsonWithTimeout, HttpStatusError } from './discovery.js';
import {
  environmentKeyForBaseUrl,
  getToken,
  resolveAuthTarget,
  TokenStore,
} from './tokens.js';

const USERINFO_TIMEOUT_MS = 10_000;
const USERINFO_CACHE_TTL_MS = 10 * 60 * 1000;

export interface UserInfo {
  user_id: string | null;
  email: string | null;
  name: string | null;
  org_id: string | null;
  org_slug: string | null;
  org_name: string | null;
}

interface OpenIdConfiguration {
  userinfo_endpoint?: unknown;
}

interface UserInfoCacheFile {
  fetched_at: string | number;
  userinfo: UserInfo;
}

export interface FetchUserInfoOptions {
  staging?: boolean;
  baseUrl?: string;
  forceRefresh?: boolean;
  store?: TokenStore;
  now?: () => number;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function safeEnvironmentKey(baseUrl: string): string {
  return environmentKeyForBaseUrl(baseUrl).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function userInfoCacheFilePath(baseUrl: string): string {
  return path.join(getConfigDir(), 'cache', `userinfo-${safeEnvironmentKey(baseUrl)}.json`);
}

function fetchedAtMs(value: string | number): number {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeUserInfo(value: Record<string, unknown>): UserInfo {
  return {
    user_id: stringOrNull(value.user_id) ?? stringOrNull(value.sub),
    email: stringOrNull(value.email),
    name: stringOrNull(value.name),
    org_id: stringOrNull(value.org_id),
    org_slug: stringOrNull(value.org_slug),
    org_name: stringOrNull(value.org_name),
  };
}

function isUserInfo(value: unknown): value is UserInfo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    'user_id' in candidate &&
    'email' in candidate &&
    'name' in candidate &&
    'org_id' in candidate &&
    'org_slug' in candidate &&
    'org_name' in candidate
  );
}

export async function readCachedUserInfo(
  baseUrl: string,
  {
    allowStale = false,
    now = Date.now,
  }: { allowStale?: boolean; now?: () => number } = {},
): Promise<UserInfo | undefined> {
  let parsed: UserInfoCacheFile;
  try {
    parsed = JSON.parse(await readFile(userInfoCacheFilePath(baseUrl), 'utf8')) as UserInfoCacheFile;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }

  if (!isUserInfo(parsed.userinfo)) return undefined;
  if (!allowStale && now() - fetchedAtMs(parsed.fetched_at) > USERINFO_CACHE_TTL_MS) {
    return undefined;
  }

  return parsed.userinfo;
}

async function writeUserInfoCache(baseUrl: string, userinfo: UserInfo): Promise<void> {
  const filePath = userInfoCacheFilePath(baseUrl);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(
    tempPath,
    JSON.stringify({ fetched_at: new Date().toISOString(), userinfo }, null, 2),
    { mode: 0o600 },
  );
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

export async function userInfoCacheFileMode(baseUrl: string): Promise<number | undefined> {
  try {
    return (await stat(userInfoCacheFilePath(baseUrl))).mode & 0o777;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

async function fetchOpenIdConfiguration(issuer: string): Promise<OpenIdConfiguration> {
  const url = `${trimTrailingSlash(issuer)}/.well-known/openid-configuration`;
  const metadata = await fetchJsonWithTimeout<OpenIdConfiguration>(
    url,
    { headers: { accept: 'application/json' } },
    USERINFO_TIMEOUT_MS,
  );

  if (typeof metadata.userinfo_endpoint !== 'string' || metadata.userinfo_endpoint.length === 0) {
    throw new CliError(
      `OpenID configuration at ${url} did not include userinfo_endpoint`,
      ExitCode.NETWORK,
      'network',
    );
  }

  return metadata;
}

export async function fetchUserInfo(opts: FetchUserInfoOptions = {}): Promise<UserInfo> {
  const { baseUrl } = resolveAuthTarget(opts);
  const token = await getToken({ baseUrl, store: opts.store, now: opts.now });
  if (!opts.forceRefresh) {
    const cached = await readCachedUserInfo(baseUrl, { now: opts.now }).catch(() => undefined);
    if (cached) return cached;
  }

  const discovery = await discoverOAuth(baseUrl);
  const openid = await fetchOpenIdConfiguration(discovery.authServer.issuer);

  let raw: Record<string, unknown>;
  try {
    raw = await fetchJsonWithTimeout<Record<string, unknown>>(
      openid.userinfo_endpoint as string,
      {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
      },
      USERINFO_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof HttpStatusError && err.status === 401) {
      throw new CliError('Not logged in. Run \'every login\'.', ExitCode.AUTH, 'auth');
    }
    if (err instanceof HttpStatusError) {
      throw new CliError(
        `User info request failed for ${err.url}: HTTP ${err.status}`,
        ExitCode.NETWORK,
        'network',
      );
    }
    throw err;
  }

  const userinfo = normalizeUserInfo(raw);
  await writeUserInfoCache(baseUrl, userinfo);
  return userinfo;
}

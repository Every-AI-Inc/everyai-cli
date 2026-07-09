import { mkdir, readFile, rename, stat, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDir, PROD_BASE_URL, resolveBaseUrl, STAGING_BASE_URL } from '../config.js';
import { CliError } from '../errors.js';
import { ExitCode } from '../exit-codes.js';
import { DEFAULT_SCOPE } from './dcr.js';
import { discoverOAuth, fetchJsonWithTimeout, HttpStatusError } from './discovery.js';
import { decodeJwtClaims } from './jwt.js';

const TOKEN_TIMEOUT_MS = 10_000;
const KEYRING_SERVICE = 'everyai-cli';

export interface StoredTokenSet {
  issuer: string;
  client_id: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope: string;
}

export interface TokenStore {
  backend: 'keyring' | 'file';
  get(environmentKey: string): Promise<StoredTokenSet | undefined>;
  set(environmentKey: string, tokens: StoredTokenSet): Promise<void>;
  delete(environmentKey: string): Promise<void>;
}

interface TokenFile {
  tokens: Record<string, StoredTokenSet>;
}

interface KeyringIndexFile {
  accounts: Record<string, string>;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface GetTokenOptions {
  staging?: boolean;
  baseUrl?: string;
  store?: TokenStore;
  now?: () => number;
}

export interface AuthStatus {
  logged_in: boolean;
  environment: string;
  base_url: string;
  storage_backend: 'keyring' | 'file';
  every_token: boolean;
  issuer: string | null;
  expires_at: number | null;
  expires_in_seconds: number | null;
  expires: string | null;
  refresh_token: boolean;
}

function tokenPath(): string {
  return path.join(getConfigDir(), 'tokens.json');
}

function keyringIndexPath(): string {
  return path.join(getConfigDir(), 'keyring-index.json');
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function environmentKeyForBaseUrl(baseUrl: string): string {
  const normalized = trimTrailingSlash(baseUrl);
  if (normalized === trimTrailingSlash(PROD_BASE_URL)) return 'prod';
  if (normalized === trimTrailingSlash(STAGING_BASE_URL)) return 'staging';
  return `custom:${normalized}`;
}

export function resolveAuthTarget(opts: { staging?: boolean; baseUrl?: string } = {}): {
  baseUrl: string;
  environmentKey: string;
} {
  const baseUrl = trimTrailingSlash(opts.baseUrl ?? resolveBaseUrl({ staging: opts.staging }));
  return { baseUrl, environmentKey: environmentKeyForBaseUrl(baseUrl) };
}

async function readTokenFile(filePath: string): Promise<TokenFile> {
  try {
    const text = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(text) as TokenFile;
    return {
      tokens: parsed && typeof parsed.tokens === 'object' && parsed.tokens ? parsed.tokens : {},
    };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { tokens: {} };
    }
    throw err;
  }
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

export class FileStore implements TokenStore {
  readonly backend = 'file' as const;

  constructor(private readonly filePath = tokenPath()) {}

  async get(environmentKey: string): Promise<StoredTokenSet | undefined> {
    const file = await readTokenFile(this.filePath);
    return file.tokens[environmentKey];
  }

  async set(environmentKey: string, tokens: StoredTokenSet): Promise<void> {
    const file = await readTokenFile(this.filePath);
    file.tokens[environmentKey] = tokens;
    await writePrivateJson(this.filePath, file);
  }

  async delete(environmentKey: string): Promise<void> {
    const file = await readTokenFile(this.filePath);
    if (!(environmentKey in file.tokens)) return;
    delete file.tokens[environmentKey];
    await writePrivateJson(this.filePath, file);
  }

  async fileMode(): Promise<number | undefined> {
    try {
      return (await stat(this.filePath)).mode & 0o777;
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }
}

function keyringAccountForIssuer(issuer: string): string {
  return new URL(issuer).host;
}

async function readKeyringIndex(filePath: string): Promise<KeyringIndexFile> {
  try {
    const text = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(text) as KeyringIndexFile;
    return {
      accounts: parsed && typeof parsed.accounts === 'object' && parsed.accounts ? parsed.accounts : {},
    };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { accounts: {} };
    }
    throw err;
  }
}

type KeyringEntry = {
  getPassword(): string | null | undefined | Promise<string | null | undefined>;
  setPassword(password: string): void | Promise<void>;
  deletePassword(): void | Promise<void>;
};

type KeyringModule = {
  Entry: new (service: string, account: string) => KeyringEntry;
};

async function loadKeyringModule(): Promise<KeyringModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<KeyringModule>;
  return dynamicImport('@napi-rs/keyring');
}

export class KeyringStore implements TokenStore {
  readonly backend = 'keyring' as const;

  private modulePromise?: Promise<KeyringModule>;

  constructor(private readonly indexPath = keyringIndexPath()) {}

  static async createAvailable(): Promise<KeyringStore | undefined> {
    const store = new KeyringStore();
    try {
      await store.smokeTest();
      return store;
    } catch {
      return undefined;
    }
  }

  private async keyring(): Promise<KeyringModule> {
    this.modulePromise ??= loadKeyringModule();
    return this.modulePromise;
  }

  private async entry(account: string): Promise<KeyringEntry> {
    const keyring = await this.keyring();
    return new keyring.Entry(KEYRING_SERVICE, account);
  }

  private async smokeTest(): Promise<void> {
    const account = `_healthcheck:${process.pid}:${Date.now()}`;
    const entry = await this.entry(account);
    await entry.setPassword('ok');
    const password = await entry.getPassword();
    await entry.deletePassword();
    if (password !== 'ok') throw new Error('keyring healthcheck failed');
  }

  async get(environmentKey: string): Promise<StoredTokenSet | undefined> {
    const index = await readKeyringIndex(this.indexPath);
    const account = index.accounts[environmentKey];
    if (!account) return undefined;

    const password = await (await this.entry(account)).getPassword();
    if (!password) return undefined;
    return JSON.parse(password) as StoredTokenSet;
  }

  async set(environmentKey: string, tokens: StoredTokenSet): Promise<void> {
    const account = keyringAccountForIssuer(tokens.issuer);
    await (await this.entry(account)).setPassword(JSON.stringify(tokens));

    const index = await readKeyringIndex(this.indexPath);
    index.accounts[environmentKey] = account;
    await writePrivateJson(this.indexPath, index);
  }

  async delete(environmentKey: string): Promise<void> {
    const index = await readKeyringIndex(this.indexPath);
    const account = index.accounts[environmentKey];
    if (account) {
      try {
        await (await this.entry(account)).deletePassword();
      } catch {
        // Logout is idempotent; a missing native keychain item is already logged out.
      }
    }

    if (environmentKey in index.accounts) {
      delete index.accounts[environmentKey];
      await writePrivateJson(this.indexPath, index);
    }
  }
}

export async function createTokenStore(): Promise<TokenStore> {
  if (process.env.EVERYAI_FORCE_FILE_STORE === '1') return new FileStore();
  const keyring = await KeyringStore.createAvailable();
  return keyring ?? new FileStore();
}

export async function deleteTokenFromAllStores(environmentKey: string): Promise<void> {
  const fileStore = new FileStore();
  await fileStore.delete(environmentKey);

  const keyring = await KeyringStore.createAvailable();
  if (keyring) await keyring.delete(environmentKey);
}

function nowSeconds(now: () => number): number {
  return Math.floor(now() / 1000);
}

function expiresAtFromResponse(response: TokenResponse, now: () => number): number {
  const expiresIn = typeof response.expires_in === 'number' ? response.expires_in : 0;
  return nowSeconds(now) + expiresIn;
}

function assertAccessToken(response: TokenResponse): asserts response is TokenResponse & {
  access_token: string;
} {
  if (!response.access_token) {
    throw new CliError('OAuth token response did not include access_token', ExitCode.AUTH, 'auth');
  }
}

async function refreshToken(
  baseUrl: string,
  environmentKey: string,
  store: TokenStore,
  existing: StoredTokenSet,
  now: () => number,
): Promise<string> {
  const discovery = await discoverOAuth(baseUrl);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: existing.refresh_token ?? '',
    client_id: existing.client_id,
  });

  let response: TokenResponse;
  try {
    response = await fetchJsonWithTimeout<TokenResponse>(
      discovery.authServer.token_endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
      },
      TOKEN_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof HttpStatusError) {
      throw new CliError('Session expired. Run \'every login\'.', ExitCode.AUTH, 'auth');
    }
    if (err instanceof CliError && err.code === 'network') throw err;
    throw new CliError('Session expired. Run \'every login\'.', ExitCode.AUTH, 'auth');
  }

  assertAccessToken(response);

  const refreshed: StoredTokenSet = {
    issuer: existing.issuer,
    client_id: existing.client_id,
    access_token: response.access_token,
    refresh_token: response.refresh_token ?? existing.refresh_token,
    expires_at: expiresAtFromResponse(response, now),
    scope: response.scope ?? existing.scope,
  };

  await store.set(environmentKey, refreshed);
  return refreshed.access_token;
}

export async function getToken(opts: GetTokenOptions = {}): Promise<string> {
  if (process.env.EVERY_TOKEN) return process.env.EVERY_TOKEN;

  const { baseUrl, environmentKey } = resolveAuthTarget(opts);
  const store = opts.store ?? (await createTokenStore());
  const tokenSet = await store.get(environmentKey);
  if (!tokenSet) {
    throw new CliError('Not logged in. Run \'every login\'.', ExitCode.AUTH, 'auth');
  }

  const now = opts.now ?? Date.now;
  if (tokenSet.expires_at - 60 > nowSeconds(now)) return tokenSet.access_token;
  if (tokenSet.refresh_token) {
    return refreshToken(baseUrl, environmentKey, store, tokenSet, now);
  }

  throw new CliError('Not logged in. Run \'every login\'.', ExitCode.AUTH, 'auth');
}

export function toStoredTokenSet(params: {
  issuer: string;
  client_id: string;
  response: TokenResponse;
  now?: () => number;
}): StoredTokenSet {
  assertAccessToken(params.response);
  return {
    issuer: params.issuer,
    client_id: params.client_id,
    access_token: params.response.access_token,
    refresh_token: params.response.refresh_token,
    expires_at: expiresAtFromResponse(params.response, params.now ?? Date.now),
    scope: params.response.scope ?? DEFAULT_SCOPE,
  };
}

export async function getAuthStatus(opts: {
  staging?: boolean;
  baseUrl?: string;
  store?: TokenStore;
  now?: () => number;
} = {}): Promise<AuthStatus> {
  const { baseUrl, environmentKey } = resolveAuthTarget(opts);
  const store = opts.store ?? (await createTokenStore());
  const now = opts.now ?? Date.now;
  const override = process.env.EVERY_TOKEN;
  const stored = await store.get(environmentKey);
  const claims = override ? decodeJwtClaims(override) : null;
  const expiresAt = override ? claims?.exp : stored?.expires_at;
  const expiresIn = typeof expiresAt === 'number' ? expiresAt - nowSeconds(now) : null;

  return {
    logged_in: Boolean(override || stored),
    environment: environmentKey,
    base_url: baseUrl,
    storage_backend: store.backend,
    every_token: Boolean(override),
    issuer: stored?.issuer ?? null,
    expires_at: typeof expiresAt === 'number' ? expiresAt : null,
    expires_in_seconds: expiresIn,
    expires: expiresIn === null ? null : formatRelativeExpiry(expiresIn),
    refresh_token: Boolean(stored?.refresh_token),
  };
}

export function formatRelativeExpiry(seconds: number): string {
  const abs = Math.abs(seconds);
  const unit =
    abs >= 86_400
      ? { name: 'd', value: Math.round(abs / 86_400) }
      : abs >= 3_600
        ? { name: 'h', value: Math.round(abs / 3_600) }
        : abs >= 60
          ? { name: 'm', value: Math.round(abs / 60) }
          : { name: 's', value: abs };
  return seconds >= 0 ? `in ${unit.value}${unit.name}` : `${unit.value}${unit.name} ago`;
}

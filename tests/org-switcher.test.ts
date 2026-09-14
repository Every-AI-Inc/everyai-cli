import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeBrowserLogin, createAccountFlow, matchesOrg, orgCommand,
  orgSwitchCommand, runBrowserLogin, whoamiCommand,
} from '../src/commands/auth';
import { loginFlow } from '../src/lib/auth/flow';
import { clearDiscoveryCache } from '../src/lib/auth/discovery';
import { createTokenStore, FileStore, KeyringStore, StoredTokenSet } from '../src/lib/auth/tokens';
import {
  readCachedUserInfo, requestUserInfo, UserInfo, userInfoCacheFilePath, writeUserInfoCache,
} from '../src/lib/auth/userinfo';
import { PROD_BASE_URL, STAGING_BASE_URL } from '../src/lib/config';
import { mockOAuthCallback } from './helpers/mock-oauth-callback';
import { installMockMcpFetch } from './helpers/mock-mcp-fetch.mjs';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, chmod: vi.fn(actual.chmod) };
});

const oldInfo: UserInfo = {
  user_id: 'old-user', email: 'old@example.com', name: 'Old User',
  org_id: 'org_old', org_slug: 'old', org_name: 'Old Workspace',
};
const newInfo: UserInfo = {
  user_id: 'new-user', email: 'new@example.com', name: 'New User',
  org_id: 'org_New', org_slug: 'new-workspace', org_name: 'Café Company',
};
function token(access_token = 'old-token', issuer = PROD_BASE_URL): StoredTokenSet {
  return { issuer, client_id: 'old-client', access_token, expires_at: Date.now() / 1000 + 3600, scope: 'openid' };
}
function capture(isTTY = true) {
  let text = '';
  const output = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } }) as Writable & { isTTY: boolean };
  output.isTTY = isTTY;
  return { output, text: () => text };
}

let dir: string;
let stateFile: string;
let restoreFetch: () => void;
let store: FileStore;
let stdout: ReturnType<typeof capture>;
let stderr: ReturnType<typeof capture>;
let emitted: string;
let callback: ReturnType<typeof mockOAuthCallback>;

async function statePatch(patch: Record<string, unknown>) {
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  await writeFile(stateFile, JSON.stringify({ ...state, ...patch }));
}
function deps() {
  return {
    input: Readable.from([]), output: stdout.output, errorOutput: stderr.output,
    loginFlow: (opts: Parameters<typeof loginFlow>[0]) => loginFlow({
      ...opts, createCallbackServer: callback.createServer, openBrowser: async (url) => { await fetch(url); },
    }),
  };
}

beforeEach(async () => {
  const actualFs = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.chmod).mockImplementation(actualFs.chmod);
  callback = mockOAuthCallback();
  dir = await mkdtemp(path.join(os.tmpdir(), 'every-org-switch-'));
  vi.stubEnv('EVERY_CONFIG_DIR', dir);
  vi.stubEnv('EVERYAI_FORCE_FILE_STORE', '1');
  vi.stubEnv('EVERY_TOKEN', '');
  vi.stubEnv('EVERY_MCP_URL', PROD_BASE_URL);
  vi.stubEnv('EVERY_ENV', 'production');
  stateFile = path.join(dir, 'mock-state.json');
  await writeFile(stateFile, JSON.stringify({ tokenUserInfo: {
    'old-token': oldInfo, 'exchanged-token': newInfo,
  } }));
  restoreFetch = installMockMcpFetch(PROD_BASE_URL, stateFile, callback.visit);
  store = new FileStore();
  await store.set('prod', token());
  await writeUserInfoCache(PROD_BASE_URL, oldInfo);
  await writeFile(path.join(dir, 'hints.json'), JSON.stringify({ skill_hint_shown: true }));
  stdout = capture();
  stderr = capture();
  emitted = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { emitted += String(chunk); return true; });
});

afterEach(async () => {
  restoreFetch();
  clearDiscoveryCache();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('workspace browser completion', () => {
  it('commits plain login despite unreachable userinfo, invalidates stale identity, and warns', async () => {
    await statePatch({ networkFailures: ['/oauth/userinfo'] });
    await expect(runBrowserLogin({ json: true }, deps())).resolves.toBeUndefined();
    expect(JSON.parse(emitted).data).toMatchObject({ logged_in: true, user_id: null, org_id: null, org_slug: null, org_name: null });
    expect((await store.get('prod'))?.access_token).toBe('exchanged-token');
    expect(await readCachedUserInfo(PROD_BASE_URL)).toBeUndefined();
    expect(stderr.text()).toContain('Warning: logged in, but userinfo is unreachable');
  });

  it.each(['login', 'asserted-switch', 'switch'])('preserves token/cache with exit 7 when %s cannot verify userinfo', async (mode) => {
    await statePatch({ networkFailures: ['/oauth/userinfo'] });
    const oldToken = await store.get('prod');
    const cached = await readFile(userInfoCacheFilePath(PROD_BASE_URL), 'utf8');
    const result = mode === 'login'
      ? runBrowserLogin({ org: 'new-workspace' }, deps())
      : orgSwitchCommand(mode === 'switch' ? {} : { org: 'new-workspace' }, deps());
    await expect(result).rejects.toMatchObject({ exitCode: 7, code: 'network' });
    expect(await store.get('prod')).toEqual(oldToken);
    expect(await readFile(userInfoCacheFilePath(PROD_BASE_URL), 'utf8')).toBe(cached);
  });

  it('treats post-commit cache failure as a warning and removes stale identity', async () => {
    const actualChmod = vi.mocked(fs.chmod).getMockImplementation()!;
    vi.mocked(fs.chmod).mockImplementation(async (file, mode) => {
      if (String(file).includes('userinfo-') && String(file).endsWith('.tmp')) {
        throw new Error('cache chmod failed');
      }
      return actualChmod(file, mode);
    });
    await expect(runBrowserLogin({ json: true }, deps())).resolves.toBeUndefined();
    expect((await store.get('prod'))?.access_token).toBe('exchanged-token');
    expect(stderr.text()).toContain('Warning: logged in, but could not cache');
    expect(await readCachedUserInfo(PROD_BASE_URL)).toBeUndefined();
  });

  it('requestUserInfo verifies only the candidate without refreshing stored auth or writing cache', async () => {
    const expired = token();
    expired.expires_at = 1;
    expired.refresh_token = 'must-not-refresh';
    await store.set('prod', expired);
    const cached = await readFile(userInfoCacheFilePath(PROD_BASE_URL), 'utf8');
    expect(await requestUserInfo({ baseUrl: PROD_BASE_URL, accessToken: 'exchanged-token' })).toEqual(newInfo);
    expect(await store.get('prod')).toEqual(expired);
    expect(await readFile(userInfoCacheFilePath(PROD_BASE_URL), 'utf8')).toBe(cached);
  });

  it('isolates staging switches from production tokens and identity', async () => {
    const prodToken = await store.get('prod');
    const prodCache = await readFile(userInfoCacheFilePath(PROD_BASE_URL), 'utf8');
    restoreFetch();
    restoreFetch = installMockMcpFetch(STAGING_BASE_URL, stateFile, callback.visit);
    await orgSwitchCommand({ staging: true, json: true }, deps());
    expect(JSON.parse(emitted)).toMatchObject({ env: 'staging', data: { previous_org_id: null, environment: 'staging' } });
    expect((await store.get('staging'))?.access_token).toBe('exchanged-token');
    expect(await store.get('prod')).toEqual(prodToken);
    expect(await readFile(userInfoCacheFilePath(PROD_BASE_URL), 'utf8')).toBe(prodCache);
    expect(await readCachedUserInfo(STAGING_BASE_URL)).toEqual(newInfo);
  });
  it('switches tokens and immediately updates org/whoami; authorize parameters exclude organization_id', async () => {
    await orgSwitchCommand({ org: 'NEW-WORKSPACE', json: true }, deps());
    expect(JSON.parse(emitted)).toEqual({ ok: true, env: 'production', schema_version: 1, data: {
      switched: true, org_id: newInfo.org_id, org_slug: newInfo.org_slug,
      org_name: newInfo.org_name, previous_org_id: oldInfo.org_id, environment: 'production',
    } });
    expect((await store.get('prod'))?.access_token).toBe('exchanged-token');
    expect(await readCachedUserInfo(PROD_BASE_URL)).toEqual(newInfo);
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    const authorize = new URL(state.authorizationRequests[0]);
    expect([...authorize.searchParams.keys()].sort()).toEqual([
      'client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'response_type', 'scope', 'state',
    ]);
    expect(authorize.searchParams.has('organization_id')).toBe(false);
    emitted = '';
    await orgCommand({ json: true });
    expect(JSON.parse(emitted).data.org_id).toBe(newInfo.org_id);
    emitted = '';
    await whoamiCommand({ json: true });
    expect(JSON.parse(emitted).data).toMatchObject({ authenticated: true, org_id: newInfo.org_id, email: newInfo.email });
    expect(JSON.parse(await readFile(stateFile, 'utf8')).userinfoCalls).toBe(1);
    expect(stderr.text()).toContain('pick "NEW-WORKSPACE"');
  });

  it('discards a verified mismatch and preserves the old token and exact cache bytes', async () => {
    const cached = await readFile(userInfoCacheFilePath(PROD_BASE_URL), 'utf8');
    const previous = await store.get('prod');
    const result = orgSwitchCommand({ org: 'Old Workspace', json: true }, deps());
    await expect(result).rejects.toMatchObject({
      exitCode: 1, code: 'org_mismatch', message: expect.stringContaining('Café Company (org_New)'),
    });
    await expect(result).rejects.toThrow('every org switch --org "Old Workspace"');
    await expect(result).rejects.toThrow('id as the unambiguous form');
    expect(await store.get('prod')).toEqual(previous);
    expect(await readFile(userInfoCacheFilePath(PROD_BASE_URL), 'utf8')).toBe(cached);
    expect(emitted).toBe('');
  });

  it('reports additive login JSON fields and preserves existing keys', async () => {
    await runBrowserLogin({ json: true }, deps());
    expect(JSON.parse(emitted)).toEqual({ ok: true, env: 'production', schema_version: 1, data: {
      logged_in: true, issuer: PROD_BASE_URL, subject: newInfo.user_id,
      email: newInfo.email, storage_backend: 'file', every_token: false,
      user_id: newInfo.user_id, org_id: newInfo.org_id, org_slug: newInfo.org_slug, org_name: newInfo.org_name,
    } });
    expect(stderr.text()).toContain("Pick the workspace in the consent page's selector.");
  });

  it('uses shared completion after signup and reports the workspace in human output', async () => {
    const input = new Readable({ read() {} });
    await createAccountFlow({
      input, output: stdout.output, errorOutput: stderr.output,
      openBrowser: async () => { setImmediate(() => input.push('\n')); },
      runLogin: () => runBrowserLogin({}, deps()),
    });
    expect(stdout.text()).toContain('Logged in as new@example.com · workspace Café Company (org_New)\nSwitch workspace: every org switch');
    expect(await readCachedUserInfo(PROD_BASE_URL)).toEqual(newInfo);
  });
});

describe('org assertion boundaries', () => {
  it.each([
    ['org_New', true], ['org_new', false], [' org_New ', false],
    ['NEW-WORKSPACE', true], [' new-workspace ', false],
    ['  CAFE\u0301 COMPANY  ', true], ['Other Company', false],
  ])('matches %j: %s', (target, expected) => {
    expect(matchesOrg(target as string, newInfo)).toBe(expected);
  });

  it.each(['', ' \t\n'])('rejects %j before opening any browser', async (org) => {
    expect(() => matchesOrg(org, newInfo)).toThrowError(expect.objectContaining({ exitCode: 2, code: 'usage' }));
    const browser = vi.fn();
    await expect(completeBrowserLogin({ org }, { loginFlow: browser })).rejects.toMatchObject({ exitCode: 2 });
    expect(browser).not.toHaveBeenCalled();
  });
});

describe('storage rollback after partial writes', () => {
  it.each([
    ['file', true], ['file', false], ['keyring', true], ['keyring', false],
  ] as const)('restores %s storage with previous token: %s', async (backend, hasPrevious) => {
    let targetStore = await createTokenStore();
    expect(targetStore.backend).toBe('file');
    if (backend === 'keyring') {
      const passwords = new Map<string, string>();
      const keyring = new KeyringStore();
      // Exercise real KeyringStore ordering with a native keychain stub.
      vi.spyOn(keyring as unknown as { keyring(): Promise<unknown> }, 'keyring').mockResolvedValue({
        Entry: class {
          constructor(_service: string, private account: string) {}
          getPassword() { return passwords.get(this.account); }
          setPassword(value: string) { passwords.set(this.account, value); }
          deletePassword() { passwords.delete(this.account); }
        },
      });
      targetStore = keyring;
      await targetStore.set('prod', token());
    }
    if (!hasPrevious) await targetStore.delete('prod');
    const previous = await targetStore.get('prod');
    const cached = await readFile(userInfoCacheFilePath(PROD_BASE_URL), 'utf8');
    const originalChmod = vi.mocked(fs.chmod).getMockImplementation()!;
    const failure = new Error('injected storage failure');
    let failed = false;
    vi.mocked(fs.chmod).mockImplementation(async (file, mode) => {
      const shouldFail = backend === 'file'
        ? String(file) === path.join(dir, 'tokens.json')
        : String(file).includes('keyring-index.json') && String(file).endsWith('.tmp');
      if (!failed && shouldFail) { failed = true; throw failure; }
      return originalChmod(file, mode);
    });
    await expect(completeBrowserLogin({}, {
      ...deps(), store: targetStore, loginFlow: async () => token('exchanged-token'),
    })).rejects.toBe(failure);
    expect(failed).toBe(true);
    expect(await targetStore.get('prod')).toEqual(previous);
    expect(await readFile(userInfoCacheFilePath(PROD_BASE_URL), 'utf8')).toBe(cached);
  });
});

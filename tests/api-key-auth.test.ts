import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgCommand, whoamiCommand } from '../src/commands/auth';
import { invokeToolCall } from '../src/commands/tools';
import { clearDiscoveryCache } from '../src/lib/auth/discovery';
import { getAuthStatus, FileStore } from '../src/lib/auth/tokens';
import { fetchUserInfo, UserInfo, writeUserInfoCache } from '../src/lib/auth/userinfo';
import { isApiKeyToken } from '../src/lib/auth/api-key';
import { mcpCall } from '../src/lib/mcp';
import { PROD_BASE_URL, STAGING_BASE_URL } from '../src/lib/config';
import { ExitCode } from '../src/lib/exit-codes';
import { installMockMcpFetch, INVALID_API_KEY, VALID_API_KEY } from './helpers/mock-mcp-fetch.mjs';

/**
 * Org API keys (`evk_<uuid>.<secret>`) authenticate against the MCP server, not
 * Clerk OAuth. These tests pin the two user-facing consequences: identity
 * resolution must not route a key through the OAuth userinfo endpoint, and a
 * rejected key must not be reported as a missing browser login.
 */

const NOT_LOGGED_IN = "Not logged in. Run 'every login'.";

const oauthInfo: UserInfo = {
  user_id: 'user_123', email: 'person@example.com', name: 'Person Example',
  org_id: 'org_123', org_slug: 'acme', org_name: 'Acme Co',
};

let dir: string;
let stateFile: string;
let restoreFetch: () => void;
let emitted: string;
let stderrText: string;

async function readMockState(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'every-api-key-'));
  vi.stubEnv('EVERY_CONFIG_DIR', dir);
  vi.stubEnv('EVERYAI_FORCE_FILE_STORE', '1');
  vi.stubEnv('EVERY_MCP_URL', PROD_BASE_URL);
  vi.stubEnv('EVERY_ENV', 'production');
  vi.stubEnv('EVERY_TOKEN', VALID_API_KEY);
  stateFile = path.join(dir, 'mock-state.json');
  await writeFile(stateFile, JSON.stringify({ tokenUserInfo: { 'oauth-token': oauthInfo } }));
  restoreFetch = installMockMcpFetch(PROD_BASE_URL, stateFile);
  // Suppress the unrelated first-run skill hint.
  await writeFile(path.join(dir, 'hints.json'), JSON.stringify({ skill_hint_shown: true }));
  emitted = '';
  stderrText = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { emitted += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderrText += String(chunk); return true; });
});

afterEach(async () => {
  restoreFetch();
  clearDiscoveryCache();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('API key detection', () => {
  it.each([
    [VALID_API_KEY, true],
    ['evk_', true],
    ['oat_2abc', false],
    ['eyJhbGciOiJSUzI1NiJ9.e30.sig', false],
    ['', false],
    [undefined, false],
    [null, false],
    ['EVK_upper.case', false],
    [' evk_leading-space.secret', false],
  ])('classifies %j as an API key: %s', (token, expected) => {
    expect(isApiKeyToken(token as string | null | undefined)).toBe(expected);
  });
});

describe('whoami with an org API key', () => {
  it('reports authentication via the API key and never says "not logged in"', async () => {
    await whoamiCommand({ json: true });

    const envelope = JSON.parse(emitted) as { ok: boolean; data: Record<string, unknown> };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({
      authenticated: true,
      auth_method: 'api_key',
      user_id: null,
      subject: null,
      email: null,
      name: null,
      org_id: null,
      org_slug: null,
      org_name: null,
      environment: 'production',
      base_url: PROD_BASE_URL,
      tools: expect.any(Number),
    });
    expect(envelope.data.tools).toBeGreaterThan(0);
    expect(emitted).not.toContain(NOT_LOGGED_IN);
    expect(emitted).not.toContain('every login');
    // The credential itself must never be echoed back.
    expect(emitted).not.toContain(VALID_API_KEY);
  });

  it('verifies the key at the MCP server without ever calling Clerk userinfo', async () => {
    await whoamiCommand({ json: true });

    const state = await readMockState();
    expect(state.userinfoCalls ?? 0).toBe(0);
    expect(state.openidCalls ?? 0).toBe(0);
    expect(state.listCalls).toBe(1);
  });

  it('human output names the API key, the environment and the scoped tool count', async () => {
    await whoamiCommand({});

    expect(emitted).toContain('Authenticated: yes (Every API key)');
    expect(emitted).toContain(`Environment: production (${PROD_BASE_URL})`);
    expect(emitted).toMatch(/Tools: \d+ available to this key/);
    expect(emitted).toContain('Settings → API keys (https://app.every.ai/settings/api-keys)');
    expect(emitted).not.toContain(NOT_LOGGED_IN);
  });

  it('never reports another credential\'s cached identity as the key\'s own', async () => {
    // A browser login earlier on this machine leaves a userinfo cache keyed by
    // base URL alone. It describes a different credential and must not be
    // attributed to the key.
    await writeUserInfoCache(PROD_BASE_URL, oauthInfo);

    await whoamiCommand({ json: true });

    expect(emitted).not.toContain('Acme Co');
    expect(emitted).not.toContain('org_123');
    expect((JSON.parse(emitted) as { data: { org_id: unknown } }).data.org_id).toBeNull();
  });

  it('reports the staging key against the staging environment and settings URL', async () => {
    restoreFetch();
    vi.stubEnv('EVERY_MCP_URL', STAGING_BASE_URL);
    restoreFetch = installMockMcpFetch(STAGING_BASE_URL, stateFile);

    await whoamiCommand({});

    expect(emitted).toContain(`Environment: staging (${STAGING_BASE_URL})`);
    expect(emitted).toContain('https://app.staging.every.ai/settings/api-keys');
  });
});

describe('org with an org API key', () => {
  it('states the workspace is not exposed to keys instead of failing as logged out', async () => {
    await orgCommand({ json: true });

    const envelope = JSON.parse(emitted) as { ok: boolean; data: Record<string, unknown> };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({
      auth_method: 'api_key',
      org_id: null,
      org_slug: null,
      org_name: null,
      organization_id: null,
      organization_slug: null,
      organization_name: null,
    });
    expect((await readMockState()).userinfoCalls ?? 0).toBe(0);
  });

  it('human output explains the binding and omits the switch suggestion a key cannot use', async () => {
    await orgCommand({});

    expect(emitted).toContain('Org: not reported for API keys');
    expect(emitted).toContain('Authenticated: yes (Every API key)');
    expect(emitted).not.toContain('every org switch');
    expect(emitted).not.toContain(NOT_LOGGED_IN);
  });

  it('still rejects a dead key rather than reporting an empty workspace', async () => {
    vi.stubEnv('EVERY_TOKEN', INVALID_API_KEY);

    await expect(orgCommand({ json: true })).rejects.toMatchObject({
      exitCode: ExitCode.AUTH,
      code: 'auth',
      message: expect.stringContaining('Every rejected the API key in EVERY_TOKEN'),
    });
    expect(emitted).toBe('');
  });
});

describe('MCP 401 diagnosis', () => {
  it('names the API key and its real causes, quoting the server reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_token', error_description: 'Invalid or expired token' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )));

    const error = await mcpCall(PROD_BASE_URL, INVALID_API_KEY, 'tools/list').catch((err) => err);

    expect(error).toMatchObject({ exitCode: ExitCode.AUTH, code: 'auth' });
    expect(error.message).toContain('Every rejected the API key in EVERY_TOKEN');
    expect(error.message).toContain('HTTP 401 from https://admin-mcp.every.ai');
    expect(error.message).toContain('server said: Invalid or expired token');
    expect(error.message).toContain('invalid, expired or revoked');
    expect(error.message).toContain('no longer be an admin of its workspace');
    expect(error.message).toContain('https://app.every.ai/settings/api-keys');
    expect(error.message).not.toContain('every login');
    expect(error.message).not.toContain(INVALID_API_KEY);
  });

  it('keeps the login message for an OAuth credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_token', error_description: 'Invalid or expired token' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )));

    await expect(mcpCall(PROD_BASE_URL, 'oat_expired_token', 'tools/list')).rejects.toMatchObject({
      exitCode: ExitCode.AUTH,
      code: 'auth',
      message: NOT_LOGGED_IN,
    });
  });

  it.each([
    ['an unreadable body', 'not json at all'],
    ['a body with no reason field', JSON.stringify({ detail: 'nope' })],
    ['an empty body', ''],
  ])('falls back to its own copy for %s', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 401 })));

    const error = await mcpCall(PROD_BASE_URL, INVALID_API_KEY, 'tools/list').catch((err) => err);

    expect(error.message).toContain('Every rejected the API key in EVERY_TOKEN');
    expect(error.message).toContain('HTTP 401 from https://admin-mcp.every.ai).');
    expect(error.message).not.toContain('server said');
  });

  it('flattens and bounds server copy so it cannot reshape CLI output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error_description: `line one\nline two ${'x'.repeat(400)}` }),
      { status: 401 },
    )));

    const error = await mcpCall(PROD_BASE_URL, INVALID_API_KEY, 'tools/list').catch((err) => err);

    const quoted = error.message.slice(
      error.message.indexOf('server said: ') + 'server said: '.length,
      error.message.indexOf(').'),
    );
    expect(quoted).toContain('line one line two');
    expect(quoted).not.toContain('\n');
    expect(quoted.endsWith('...')).toBe(true);
    expect(quoted.length).toBe(200);
  });

  it('points a staging key at the staging settings page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

    const error = await mcpCall(STAGING_BASE_URL, INVALID_API_KEY, 'tools/list').catch((err) => err);

    expect(error.message).toContain('https://app.staging.every.ai/settings/api-keys');
  });

  it('leaves non-401 statuses classified exactly as before', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 429 })));

    await expect(mcpCall(PROD_BASE_URL, INVALID_API_KEY, 'tools/list')).rejects.toMatchObject({
      exitCode: ExitCode.RATE_LIMIT,
      code: 'rate_limit',
    });
  });
});

describe('other identity-resolving paths', () => {
  it('auth status reports the API key without inventing an expiry from its secret', async () => {
    const status = await getAuthStatus({ baseUrl: PROD_BASE_URL, store: new FileStore() });

    expect(status).toMatchObject({
      logged_in: true,
      every_token: true,
      auth_method: 'api_key',
      expires_at: null,
      expires: null,
      issuer: null,
    });
  });

  it('auth status still classifies a non-key EVERY_TOKEN as oauth', async () => {
    vi.stubEnv('EVERY_TOKEN', 'oat_regular_token');

    await expect(getAuthStatus({ baseUrl: PROD_BASE_URL, store: new FileStore() }))
      .resolves.toMatchObject({ auth_method: 'oauth', every_token: true });
  });

  it('fetchUserInfo refuses a key outright instead of returning a Clerk 401', async () => {
    await expect(fetchUserInfo({ baseUrl: PROD_BASE_URL })).rejects.toMatchObject({
      exitCode: ExitCode.AUTH,
      message: expect.stringContaining('no OAuth user identity'),
    });
    expect((await readMockState()).userinfoCalls ?? 0).toBe(0);
  });

  it('a gated tool call names the key\'s workspace instead of warning about an unknown org', async () => {
    const data = await invokeToolCall('move_deal_stage', { yes: true, json: true }, async () => ({
      deal_id: 'deal-1',
      stage: 'won',
    }));

    expect(data.org).toEqual({ org_id: null, org_name: null });
    expect(stderrText).not.toContain('could not verify target org');
    expect(stderrText).not.toContain(NOT_LOGGED_IN);
    expect((await readMockState()).userinfoCalls ?? 0).toBe(0);
  });
});

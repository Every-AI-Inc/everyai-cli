import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getOrRegisterClient } from '../src/lib/auth/dcr';
import { clearDiscoveryCache, discoverOAuth } from '../src/lib/auth/discovery';
import { exchangeAuthorizationCode } from '../src/lib/auth/flow';
import { createPkceChallenge, createPkcePair } from '../src/lib/auth/pkce';
import {
  deleteTokenFromAllStores,
  environmentKeyForBaseUrl,
  FileStore,
  getToken,
  KeyringStore,
  StoredTokenSet,
} from '../src/lib/auth/tokens';
import {
  fetchUserInfo,
  userInfoCacheFileMode,
} from '../src/lib/auth/userinfo';
import { ExitCode } from '../src/lib/exit-codes';

const ORIGINAL_ENV = {
  EVERY_CONFIG_DIR: process.env.EVERY_CONFIG_DIR,
  EVERY_MCP_URL: process.env.EVERY_MCP_URL,
  EVERY_TOKEN: process.env.EVERY_TOKEN,
  EVERYAI_FORCE_FILE_STORE: process.env.EVERYAI_FORCE_FILE_STORE,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.`;
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

interface MockOAuthServer {
  baseUrl: string;
  registrations: Array<Record<string, unknown>>;
  tokenRequests: URLSearchParams[];
  discoveryRequests: string[];
  openidRequests: string[];
  userinfoRequests: string[];
  close(): Promise<void>;
}

interface MockResponse {
  status: number;
  body: unknown;
}

let fallbackPort = 32_000;

async function createMockOAuthServer(
  opts: { userinfoStatus?: number } = {},
): Promise<MockOAuthServer> {
  const registrations: Array<Record<string, unknown>> = [];
  const tokenRequests: URLSearchParams[] = [];
  const discoveryRequests: string[] = [];
  const openidRequests: string[] = [];
  const userinfoRequests: string[] = [];
  let baseUrl = '';

  function handleMockRequest(
    method: string,
    pathname: string,
    headers: Record<string, string | undefined>,
    bodyText: string,
  ): MockResponse {
    if (method === 'GET' && pathname === '/.well-known/oauth-protected-resource') {
      discoveryRequests.push(pathname);
      return { status: 200, body: { authorization_servers: [baseUrl] } };
    }

    if (method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
      discoveryRequests.push(pathname);
      return {
        status: 200,
        body: {
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/oauth/token`,
          registration_endpoint: `${baseUrl}/oauth/register`,
          grant_types_supported: ['authorization_code', 'refresh_token'],
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['openid', 'profile', 'email', 'offline_access', 'user:org:read'],
        },
      };
    }

    if (method === 'GET' && pathname === '/.well-known/openid-configuration') {
      openidRequests.push(pathname);
      return { status: 200, body: { userinfo_endpoint: `${baseUrl}/oauth/userinfo` } };
    }

    if (method === 'GET' && pathname === '/oauth/userinfo') {
      userinfoRequests.push(pathname);
      if (opts.userinfoStatus && opts.userinfoStatus !== 200) {
        return { status: opts.userinfoStatus, body: { error: 'userinfo failed' } };
      }
      if (headers.authorization !== 'Bearer live-token') {
        return { status: 401, body: { error: 'unauthorized' } };
      }

      return {
        status: 200,
        body: {
          user_id: 'user_123',
          sub: 'user_123',
          email: 'person@example.com',
          email_verified: true,
          name: 'Person Example',
          given_name: 'Person',
          family_name: 'Example',
          org_id: 'org_123',
          org_slug: 'acme',
          org_name: 'Acme Co',
          picture: null,
          instance_id: 'inst_123',
        },
      };
    }

    if (method === 'POST' && pathname === '/oauth/register') {
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      registrations.push(body);
      return {
        status: 200,
        body: {
          client_id: `client-${registrations.length}`,
          redirect_uris: body.redirect_uris,
        },
      };
    }

    if (method === 'POST' && pathname === '/oauth/token') {
      const params = new URLSearchParams(bodyText);
      tokenRequests.push(params);

      if (params.get('grant_type') === 'refresh_token') {
        return {
          status: 200,
          body: {
            access_token: jwt({
              sub: 'user_refreshed',
              email: 'refreshed@example.com',
              org_id: 'org_123',
              exp: 1_700_003_600,
            }),
            refresh_token: 'refresh-rotated',
            expires_in: 3_600,
            scope: 'openid profile email offline_access user:org:read',
          },
        };
      }

      return {
        status: 200,
        body: {
          access_token: jwt({
            sub: 'user_123',
            email: 'person@example.com',
            org_id: 'org_123',
            exp: 1_700_003_600,
          }),
          refresh_token: 'refresh-original',
          expires_in: 3_600,
          scope: 'openid profile email offline_access user:org:read',
        },
      };
    }

    if (method === 'POST' && pathname === '/') {
      if (headers.authorization !== 'Bearer live-token') {
        return { status: 401, body: { error: 'unauthorized' } };
      }

      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: 'everyai-cli-whoami',
          result: { tools: [{ name: 'a' }, { name: 'b' }] },
        },
      };
    }

    return { status: 404, body: { error: 'not found' } };
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', baseUrl);
    const mockResponse = handleMockRequest(
      request.method ?? 'GET',
      url.pathname,
      {
        authorization: request.headers.authorization,
      },
      await readRequestBody(request),
    );
    writeJson(response, mockResponse.status, mockResponse.body);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;

    return {
      baseUrl,
      registrations,
      tokenRequests,
      discoveryRequests,
      openidRequests,
      userinfoRequests,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    };
  } catch (err) {
    if (!(err && typeof err === 'object' && 'code' in err && err.code === 'EPERM')) {
      throw err;
    }

    baseUrl = `http://127.0.0.1:${fallbackPort++}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
      );
      if (url.origin !== baseUrl) return originalFetch(input, init);

      const headers = new Headers(init?.headers);
      const rawBody = init?.body;
      const bodyText =
        rawBody instanceof URLSearchParams
          ? rawBody.toString()
          : typeof rawBody === 'string'
            ? rawBody
            : '';
      const mockResponse = handleMockRequest(
        init?.method ?? 'GET',
        url.pathname,
        { authorization: headers.get('authorization') ?? undefined },
        bodyText,
      );

      return new Response(JSON.stringify(mockResponse.body), {
        status: mockResponse.status,
        headers: { 'content-type': 'application/json' },
      });
    };

    return {
      baseUrl,
      registrations,
      tokenRequests,
      discoveryRequests,
      openidRequests,
      userinfoRequests,
      close: async () => {
        globalThis.fetch = originalFetch;
      },
    };
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'everyai-cli-auth-'));
}

function freshToken(overrides: Partial<StoredTokenSet> = {}): StoredTokenSet {
  return {
    issuer: 'https://issuer.example.test',
    client_id: 'client-1',
    access_token: 'cached-access-token',
    refresh_token: 'refresh-original',
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
    scope: 'openid profile email offline_access user:org:read',
    ...overrides,
  };
}

afterEach(() => {
  restoreEnv();
  clearDiscoveryCache();
});

describe('auth discovery and DCR', () => {
  it('parses the protected-resource to authorization-server discovery chain', async () => {
    const server = await createMockOAuthServer();
    try {
      const discovery = await discoverOAuth(server.baseUrl);

      expect(discovery.protectedResource.authorization_servers).toEqual([server.baseUrl]);
      expect(discovery.authServer.issuer).toBe(server.baseUrl);
      expect(discovery.authServer.authorization_endpoint).toBe(`${server.baseUrl}/authorize`);
      expect(discovery.authServer.token_endpoint).toBe(`${server.baseUrl}/oauth/token`);
      expect(server.discoveryRequests).toEqual([
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-authorization-server',
      ]);
    } finally {
      await server.close();
    }
  });

  it('caches DCR clients only when the exact redirect URI matches', async () => {
    const server = await createMockOAuthServer();
    const dir = await tempDir();

    try {
      const discovery = await discoverOAuth(server.baseUrl);
      const filePath = path.join(dir, 'oauth-clients.json');
      const first = await getOrRegisterClient(
        discovery.authServer,
        'http://127.0.0.1:1111/callback',
        { filePath },
      );
      const second = await getOrRegisterClient(
        discovery.authServer,
        'http://127.0.0.1:1111/callback',
        { filePath },
      );
      const third = await getOrRegisterClient(
        discovery.authServer,
        'http://127.0.0.1:2222/callback',
        { filePath },
      );

      expect(first.client_id).toBe('client-1');
      expect(second.client_id).toBe('client-1');
      expect(third.client_id).toBe('client-2');
      expect(server.registrations).toHaveLength(2);
      expect(server.registrations[0]).toMatchObject({
        client_name: 'Every AI CLI',
        redirect_uris: ['http://127.0.0.1:1111/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'openid profile email offline_access user:org:read',
      });
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('userinfo', () => {
  it('fetches Clerk userinfo through OpenID configuration and honors the disk cache TTL', async () => {
    const server = await createMockOAuthServer();
    const dir = await tempDir();
    process.env.EVERY_CONFIG_DIR = dir;
    process.env.EVERYAI_FORCE_FILE_STORE = '1';

    try {
      const environmentKey = environmentKeyForBaseUrl(server.baseUrl);
      const store = new FileStore(path.join(dir, 'tokens.json'));
      await store.set(
        environmentKey,
        freshToken({
          issuer: server.baseUrl,
          access_token: 'live-token',
        }),
      );

      await expect(fetchUserInfo({ baseUrl: server.baseUrl, store })).resolves.toEqual({
        user_id: 'user_123',
        email: 'person@example.com',
        name: 'Person Example',
        org_id: 'org_123',
        org_slug: 'acme',
        org_name: 'Acme Co',
      });
      await expect(fetchUserInfo({ baseUrl: server.baseUrl, store })).resolves.toMatchObject({
        user_id: 'user_123',
        org_id: 'org_123',
      });

      expect(server.openidRequests).toEqual(['/.well-known/openid-configuration']);
      expect(server.userinfoRequests).toEqual(['/oauth/userinfo']);
      expect(await userInfoCacheFileMode(server.baseUrl)).toBe(0o600);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('maps userinfo 401 to the auth exit contract', async () => {
    const server = await createMockOAuthServer({ userinfoStatus: 401 });
    const dir = await tempDir();
    process.env.EVERY_CONFIG_DIR = dir;

    try {
      const environmentKey = environmentKeyForBaseUrl(server.baseUrl);
      const store = new FileStore(path.join(dir, 'tokens.json'));
      await store.set(
        environmentKey,
        freshToken({
          issuer: server.baseUrl,
          access_token: 'live-token',
        }),
      );

      await expect(
        fetchUserInfo({ baseUrl: server.baseUrl, store, forceRefresh: true }),
      ).rejects.toMatchObject({
        exitCode: ExitCode.AUTH,
        code: 'auth',
      });
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('PKCE', () => {
  it('creates a valid S256 challenge for the verifier', () => {
    const pair = createPkcePair();
    const expected = createHash('sha256').update(pair.verifier).digest('base64url');

    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toBe(expected);
    expect(createPkceChallenge(pair.verifier)).toBe(expected);
  });
});

describe('token exchange and storage', () => {
  it('sends code_verifier and no client_secret during authorization-code exchange', async () => {
    const server = await createMockOAuthServer();
    try {
      const discovery = await discoverOAuth(server.baseUrl);
      const tokenSet = await exchangeAuthorizationCode({
        metadata: discovery.authServer,
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:1111/callback',
        code: 'auth-code',
        codeVerifier: 'verifier-123',
        now: () => 1_700_000_000_000,
      });

      expect(tokenSet.access_token).not.toBe('');
      expect(tokenSet.expires_at).toBe(1_700_003_600);
      expect(server.tokenRequests).toHaveLength(1);
      expect(server.tokenRequests[0].get('code_verifier')).toBe('verifier-123');
      expect(server.tokenRequests[0].get('client_id')).toBe('client-1');
      expect(server.tokenRequests[0].has('client_secret')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('returns a cached fresh token without HTTP', async () => {
    const dir = await tempDir();
    try {
      const store = new FileStore(path.join(dir, 'tokens.json'));
      await store.set('custom:http://127.0.0.1:1', freshToken());

      await expect(
        getToken({
          baseUrl: 'http://127.0.0.1:1',
          store,
        }),
      ).resolves.toBe('cached-access-token');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refreshes an expired token and persists a rotated refresh token', async () => {
    const server = await createMockOAuthServer();
    const dir = await tempDir();
    const now = () => 1_700_000_000_000;
    const environmentKey = environmentKeyForBaseUrl(server.baseUrl);

    try {
      const store = new FileStore(path.join(dir, 'tokens.json'));
      await store.set(
        environmentKey,
        freshToken({
          issuer: server.baseUrl,
          access_token: 'expired-access-token',
          expires_at: 1_699_999_000,
        }),
      );

      const refreshed = await getToken({
        baseUrl: server.baseUrl,
        store,
        now,
      });
      const persisted = await store.get(environmentKey);

      expect(refreshed).not.toBe('expired-access-token');
      expect(server.tokenRequests).toHaveLength(1);
      expect(server.tokenRequests[0].get('grant_type')).toBe('refresh_token');
      expect(server.tokenRequests[0].get('refresh_token')).toBe('refresh-original');
      expect(server.tokenRequests[0].has('client_secret')).toBe(false);
      expect(persisted?.refresh_token).toBe('refresh-rotated');
      expect(persisted?.expires_at).toBe(1_700_003_600);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws an AUTH CliError when no stored token exists', async () => {
    const dir = await tempDir();
    try {
      const store = new FileStore(path.join(dir, 'tokens.json'));
      await expect(getToken({ baseUrl: 'http://127.0.0.1:1', store })).rejects.toMatchObject({
        exitCode: ExitCode.AUTH,
        code: 'auth',
        message: 'Not logged in. Run \'every login\'.',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns EVERY_TOKEN verbatim without touching storage or network', async () => {
    process.env.EVERY_TOKEN = 'headless-token';
    const dir = await tempDir();

    try {
      const store = new FileStore(path.join(dir, 'tokens.json'));
      await expect(
        getToken({
          baseUrl: 'http://127.0.0.1:1',
          store,
        }),
      ).resolves.toBe('headless-token');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes FileStore tokens with mode 0600 on create and rewrite', async () => {
    const dir = await tempDir();

    try {
      const store = new FileStore(path.join(dir, 'tokens.json'));
      await store.set('prod', freshToken());
      expect(await store.fileMode()).toBe(0o600);

      await store.set('prod', freshToken({ access_token: 'rewritten' }));
      expect(await store.fileMode()).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deletes tokens idempotently for logout', async () => {
    const dir = await tempDir();
    process.env.EVERY_CONFIG_DIR = dir;
    process.env.EVERYAI_FORCE_FILE_STORE = '1';

    try {
      const store = new FileStore();
      await store.set('prod', freshToken());
      await deleteTokenFromAllStores('prod');
      await deleteTokenFromAllStores('prod');

      await expect(store.get('prod')).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('smoke-tests KeyringStore when the native module is available', async (context) => {
    const store = await KeyringStore.createAvailable();
    if (!store) {
      context.skip();
      return;
    }

    const environmentKey = `custom:keyring-smoke-${process.pid}`;
    await store.set(environmentKey, freshToken({ issuer: 'https://keyring.example.test' }));
    await expect(store.get(environmentKey)).resolves.toMatchObject({
      access_token: 'cached-access-token',
    });
    await store.delete(environmentKey);
    await expect(store.get(environmentKey)).resolves.toBeUndefined();
  });
});

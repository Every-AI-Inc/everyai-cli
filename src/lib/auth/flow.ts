import http from 'node:http';
import { spawn } from 'node:child_process';
import { CliError } from '../errors.js';
import { ExitCode } from '../exit-codes.js';
import { DEFAULT_SCOPE, getOrRegisterClient } from './dcr.js';
import {
  AuthorizationServerMetadata,
  discoverOAuth,
  fetchJsonWithTimeout,
  HttpStatusError,
} from './discovery.js';
import { createPkcePair, createState } from './pkce.js';
import { StoredTokenSet, toStoredTokenSet } from './tokens.js';

const LOGIN_TIMEOUT_MS = 300_000;
const TOKEN_TIMEOUT_MS = 10_000;

interface CallbackResult {
  code: string;
}

export interface LoginFlowOptions {
  baseUrl: string;
  timeoutMs?: number;
  openBrowser?: (url: string) => void | Promise<void>;
  onAuthorizationUrl?: (url: string) => void;
  now?: () => number;
}

export interface TokenExchangeOptions {
  metadata: AuthorizationServerMetadata;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  now?: () => number;
}

function callbackHtml(): string {
  return '<!doctype html><meta charset="utf-8"><title>Every AI CLI</title><main style="font-family: system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; line-height: 1.5;"><h1>You&apos;re logged in</h1><p>Return to your terminal.</p></main>';
}

function callbackErrorHtml(message: string): string {
  const escaped = message
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  return `<!doctype html><meta charset="utf-8"><title>Every AI CLI</title><main style="font-family: system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; line-height: 1.5;"><h1>Login failed</h1><p>${escaped}</p></main>`;
}

function writeHtml(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
}

async function createLoopbackCallbackServer(state: string): Promise<{
  redirectUri: string;
  waitForCallback: Promise<CallbackResult>;
  close: () => Promise<void>;
}> {
  let settle: ((result: CallbackResult) => void) | undefined;
  let reject: ((err: Error) => void) | undefined;

  const waitForCallback = new Promise<CallbackResult>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });

  const server = http.createServer((request, response) => {
    const host = request.headers.host ?? '127.0.0.1';
    const url = new URL(request.url ?? '/', `http://${host}`);

    if (url.pathname !== '/callback') {
      writeHtml(response, 404, callbackErrorHtml('Unknown callback path.'));
      return;
    }

    const returnedState = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (returnedState !== state) {
      writeHtml(response, 400, callbackErrorHtml('The login state did not match.'));
      reject?.(new CliError('OAuth callback state did not match', ExitCode.AUTH, 'auth'));
      return;
    }

    if (error) {
      const description = url.searchParams.get('error_description') ?? error;
      writeHtml(response, 400, callbackErrorHtml(description));
      reject?.(new CliError(`OAuth login failed: ${description}`, ExitCode.AUTH, 'auth'));
      return;
    }

    if (!code) {
      writeHtml(response, 400, callbackErrorHtml('The callback did not include an authorization code.'));
      reject?.(new CliError('OAuth callback did not include a code', ExitCode.AUTH, 'auth'));
      return;
    }

    writeHtml(response, 200, callbackHtml());
    settle?.({ code });
  });

  await new Promise<void>((resolve, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new CliError('Failed to bind OAuth loopback server', ExitCode.NETWORK, 'network');
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCallback,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function buildAuthorizationUrl(params: {
  metadata: AuthorizationServerMetadata;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(params.metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', DEFAULT_SCOPE);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => resolve());
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function exchangeAuthorizationCode(
  opts: TokenExchangeOptions,
): Promise<StoredTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
  });

  let response: unknown;
  try {
    response = await fetchJsonWithTimeout(
      opts.metadata.token_endpoint,
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
      throw new CliError(`OAuth token exchange failed: HTTP ${err.status}`, ExitCode.AUTH, 'auth');
    }
    throw err;
  }

  return toStoredTokenSet({
    issuer: opts.metadata.issuer,
    client_id: opts.clientId,
    response: response as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string },
    now: opts.now,
  });
}

export async function loginFlow(opts: LoginFlowOptions): Promise<StoredTokenSet> {
  const timeoutMs = opts.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const startedAt = Date.now();
  const state = createState();
  const pkce = createPkcePair();
  const loopback = await createLoopbackCallbackServer(state);

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new CliError('Login timed out after 300s', ExitCode.AUTH, 'auth'));
    }, timeoutMs).unref();
  });

  try {
    const discovery = await discoverOAuth(opts.baseUrl);
    const client = await getOrRegisterClient(discovery.authServer, loopback.redirectUri);
    const authorizationUrl = buildAuthorizationUrl({
      metadata: discovery.authServer,
      clientId: client.client_id,
      redirectUri: loopback.redirectUri,
      state,
      codeChallenge: pkce.challenge,
    });

    opts.onAuthorizationUrl?.(authorizationUrl);
    await (opts.openBrowser ?? openBrowser)(authorizationUrl);

    const callback = await Promise.race([loopback.waitForCallback, timeout]);
    const elapsed = Date.now() - startedAt;
    if (elapsed > timeoutMs) {
      throw new CliError('Login timed out after 300s', ExitCode.AUTH, 'auth');
    }

    return await Promise.race([
      exchangeAuthorizationCode({
        metadata: discovery.authServer,
        clientId: client.client_id,
        redirectUri: loopback.redirectUri,
        code: callback.code,
        codeVerifier: pkce.verifier,
        now: opts.now,
      }),
      timeout,
    ]);
  } finally {
    await loopback.close();
  }
}

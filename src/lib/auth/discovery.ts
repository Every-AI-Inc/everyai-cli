import { CliError } from '../errors.js';
import { ExitCode } from '../exit-codes.js';

const DISCOVERY_TIMEOUT_MS = 10_000;

export class HttpStatusError extends CliError {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`Request failed for ${url}: HTTP ${status}`, ExitCode.NETWORK, 'network');
  }
}

export interface ProtectedResourceMetadata {
  authorization_servers: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  grant_types_supported?: string[];
  response_types_supported?: string[];
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

export interface OAuthDiscovery {
  mcpBaseUrl: string;
  protectedResource: ProtectedResourceMetadata;
  authServer: AuthorizationServerMetadata;
}

const discoveryCache = new Map<string, Promise<OAuthDiscovery>>();

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function wellKnownUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlash(baseUrl)}${path}`;
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

export async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new CliError(`Timed out reaching ${url} after ${timeoutMs}ms`, ExitCode.NETWORK, 'network');
    }

    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to reach ${url}: ${detail}`, ExitCode.NETWORK, 'network');
  }

  if (!response.ok) {
    throw new HttpStatusError(url, response.status);
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`Invalid JSON from ${url}: ${detail}`, ExitCode.NETWORK, 'network');
  }
}

function validateProtectedResource(
  value: ProtectedResourceMetadata,
  url: string,
): ProtectedResourceMetadata {
  if (!Array.isArray(value.authorization_servers) || value.authorization_servers.length === 0) {
    throw new CliError(
      `OAuth protected-resource metadata at ${url} did not include authorization_servers`,
      ExitCode.NETWORK,
      'network',
    );
  }

  return value;
}

function validateAuthServer(
  value: AuthorizationServerMetadata,
  url: string,
): AuthorizationServerMetadata {
  if (!value.issuer || !value.authorization_endpoint || !value.token_endpoint) {
    throw new CliError(
      `OAuth authorization-server metadata at ${url} is missing required endpoints`,
      ExitCode.NETWORK,
      'network',
    );
  }

  return value;
}

async function discoverUncached(mcpBaseUrl: string): Promise<OAuthDiscovery> {
  const protectedResourceUrl = wellKnownUrl(mcpBaseUrl, '/.well-known/oauth-protected-resource');
  const protectedResource = validateProtectedResource(
    await fetchJsonWithTimeout<ProtectedResourceMetadata>(protectedResourceUrl),
    protectedResourceUrl,
  );

  const authServerBaseUrl = protectedResource.authorization_servers[0];
  const authServerUrl = wellKnownUrl(authServerBaseUrl, '/.well-known/oauth-authorization-server');
  const authServer = validateAuthServer(
    await fetchJsonWithTimeout<AuthorizationServerMetadata>(authServerUrl),
    authServerUrl,
  );

  return {
    mcpBaseUrl: trimTrailingSlash(mcpBaseUrl),
    protectedResource,
    authServer,
  };
}

export async function discoverOAuth(mcpBaseUrl: string): Promise<OAuthDiscovery> {
  const cacheKey = trimTrailingSlash(mcpBaseUrl);
  let cached = discoveryCache.get(cacheKey);
  if (!cached) {
    cached = discoverUncached(cacheKey).catch((err: unknown) => {
      discoveryCache.delete(cacheKey);
      throw err;
    });
    discoveryCache.set(cacheKey, cached);
  }

  return cached;
}

export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

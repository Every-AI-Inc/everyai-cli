import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDir } from '../config.js';
import { CliError } from '../errors.js';
import { ExitCode } from '../exit-codes.js';
import { AuthorizationServerMetadata, fetchJsonWithTimeout } from './discovery.js';

const DCR_TIMEOUT_MS = 10_000;
const CLIENT_NAME = 'Every AI CLI';
export const DEFAULT_SCOPE = 'openid profile email offline_access user:org:read';

interface ClientRegistration {
  client_id: string;
  redirect_uris: string[];
}

interface ClientRegistrationFile {
  issuers: Record<string, ClientRegistration>;
}

export interface ClientRegistrationStoreOptions {
  filePath?: string;
}

export interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
}

function clientsPath(): string {
  return path.join(getConfigDir(), 'oauth-clients.json');
}

async function readRegistrations(filePath: string): Promise<ClientRegistrationFile> {
  try {
    const text = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(text) as ClientRegistrationFile;
    return {
      issuers: parsed && typeof parsed.issuers === 'object' && parsed.issuers ? parsed.issuers : {},
    };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { issuers: {} };
    }
    throw err;
  }
}

async function writeRegistrations(
  filePath: string,
  registrations: ClientRegistrationFile,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(registrations, null, 2), { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

async function postClientRegistration(
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
): Promise<RegisteredClient> {
  if (!metadata.registration_endpoint) {
    throw new CliError(
      `OAuth issuer ${metadata.issuer} does not advertise dynamic client registration`,
      ExitCode.AUTH,
      'auth',
    );
  }

  let response: RegisteredClient;
  try {
    response = await fetchJsonWithTimeout<RegisteredClient>(
      metadata.registration_endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: CLIENT_NAME,
          // MCP 2026-07-28 requires clients to declare this. We are a native app
          // on a loopback redirect, and saying so stops an OIDC-compliant server
          // from rejecting the http:// redirect_uri that web clients may not use.
          application_type: 'native',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: DEFAULT_SCOPE,
        }),
      },
      DCR_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof CliError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to register OAuth client: ${detail}`, ExitCode.NETWORK, 'network');
  }

  if (!response.client_id) {
    throw new CliError('OAuth client registration did not return client_id', ExitCode.AUTH, 'auth');
  }

  return {
    client_id: response.client_id,
    redirect_uris: response.redirect_uris ?? [redirectUri],
  };
}

export async function getOrRegisterClient(
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
  opts: ClientRegistrationStoreOptions = {},
): Promise<RegisteredClient> {
  const filePath = opts.filePath ?? clientsPath();
  const registrations = await readRegistrations(filePath);
  const cached = registrations.issuers[metadata.issuer];

  if (cached?.client_id && cached.redirect_uris.includes(redirectUri)) {
    return cached;
  }

  const registered = await postClientRegistration(metadata, redirectUri);
  registrations.issuers[metadata.issuer] = registered;
  await writeRegistrations(filePath, registrations);
  return registered;
}


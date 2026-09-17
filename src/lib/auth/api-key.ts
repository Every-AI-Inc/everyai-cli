import { apiKeysUrlForBaseUrl } from '../config.js';

/**
 * Org API keys — the headless credential.
 *
 * An org admin mints one in Every under Settings → API keys; it looks like
 * `evk_<uuid>.<secret>` and is presented to the CLI as `EVERY_TOKEN`. Unlike a
 * browser login it is NOT a Clerk OAuth credential: the MCP server validates it
 * locally against `org_api_keys` and never sends it to Clerk. Two consequences
 * drive every branch that imports this module:
 *
 *  1. The OAuth userinfo endpoint cannot resolve a key, so any identity lookup
 *     that assumes a Clerk token reports "not logged in" for a perfectly valid
 *     key. Identity resolution must branch on `isApiKeyToken` first.
 *  2. A key is not a JWT, so `decodeJwtClaims` cannot read a subject, email or
 *     expiry from it. Callers must not infer identity or expiry from the string.
 *
 * This is the single place that knows the token shape — never string-match
 * `evk_` anywhere else.
 */
export const API_KEY_TOKEN_PREFIX = 'evk_';

/** How the active credential authenticates, for `--json` consumers. */
export type AuthMethod = 'api_key' | 'oauth';

/** True when `token` is an Every org API key rather than a Clerk OAuth token. */
export function isApiKeyToken(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.startsWith(API_KEY_TOKEN_PREFIX);
}

/** True when this process's credential (`EVERY_TOKEN`) is an org API key. */
export function activeCredentialIsApiKey(): boolean {
  return isApiKeyToken(process.env.EVERY_TOKEN);
}

/** Classify the credential a command is about to use. */
export function authMethodForToken(token: string | null | undefined): AuthMethod {
  return isApiKeyToken(token) ? 'api_key' : 'oauth';
}

/**
 * Pull the server's own reason out of a 401/403 body.
 *
 * Verified shape — admin-mcp's `ClerkAuthMiddleware` answers a rejected bearer
 * with `{"error":"invalid_token","error_description":"Invalid or expired token"}`
 * (JSON, RFC 6750 field names, and no `WWW-Authenticate` header on this path;
 * the header only appears when no bearer was sent at all). Anything that is not
 * that shape yields `undefined` so the caller falls back to its own copy — this
 * never guesses at a body it has not seen.
 */
export function authErrorReasonFromBody(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const body = parsed as Record<string, unknown>;
  const candidate = [body.error_description, body.error].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  if (candidate === undefined) return undefined;

  // Server copy is rendered into a terminal: flatten it and bound it so an
  // unexpected payload can never reshape the CLI's own error output.
  const flattened = candidate.replace(/\s+/g, ' ').trim();
  return flattened.length > 200 ? `${flattened.slice(0, 197)}...` : flattened;
}

/**
 * The message for a rejected API key. Deliberately enumerates the causes the
 * server collapses into one generic 401: it logs which one applied, the client
 * only ever sees "Invalid or expired token".
 *
 * Never interpolates the key itself.
 */
export function apiKeyRejectedMessage(baseUrl: string, serverReason?: string): string {
  const origin = serverReason
    ? `HTTP 401 from ${baseUrl}; server said: ${serverReason}`
    : `HTTP 401 from ${baseUrl}`;
  return (
    `Every rejected the API key in EVERY_TOKEN (${origin}). ` +
    'The key may be invalid, expired or revoked, or the admin who created it may no longer ' +
    'be an admin of its workspace. ' +
    `Check it in Every under Settings → API keys: ${apiKeysUrlForBaseUrl(baseUrl)}`
  );
}

import os from 'node:os';
import path from 'node:path';

/**
 * On-disk config location for the `every` CLI (auth tokens land here in a
 * later phase). Kept under the XDG-style `~/.config/everyai`.
 */
export const CONFIG_DIR = path.join(os.homedir(), '.config', 'everyai');

/** Resolve the config directory dynamically so tests can isolate state. */
export function getConfigDir(): string {
  return process.env.EVERY_CONFIG_DIR ?? CONFIG_DIR;
}

/** Deployed MCP base URLs. */
export const PROD_BASE_URL = 'https://admin-mcp.every.ai';
export const STAGING_BASE_URL = 'https://admin-mcp-staging.up.railway.app';

export interface ResolveBaseUrlOptions {
  staging?: boolean;
}

/**
 * Resolve the MCP base URL to target.
 *
 * Precedence:
 *  1. `EVERY_MCP_URL` env override (any value, wins over `staging`)
 *  2. `{ staging: true }` -> staging deployment
 *  3. default -> production deployment
 */
export function resolveBaseUrl({ staging }: ResolveBaseUrlOptions = {}): string {
  const override = process.env.EVERY_MCP_URL;
  if (override) return override;
  return staging ? STAGING_BASE_URL : PROD_BASE_URL;
}

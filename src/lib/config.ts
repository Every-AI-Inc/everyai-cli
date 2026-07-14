import os from 'node:os';
import path from 'node:path';

/**
 * Default on-disk config location for the `every` CLI.
 */
export const CONFIG_DIR = path.join(os.homedir(), '.config', 'everyai');

/** Resolve the config directory dynamically so tests can isolate state. */
export function getConfigDir(): string {
  if (process.env.EVERY_CONFIG_DIR) return process.env.EVERY_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'everyai');
  return CONFIG_DIR;
}

/** Deployed MCP base URLs. */
export const PROD_BASE_URL = 'https://admin-mcp.every.ai';
export const STAGING_BASE_URL = 'https://admin-mcp-staging.up.railway.app';
export const PROD_SIGNUP_URL = 'https://app.every.ai/sign-up';
export const STAGING_SIGNUP_URL = 'https://app.staging.every.ai/sign-up';
export type EnvironmentName = 'production' | 'staging' | 'custom';

export interface ResolveBaseUrlOptions {
  staging?: boolean;
}

/**
 * Resolve the MCP base URL to target.
 *
 * Precedence:
 *  1. `{ staging: true }` -> staging deployment
 *  2. `EVERY_MCP_URL` env override
 *  3. `EVERY_ENV=staging|production`
 *  4. default -> production deployment
 */
export function resolveBaseUrl({ staging }: ResolveBaseUrlOptions = {}): string {
  if (staging) return STAGING_BASE_URL;
  const override = process.env.EVERY_MCP_URL;
  if (override) return override;

  const env = process.env.EVERY_ENV?.toLowerCase();
  if (env === 'staging') return STAGING_BASE_URL;
  if (env === 'production') return PROD_BASE_URL;

  return PROD_BASE_URL;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function environmentNameForBaseUrl(baseUrl: string): EnvironmentName {
  const normalized = trimTrailingSlash(baseUrl);
  if (normalized === trimTrailingSlash(PROD_BASE_URL)) return 'production';
  if (normalized === trimTrailingSlash(STAGING_BASE_URL)) return 'staging';
  return 'custom';
}

export function signupUrlForBaseUrl(baseUrl: string): string {
  return environmentNameForBaseUrl(baseUrl) === 'staging'
    ? STAGING_SIGNUP_URL
    : PROD_SIGNUP_URL;
}

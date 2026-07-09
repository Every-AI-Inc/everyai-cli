/**
 * Stable output envelope for the `every` CLI.
 *
 * `--json` mode is a CLI CONTRACT that agents and scripts parse. Rules:
 *  - Success: `{ ok: true,  data,  env, schema_version: 1 }`
 *  - Failure: `{ ok: false, error: { message, code }, env, schema_version: 1 }`
 *  - In `--json` mode the ONLY thing written is a single JSON object — never
 *    mix human prose into machine output.
 */

import {
  EnvironmentName,
  environmentNameForBaseUrl,
  resolveBaseUrl,
} from './config.js';

export const SCHEMA_VERSION = 1 as const;

export interface EmitOptions {
  json?: boolean;
  staging?: boolean;
  baseUrl?: string;
  env?: EnvironmentName;
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  env: EnvironmentName;
  schema_version: typeof SCHEMA_VERSION;
}

export interface ErrorEnvelope {
  ok: false;
  error: { message: string; code: string };
  env: EnvironmentName;
  schema_version: typeof SCHEMA_VERSION;
}

function hasStagingArg(): boolean {
  return process.argv.includes('--staging');
}

function envelopeEnv(opts: EmitOptions = {}): EnvironmentName {
  if (opts.env) return opts.env;
  const baseUrl = opts.baseUrl ?? resolveBaseUrl({ staging: opts.staging ?? hasStagingArg() });
  return environmentNameForBaseUrl(baseUrl);
}

export function successEnvelope<T>(data: T, opts: EmitOptions = {}): SuccessEnvelope<T> {
  return { ok: true, data, env: envelopeEnv(opts), schema_version: SCHEMA_VERSION };
}

export function errorEnvelope(
  message: string,
  code: string,
  opts: EmitOptions = {},
): ErrorEnvelope {
  return {
    ok: false,
    error: { message, code },
    env: envelopeEnv(opts),
    schema_version: SCHEMA_VERSION,
  };
}

function humanize(data: unknown): string {
  if (data === null || data === undefined) return 'OK';
  if (typeof data === 'string') return data;
  if (typeof data !== 'object') return String(data);
  return Object.entries(data as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

/** Render a success result as a string (pure JSON when `json`, else human text). */
export function formatSuccess<T>(data: T, opts: EmitOptions = {}): string {
  if (opts.json) return JSON.stringify(successEnvelope(data, opts));
  return humanize(data);
}

/** Render an error as a string (pure JSON when `json`, else human text). */
export function formatError(message: string, code: string, opts: EmitOptions = {}): string {
  if (opts.json) return JSON.stringify(errorEnvelope(message, code, opts));
  return `Error: ${message}`;
}

/** Emit a success result to stdout. */
export function emit<T>(data: T, opts: EmitOptions = {}): void {
  process.stdout.write(formatSuccess(data, opts) + '\n');
}

/**
 * Emit an error. In `--json` mode the envelope goes to stdout so a single
 * parse of stdout always yields the machine result; human errors go to stderr.
 */
export function emitError(message: string, code: string, opts: EmitOptions = {}): void {
  const rendered = formatError(message, code, opts);
  if (opts.json) {
    process.stdout.write(rendered + '\n');
  } else {
    process.stderr.write(rendered + '\n');
  }
}

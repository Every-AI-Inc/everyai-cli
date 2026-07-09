import { resolveBaseUrl } from '../lib/config.js';
import { emit } from '../lib/output.js';
import { CliError } from '../lib/errors.js';
import { ExitCode } from '../lib/exit-codes.js';

export interface PingOptions {
  json?: boolean;
  staging?: boolean;
}

const PING_TIMEOUT_MS = 10_000;

function classifyHttpStatus(status: number): { exitCode: ExitCode; code: string } {
  if (status === 401) return { exitCode: ExitCode.AUTH, code: 'auth' };
  if (status === 402 || status === 403) {
    return { exitCode: ExitCode.PERMISSION, code: 'permission' };
  }
  if (status === 404) return { exitCode: ExitCode.NOT_FOUND, code: 'not_found' };
  if (status === 429) return { exitCode: ExitCode.RATE_LIMIT, code: 'rate_limit' };
  if (status >= 500) return { exitCode: ExitCode.NETWORK, code: 'network' };
  return { exitCode: ExitCode.GENERIC, code: 'generic' };
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * `every ping` — unauthenticated connectivity check against the MCP server's
 * `/health` endpoint. Emits `{ status, service, base_url }` on success.
 */
export async function pingCommand(opts: PingOptions = {}): Promise<void> {
  const baseUrl = resolveBaseUrl({ staging: opts.staging });
  const url = `${baseUrl}/health`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new CliError(
        `Timed out reaching ${url} after ${PING_TIMEOUT_MS}ms`,
        ExitCode.NETWORK,
        'network',
      );
    }

    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to reach ${url}: ${detail}`, ExitCode.NETWORK, 'network');
  }

  if (!response.ok) {
    const classified = classifyHttpStatus(response.status);
    throw new CliError(
      `Health check failed for ${url}: HTTP ${response.status}`,
      classified.exitCode,
      classified.code,
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON 200 is still "reachable"; fall back to a healthy default.
  }

  emit(
    {
      status: body.status ?? 'ok',
      service: body.service ?? null,
      base_url: baseUrl,
    },
    { json: opts.json },
  );
}

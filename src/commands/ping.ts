import { resolveBaseUrl } from '../lib/config.js';
import { emit } from '../lib/output.js';
import { CliError } from '../lib/errors.js';
import { ExitCode } from '../lib/exit-codes.js';

export interface PingOptions {
  json?: boolean;
  staging?: boolean;
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
    response = await fetch(url);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to reach ${url}: ${detail}`, ExitCode.NETWORK, 'network');
  }

  if (!response.ok) {
    throw new CliError(
      `Health check failed for ${url}: HTTP ${response.status}`,
      ExitCode.NETWORK,
      'network',
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

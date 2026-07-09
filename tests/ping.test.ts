import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pingCommand } from '../src/commands/ping';

const ORIGINAL_URL = process.env.EVERY_MCP_URL;

function restoreEnv(): void {
  if (ORIGINAL_URL === undefined) delete process.env.EVERY_MCP_URL;
  else process.env.EVERY_MCP_URL = ORIGINAL_URL;
}

function stdoutText(writeSpy: ReturnType<typeof vi.spyOn>): string {
  return writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
}

describe('pingCommand', () => {
  beforeEach(() => {
    process.env.EVERY_MCP_URL = 'https://mcp.example.test';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreEnv();
  });

  it('emits a JSON success envelope from a healthy endpoint', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ status: 'ok', service: 'mock-mcp' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await pingCommand({ json: true });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.example.test/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(JSON.parse(stdoutText(writeSpy))).toEqual({
      ok: true,
      data: {
        status: 'ok',
        service: 'mock-mcp',
        base_url: 'https://mcp.example.test',
      },
      schema_version: 1,
    });
  });

  it('maps HTTP 429 to the rate-limit contract error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 429 })));

    await expect(pingCommand({ json: true })).rejects.toMatchObject({
      exitCode: 5,
      code: 'rate_limit',
    });
  });

  it('maps fetch failures to the network contract error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );

    await expect(pingCommand({ json: true })).rejects.toMatchObject({
      exitCode: 7,
      code: 'network',
    });
  });

  it('maps aborted fetches to the network timeout error', async () => {
    const err = new Error('operation timed out');
    err.name = 'TimeoutError';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw err;
      }),
    );

    await expect(pingCommand({ json: true })).rejects.toMatchObject({
      exitCode: 7,
      code: 'network',
      message: 'Timed out reaching https://mcp.example.test/health after 10000ms',
    });
  });
});

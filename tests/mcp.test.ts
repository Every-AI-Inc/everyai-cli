import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  listTools,
  mcpCall,
  toolCacheFileMode,
  toolsCacheFilePath,
} from '../src/lib/mcp';
import { ExitCode } from '../src/lib/exit-codes';

const ORIGINAL_ENV = {
  EVERY_CONFIG_DIR: process.env.EVERY_CONFIG_DIR,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreEnv();
});

function jsonRpc(result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 'test', result });
}

describe('mcpCall', () => {
  it('parses SSE-framed JSON-RPC responses and sends streamable-HTTP headers', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(`event: message\ndata: ${jsonRpc({ ok: true })}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(mcpCall('https://mcp.example.test', 'token-1', 'tools/list')).resolves.toEqual({
      ok: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.example.test/',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer token-1',
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        }),
      }),
    );
  });

  it('parses plain JSON JSON-RPC responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(jsonRpc({ tools: [] }), { status: 200 })));

    await expect(mcpCall('https://mcp.example.test', 'token-1', 'tools/list')).resolves.toEqual({
      tools: [],
    });
  });

  it.each([
    [401, ExitCode.AUTH, 'auth'],
    [402, ExitCode.PERMISSION, 'permission'],
    [403, ExitCode.PERMISSION, 'permission'],
    [404, ExitCode.NOT_FOUND, 'not_found'],
    [406, ExitCode.NETWORK, 'network'],
    [429, ExitCode.RATE_LIMIT, 'rate_limit'],
    [500, ExitCode.NETWORK, 'network'],
  ])('maps HTTP %s to the CLI error contract', async (status, exitCode, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status })));

    await expect(mcpCall('https://mcp.example.test', 'token-1', 'tools/list')).rejects.toMatchObject({
      exitCode,
      code,
    });
  });

  it('maps network failures and timeouts to network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );

    await expect(mcpCall('https://mcp.example.test', 'token-1', 'tools/list')).rejects.toMatchObject({
      exitCode: ExitCode.NETWORK,
      code: 'network',
    });

    const err = new Error('timed out');
    err.name = 'TimeoutError';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw err;
      }),
    );

    await expect(mcpCall('https://mcp.example.test', 'token-1', 'tools/list')).rejects.toMatchObject({
      exitCode: ExitCode.NETWORK,
      code: 'network',
    });
  });

  it('maps JSON-RPC invalid params to usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'test',
            error: { code: -32602, message: 'Invalid params' },
          }),
          { status: 200 },
        );
      }),
    );

    await expect(mcpCall('https://mcp.example.test', 'token-1', 'tools/call')).rejects.toMatchObject({
      exitCode: ExitCode.USAGE,
      code: 'usage',
    });
  });

  it('maps unknown tool JSON-RPC errors to not_found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'test',
            error: { code: -32602, message: 'Unknown tool: missing_tool' },
          }),
          { status: 200 },
        );
      }),
    );

    await expect(callTool('https://mcp.example.test', 'token-1', 'missing_tool', {})).rejects.toMatchObject({
      exitCode: ExitCode.NOT_FOUND,
      code: 'not_found',
    });
  });

  it('preserves CallToolResult metadata for trusted approval-gate handling', async () => {
    const gate = {
      type: 'human_approval',
      version: 1,
      status: 'pending',
      request_id: 'request-123',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(jsonRpc({
        content: [{ type: 'text', text: 'Approval pending.' }],
        isError: true,
        _meta: { 'everyai/mcp_gate': gate },
      }), { status: 200 })),
    );

    await expect(
      callTool('https://mcp.example.test', 'token-1', 'delete_client', {
        client_id: 'client-123',
      }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'Approval pending.' }],
      structuredContent: undefined,
      isError: true,
      _meta: { 'everyai/mcp_gate': gate },
    });
  });
});

describe('listTools cache', () => {
  async function tempConfig(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-mcp-'));
    process.env.EVERY_CONFIG_DIR = dir;
    return dir;
  }

  it('honors a fresh cache and writes cache files with mode 0600', async () => {
    const dir = await tempConfig();
    const fetchMock = vi.fn(async () => {
      return new Response(jsonRpc({ tools: [{ name: 'list_invoices' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(listTools('https://mcp.example.test', 'token-1')).resolves.toEqual([
        { name: 'list_invoices' },
      ]);
      await expect(listTools('https://mcp.example.test', 'token-1')).resolves.toEqual([
        { name: 'list_invoices' },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await toolCacheFileMode('https://mcp.example.test')).toBe(0o600);
      expect(toolsCacheFilePath('https://mcp.example.test')).toContain(path.join(dir, 'cache'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--no-cache bypasses and rewrites the cache', async () => {
    const dir = await tempConfig();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(jsonRpc({ tools: [{ name: 'first_tool' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(jsonRpc({ tools: [{ name: 'second_tool' }] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(listTools('https://mcp.example.test', 'token-1')).resolves.toEqual([
        { name: 'first_tool' },
      ]);
      await expect(listTools('https://mcp.example.test', 'token-1', { noCache: true })).resolves.toEqual([
        { name: 'second_tool' },
      ]);
      await expect(listTools('https://mcp.example.test', 'token-1')).resolves.toEqual([
        { name: 'second_tool' },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

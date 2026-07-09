import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const enabled = process.env.EVERYAI_MOCK_MCP === '1';
const baseUrl = process.env.EVERY_MCP_URL ?? 'https://mock-mcp.everyai.test';
const stateFile = process.env.EVERYAI_MOCK_MCP_STATE;
const originalFetch = globalThis.fetch;

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'tools-alias-schemas.json',
);
const aliasTools = JSON.parse(readFileSync(fixturePath, 'utf8'));

const tools = [
  ...aliasTools,
  {
    name: 'tool_error',
    title: 'Tool error',
    description: 'Return an MCP tool-level error.',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

function readState() {
  if (!stateFile) return { listCalls: 0, toolCalls: [] };
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return { listCalls: 0, toolCalls: [] };
  }
}

function writeState(state) {
  if (stateFile) writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

if (enabled && stateFile) {
  const targetOrigin = new URL(baseUrl).origin;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
    );

    if (url.origin !== targetOrigin) return originalFetch(input, init);
    if ((init.method ?? 'GET') !== 'POST' || url.pathname !== '/') {
      return response({ error: 'not found' }, 404);
    }

    const headers = new Headers(init.headers);
    if (headers.get('authorization') !== 'Bearer test-token') {
      return response({ error: 'unauthorized' }, 401);
    }

    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
    const state = readState();

    if (body.method === 'tools/list') {
      state.listCalls += 1;
      writeState(state);
      return response({ jsonrpc: '2.0', id: body.id, result: { tools } });
    }

    if (body.method === 'tools/call') {
      const name = body.params?.name ?? '';
      const args = body.params?.arguments ?? {};
      state.toolCalls.push({ name, arguments: args });
      writeState(state);

      if (name === 'tool_error') {
        return response({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: 'tool exploded' }],
          },
        });
      }

      return response({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{ type: 'text', text: `called ${name}` }],
          structuredContent: { received: args },
          isError: false,
        },
      });
    }

    return response({
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32601, message: 'Method not found' },
    });
  };
}

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
  if (!stateFile) return { listCalls: 0, toolCalls: [], openidCalls: 0, userinfoCalls: 0 };
  try {
    return {
      listCalls: 0,
      toolCalls: [],
      openidCalls: 0,
      userinfoCalls: 0,
      ...JSON.parse(readFileSync(stateFile, 'utf8')),
    };
  } catch {
    return { listCalls: 0, toolCalls: [], openidCalls: 0, userinfoCalls: 0 };
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
    const method = init.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      return response({ authorization_servers: [baseUrl] });
    }

    if (method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return response({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
      });
    }

    if (method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      const state = readState();
      state.openidCalls += 1;
      writeState(state);
      return response({ userinfo_endpoint: `${baseUrl}/oauth/userinfo` });
    }

    if (method === 'GET' && url.pathname === '/oauth/userinfo') {
      const state = readState();
      state.userinfoCalls += 1;
      writeState(state);

      const status = Number(process.env.EVERYAI_MOCK_USERINFO_STATUS ?? '200');
      if (status !== 200) return response({ error: 'userinfo failed' }, status);

      const headers = new Headers(init.headers);
      if (headers.get('authorization') !== 'Bearer test-token') {
        return response({ error: 'unauthorized' }, 401);
      }

      return response({
        user_id: 'user_123',
        sub: 'user_123',
        email: 'person@example.com',
        email_verified: true,
        name: 'Person Example',
        given_name: 'Person',
        family_name: 'Example',
        org_id: 'org_123',
        org_slug: 'acme',
        org_name: 'Acme Co',
        picture: null,
        instance_id: 'inst_123',
      });
    }

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

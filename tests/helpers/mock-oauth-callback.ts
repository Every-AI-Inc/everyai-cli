import type { LoginFlowOptions } from '../../src/lib/auth/flow';

/** In-memory callback transport for environments that prohibit loopback listeners. */
export function mockOAuthCallback() {
  let complete: (result: { code: string; iss?: string }) => void;
  let expectedState: string;
  const createServer: NonNullable<LoginFlowOptions['createCallbackServer']> = async (state) => {
    expectedState = state;
    return {
      redirectUri: 'http://127.0.0.1:32199/callback',
      waitForCallback: new Promise((resolve) => { complete = resolve; }),
      close: async () => {},
    };
  };
  async function visit(url: URL): Promise<Response> {
    if (url.searchParams.get('state') !== expectedState) throw new Error('Mock callback state mismatch');
    complete({ code: url.searchParams.get('code')!, iss: url.searchParams.get('iss') ?? undefined });
    return new Response('Logged in');
  }
  return { createServer, visit };
}

import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { resolveBaseUrl } from './config.js';
import { getAuthStatus } from './auth/tokens.js';
import { readCachedUserInfo } from './auth/userinfo.js';

export interface FirstRunMenuOptions {
  input: Readable;
  output: Writable;
  showHelp: () => void;
  login: () => Promise<void>;
  getStatus: () => Promise<{ logged_in: boolean }>;
  getCachedIdentity: () => Promise<{ email: string | null; org_name: string | null } | undefined>;
}

function write(output: Writable, text: string): void {
  output.write(text);
}

export async function runFirstRunMenu(opts: FirstRunMenuOptions): Promise<void> {
  const status = await opts.getStatus();
  if (status.logged_in) {
    const identity = await opts.getCachedIdentity();
    if (identity) {
      const email = identity.email ?? 'unknown';
      const org = identity.org_name ?? 'unknown';
      write(opts.output, `Logged in as ${email} · org ${org} · try: every tools list\n\n`);
    }
    opts.showHelp();
    return;
  }

  write(
    opts.output,
    [
      "Welcome to Every AI — you're not logged in.",
      '',
      '1) Log in or create an account (opens your browser)',
      '2) Show all commands',
      '3) Exit',
      '',
    ].join('\n'),
  );

  const rl = createInterface({ input: opts.input, output: opts.output });
  let action: 'login' | 'help' | 'exit' = 'exit';
  try {
    const answer = (await rl.question('Choose [1]: ')).trim();
    if (answer === '' || answer === '1') {
      action = 'login';
    } else if (answer === '2') {
      action = 'help';
    }
  } finally {
    rl.close();
  }

  // Login may open its own post-login prompt, so release stdin first.
  if (action === 'login') await opts.login();
  else if (action === 'help') opts.showHelp();
}

export async function runDefaultFirstRunMenu(params: {
  staging?: boolean;
  showHelp: () => void;
  login: () => Promise<void>;
}): Promise<void> {
  const baseUrl = resolveBaseUrl({ staging: params.staging });
  await runFirstRunMenu({
    input: process.stdin,
    output: process.stdout,
    showHelp: params.showHelp,
    login: params.login,
    getStatus: () => getAuthStatus({ baseUrl }),
    getCachedIdentity: () => readCachedUserInfo(baseUrl, { allowStale: true }),
  });
}

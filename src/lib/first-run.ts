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
  createAccount: () => Promise<void>;
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
      '1) Log in — I already have an account (opens your browser)',
      '2) Create an account',
      '3) Show all commands',
      '4) Exit',
      '',
    ].join('\n'),
  );

  const rl = createInterface({ input: opts.input, output: opts.output });
  let action: 'login' | 'createAccount' | 'help' | 'exit' = 'exit';
  try {
    const answer = (await rl.question('Choose [1]: ')).trim();
    if (answer === '' || answer === '1') {
      action = 'login';
    } else if (answer === '2') {
      action = 'createAccount';
    } else if (answer === '3') {
      action = 'help';
    }
  } finally {
    rl.close();
  }

  // Login may open its own post-login prompt, so release stdin first.
  // Account creation also prompts before it starts the normal login flow.
  if (action === 'login') await opts.login();
  else if (action === 'createAccount') await opts.createAccount();
  else if (action === 'help') opts.showHelp();
}

export async function runDefaultFirstRunMenu(params: {
  staging?: boolean;
  showHelp: () => void;
  login: () => Promise<void>;
  createAccount: () => Promise<void>;
}): Promise<void> {
  const baseUrl = resolveBaseUrl({ staging: params.staging });
  await runFirstRunMenu({
    input: process.stdin,
    output: process.stdout,
    showHelp: params.showHelp,
    login: params.login,
    createAccount: params.createAccount,
    getStatus: () => getAuthStatus({ baseUrl }),
    getCachedIdentity: () => readCachedUserInfo(baseUrl, { allowStale: true }),
  });
}

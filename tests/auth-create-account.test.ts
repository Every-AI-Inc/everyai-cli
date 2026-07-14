import { PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAccountFlow,
  loginCommand,
} from '../src/commands/auth';
import { loginFlow, openBrowser } from '../src/lib/auth/flow';
import {
  createTokenStore,
  getAuthStatus,
  StoredTokenSet,
} from '../src/lib/auth/tokens';
import { CliError } from '../src/lib/errors';
import { ExitCode } from '../src/lib/exit-codes';

vi.mock('../src/lib/auth/flow', () => ({
  loginFlow: vi.fn(),
  openBrowser: vi.fn(),
}));

vi.mock('../src/lib/auth/tokens', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/auth/tokens')>(
    '../src/lib/auth/tokens',
  );
  return {
    ...actual,
    createTokenStore: vi.fn(),
    getAuthStatus: vi.fn(),
  };
});

vi.mock('../src/lib/hints', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/hints')>(
    '../src/lib/hints',
  );
  return {
    ...actual,
    readHints: vi.fn(async () => ({ skill_offer_declined: true })),
  };
});

type TtyReadable = Readable & { isTTY: boolean };
type TtyWritable = Writable & { isTTY: boolean };

const ORIGINAL_EVERY_TOKEN = process.env.EVERY_TOKEN;

function ttyInput(text: string, isTTY = true): TtyReadable {
  const stream = Readable.from([text]) as TtyReadable;
  stream.isTTY = isTTY;
  return stream;
}

function outputCapture(isTTY = true): {
  output: TtyWritable;
  text: () => string;
} {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as TtyWritable;
  output.isTTY = isTTY;
  return { output, text: () => chunks.join('') };
}

function mockProcessIo(stdinIsTTY = true, stdoutIsTTY = true, stderrIsTTY = true): {
  input: PassThrough & { isTTY: boolean };
  stdout: ReturnType<typeof outputCapture>;
  stderr: ReturnType<typeof outputCapture>;
} {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = stdinIsTTY;
  const stdout = outputCapture(stdoutIsTTY);
  const stderr = outputCapture(stderrIsTTY);
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as typeof process.stdin);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout.output as typeof process.stdout);
  vi.spyOn(process, 'stderr', 'get').mockReturnValue(stderr.output as typeof process.stderr);
  return { input, stdout, stderr };
}

function tokenSet(): StoredTokenSet {
  const accessToken = [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: 'user_123', email: 'person@example.com' })).toString(
      'base64url',
    ),
    '',
  ].join('.');
  return {
    issuer: 'https://issuer.example.test',
    client_id: 'client-1',
    access_token: accessToken,
    refresh_token: 'refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
    scope: 'openid profile email offline_access user:org:read',
  };
}

const setToken = vi.fn();

beforeEach(() => {
  delete process.env.EVERY_TOKEN;
  vi.clearAllMocks();
  vi.mocked(loginFlow).mockResolvedValue(tokenSet());
  vi.mocked(openBrowser).mockResolvedValue();
  vi.mocked(createTokenStore).mockResolvedValue({
    backend: 'file',
    get: vi.fn(),
    set: setToken,
    delete: vi.fn(),
  });
  vi.mocked(getAuthStatus).mockResolvedValue({
    logged_in: false,
    environment: 'prod',
    base_url: 'https://admin-mcp.every.ai',
    storage_backend: 'file',
    every_token: false,
    issuer: null,
    expires_at: null,
    expires_in_seconds: null,
    expires: null,
    refresh_token: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_EVERY_TOKEN === undefined) delete process.env.EVERY_TOKEN;
  else process.env.EVERY_TOKEN = ORIGINAL_EVERY_TOKEN;
});

describe('create-account flow', () => {
  it('opens production signup, prompts, then completes and stores the browser login', async () => {
    const stdout = outputCapture(false);
    const stderr = outputCapture();
    const openSignup = vi.fn(async () => undefined);

    await createAccountFlow({
      input: ttyInput('\n'),
      output: stdout.output,
      errorOutput: stderr.output,
      openBrowser: openSignup,
    });

    expect(openSignup).toHaveBeenCalledWith('https://app.every.ai/sign-up');
    expect(stderr.text()).toContain('Opening the Every sign-up page:\n  https://app.every.ai/sign-up');
    expect(stderr.text()).toContain('Create your account and set up your workspace in the browser.');
    expect(stderr.text()).toContain("When you're done, press Enter to connect your terminal... ");
    expect(openSignup.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(loginFlow).mock.invocationCallOrder[0],
    );
    expect(loginFlow).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://admin-mcp.every.ai' }),
    );
    expect(setToken).toHaveBeenCalledWith('prod', expect.objectContaining({ issuer: tokenSet().issuer }));
    expect(stdout.text()).toContain('Logged in as person@example.com');
  });

  it('uses the staging signup URL and waits before starting login', async () => {
    const calls: string[] = [];
    const runLogin = vi.fn(async () => {
      calls.push('login');
    });
    const openSignup = vi.fn(async () => {
      calls.push('signup');
    });

    await createAccountFlow({
      staging: true,
      input: ttyInput('\n'),
      output: outputCapture(false).output,
      errorOutput: outputCapture().output,
      openBrowser: openSignup,
      runLogin,
    });

    expect(openSignup).toHaveBeenCalledWith('https://app.staging.every.ai/sign-up');
    expect(runLogin).toHaveBeenCalledOnce();
    expect(calls).toEqual(['signup', 'login']);
  });

  it('EVERY_TOKEN wins over create-account without opening a browser or prompting', async () => {
    process.env.EVERY_TOKEN = tokenSet().access_token;
    const io = mockProcessIo(true, true);

    await loginCommand({ createAccount: true });

    expect(openBrowser).not.toHaveBeenCalled();
    expect(loginFlow).not.toHaveBeenCalled();
    expect(getAuthStatus).not.toHaveBeenCalled();
    expect(io.stderr.text()).toBe('');
    expect(io.stdout.text()).toContain('EVERY_TOKEN is set; login is unnecessary.');
  });

  it('keeps the auth error contract for create-account without a stdout TTY', async () => {
    mockProcessIo(true, false);

    await expect(loginCommand({ createAccount: true })).rejects.toMatchObject<CliError>({
      code: 'auth',
      exitCode: ExitCode.AUTH,
      message: 'login requires a browser; set EVERY_TOKEN for headless use',
    });

    expect(openBrowser).not.toHaveBeenCalled();
    expect(loginFlow).not.toHaveBeenCalled();
  });

  it('fails fast for create-account without a stdin TTY instead of hanging at the prompt', async () => {
    mockProcessIo(false, true);

    await expect(loginCommand({ createAccount: true })).rejects.toMatchObject<CliError>({
      code: 'auth',
      exitCode: ExitCode.AUTH,
      message: 'create-account requires an interactive terminal; set EVERY_TOKEN for headless use',
    });

    expect(openBrowser).not.toHaveBeenCalled();
    expect(loginFlow).not.toHaveBeenCalled();
  });
});

describe('logged-out login menu', () => {
  it('choice 2 routes to account creation', async () => {
    const io = mockProcessIo();
    vi.mocked(openBrowser).mockImplementation(async () => {
      setTimeout(() => io.input.write('\n'), 0);
    });

    const login = loginCommand();
    io.input.write('2\n');
    await login;

    expect(io.stderr.text()).toContain("You're not signed in to Every.");
    expect(io.stderr.text()).toContain('2) Create an account');
    expect(openBrowser).toHaveBeenCalledWith('https://app.every.ai/sign-up');
    expect(loginFlow).toHaveBeenCalledOnce();
  });

  it.each(['1', ''])('choice %j routes directly to login', async (answer) => {
    const io = mockProcessIo();

    const login = loginCommand();
    io.input.write(`${answer}\n`);
    await login;

    expect(io.stderr.text()).toContain("You're not signed in to Every.");
    expect(openBrowser).not.toHaveBeenCalled();
    expect(loginFlow).toHaveBeenCalledOnce();
  });

  it('warns on an unrecognized choice and continues with login', async () => {
    const io = mockProcessIo();

    const login = loginCommand();
    io.input.write('wat\n');
    await login;

    expect(io.stderr.text()).toContain('Unrecognized choice; continuing with log in.');
    expect(loginFlow).toHaveBeenCalledOnce();
  });

  it('does not prompt in JSON mode', async () => {
    const io = mockProcessIo();

    await loginCommand({ json: true });

    expect(getAuthStatus).not.toHaveBeenCalled();
    expect(io.stderr.text()).not.toContain("You're not signed in to Every.");
    expect(loginFlow).toHaveBeenCalledOnce();
  });

  it('does not prompt when skipMenu is set', async () => {
    const io = mockProcessIo();

    await loginCommand({ skipMenu: true });

    expect(getAuthStatus).not.toHaveBeenCalled();
    expect(io.stderr.text()).not.toContain("You're not signed in to Every.");
    expect(loginFlow).toHaveBeenCalledOnce();
  });

  it('does not prompt when stdin is not a TTY', async () => {
    const io = mockProcessIo(false, true);

    await loginCommand();

    expect(getAuthStatus).not.toHaveBeenCalled();
    expect(io.stderr.text()).not.toContain("You're not signed in to Every.");
    expect(loginFlow).toHaveBeenCalledOnce();
  });

  it('does not prompt when stderr is not a TTY (menu would be invisible)', async () => {
    const io = mockProcessIo(true, true, false);

    await loginCommand();

    expect(getAuthStatus).not.toHaveBeenCalled();
    expect(io.stderr.text()).not.toContain("You're not signed in to Every.");
    expect(loginFlow).toHaveBeenCalledOnce();
  });

  it('does not prompt a user who is already logged in', async () => {
    const io = mockProcessIo();
    vi.mocked(getAuthStatus).mockResolvedValue({
      ...await vi.mocked(getAuthStatus)(),
      logged_in: true,
    });

    await loginCommand();

    expect(io.stderr.text()).not.toContain("You're not signed in to Every.");
    expect(loginFlow).toHaveBeenCalledOnce();
  });
});

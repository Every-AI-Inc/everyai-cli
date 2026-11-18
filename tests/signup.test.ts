import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');
const mockPreload = path.join(repoRoot, 'tests', 'helpers', 'mock-mcp-fetch.mjs');
// Absolute, because these runs use a temp project dir as cwd (no node_modules).
const tsxLoader = pathToFileURL(path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const envelopes = JSON.parse(
  readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'signup-envelopes.json'), 'utf8'),
) as Record<'needs_profile' | 'ready' | 'completed', Record<string, unknown>>;
const bundledSkill = readFileSync(path.join(repoRoot, 'skills', 'use-every', 'SKILL.md'), 'utf8');

const MOCK_BASE_URL = 'https://mock-mcp.everyai.test';
const NEXT_STEP =
  'Ask the person for the organization name, then run: every signup complete --org-name "<name>" --yes --json';
const NO_HOST_SKILL = {
  name: 'use-every',
  installed: [],
  already_present: [],
  failed: [],
  skipped_reason: 'no_agent_host',
};
const STAGING_BASE_URL = 'https://admin-mcp-staging.up.railway.app';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface MockState {
  listCalls: number;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  authorizationRequests: string[];
  tokenRequests: string[];
  openedUrls: string[];
  signupReady: boolean;
}

interface Sandbox {
  dir: string;
  configDir: string;
  home: string;
  cwd: string;
  stateFile: string;
  state(): MockState;
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  close(): Promise<void>;
}

/**
 * Every test runs a real CLI process with no TTY on any stdio stream — the way a
 * coding agent's shell tool runs it — against the in-process mock MCP/OAuth
 * server and a fake browser launcher (EVERYAI_MOCK_BROWSER).
 */
function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  onStdout?: (chunk: string, all: string) => void,
  timeoutMs = 10_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxLoader, entrypoint, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs}ms: ${args.join(' ')}\n${stderr}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      onStdout?.(chunk, stdout);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function sandbox(baseUrl = MOCK_BASE_URL): Promise<Sandbox> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-signup-'));
  const configDir = path.join(dir, 'config');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'project');
  await Promise.all([mkdir(configDir), mkdir(home), mkdir(cwd)]);
  const stateFile = path.join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ listCalls: 0, toolCalls: [] }));
  const preload = `--import=${pathToFileURL(mockPreload).href}`;
  return {
    dir,
    configDir,
    home,
    cwd,
    stateFile,
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')) as MockState,
    env: (extra = {}) => ({
      EVERY_MCP_URL: baseUrl,
      EVERY_CONFIG_DIR: configDir,
      EVERY_TOKEN: '',
      HOME: home,
      USERPROFILE: home,
      EVERYAI_FORCE_FILE_STORE: '1',
      EVERYAI_MOCK_MCP: '1',
      EVERYAI_MOCK_MCP_STATE: stateFile,
      EVERYAI_MOCK_BROWSER: '1',
      EVERYAI_MOCK_SIGNUP: '1',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '),
      ...extra,
    }),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

function lines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function lastLine(stdout: string): Record<string, unknown> {
  const parsed = lines(stdout);
  expect(parsed.length).toBeGreaterThan(0);
  return parsed[parsed.length - 1];
}

/** A stale-proof tools cache: fresh, but listing no signup tools at all. */
async function seedToolCacheWithoutSignup(box: Sandbox, baseUrl = MOCK_BASE_URL): Promise<void> {
  const key = baseUrl === STAGING_BASE_URL ? 'staging' : `custom_${baseUrl}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  await mkdir(path.join(box.configDir, 'cache'), { recursive: true });
  await writeFile(
    path.join(box.configDir, 'cache', `tools-${key}.json`),
    JSON.stringify({ fetched_at: new Date().toISOString(), tools: [{ name: 'list_invoices' }] }),
  );
}

async function writeSkill(dir: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  await writeFile(file, body);
  return file;
}

describe('every signup', () => {
  it('runs one OAuth authorization without a TTY and streams NDJSON in order', async () => {
    const box = await sandbox();
    try {
      await seedToolCacheWithoutSignup(box);
      const result = await runCli(['signup', '--json'], box.env(), box.cwd);

      expect(result.code, result.stderr).toBe(0);
      const out = lines(result.stdout);
      // The first event tells the agent how long the command waits (gap G5).
      expect(out[0]).toEqual({
        event: 'authorization_required',
        url: expect.any(String),
        timeout_seconds: 300,
        guidance: expect.stringMatching(/waits up to 300 seconds.*background.*at least 5 minutes/),
      });
      expect(out[1]).toEqual({
        event: 'waiting_for_authorization',
        browser_opened: true,
        timeout_seconds: 300,
      });
      expect(out[out.length - 1]).toEqual({
        ok: true,
        data: { ...envelopes.needs_profile, next_step: NEXT_STEP, skill: NO_HOST_SKILL },
        env: 'custom',
        schema_version: 1,
      });
      expect(out).toHaveLength(3);

      const state = box.state();
      // Exactly one authorization URL: printed once, opened once, requested once.
      expect(state.openedUrls).toEqual([out[0].url]);
      expect(state.authorizationRequests).toEqual([out[0].url]);
      expect(state.openedUrls.some((url) => url.includes('/sign-up'))).toBe(false);
      const authorize = new URL(String(out[0].url));
      expect(authorize.pathname).toBe('/authorize');
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorize.searchParams.get('resource')).toBe(MOCK_BASE_URL);
      expect(new URLSearchParams(state.tokenRequests[0]).get('resource')).toBe(MOCK_BASE_URL);

      // The fresh cache listed no signup tools; the command must not trust it.
      expect(state.listCalls).toBe(1);
      expect(state.toolCalls).toEqual([{ name: 'get_signup_status', arguments: {} }]);
      expect(JSON.parse(await readFile(path.join(box.configDir, 'tokens.json'), 'utf8'))).toMatchObject({
        tokens: { [`custom:${MOCK_BASE_URL}`]: { access_token: 'exchanged-token' } },
      });
    } finally {
      await box.close();
    }
  });

  it('prints the authorization URL as the first human line and the next step', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(['signup'], box.env(), box.cwd);

      expect(result.code, result.stderr).toBe(0);
      const [first] = result.stderr.split('\n');
      expect(first).toMatch(/^Authorize Every in your browser: http\S+\/authorize\?\S+$/);
      expect(result.stdout).toContain('Signup is not finished');
      expect(result.stdout).toContain('Acme Studio');
      expect(result.stdout).toMatch(/unverified/i);
      expect(result.stdout).toContain('Next step: ask the person for the organization name, then run:');
      expect(result.stdout).toContain('every signup complete --org-name "Acme Studio"');
      expect(result.stderr).not.toContain('deprecated');
    } finally {
      await box.close();
    }
  });

  it('tells the caller to share the URL when the browser cannot be opened', async () => {
    const box = await sandbox();
    try {
      let visited = false;
      const result = await runCli(
        ['signup', '--json'],
        box.env({ EVERYAI_MOCK_BROWSER_FAIL: '1' }),
        box.cwd,
        (_chunk, all) => {
          const parsed = all.split('\n').filter(Boolean);
          if (visited || parsed.length < 2) return;
          visited = true;
          // Play the human who opened the printed URL elsewhere: hit the CLI's
          // own loopback with the state from that URL.
          const authorize = new URL(String(JSON.parse(parsed[0]).url));
          const callback = new URL(authorize.searchParams.get('redirect_uri')!);
          callback.searchParams.set('state', authorize.searchParams.get('state')!);
          callback.searchParams.set('code', 'mock-code');
          void fetch(callback).catch(() => undefined);
        },
      );

      expect(result.code, result.stderr).toBe(0);
      const out = lines(result.stdout);
      expect(out[1]).toMatchObject({ event: 'waiting_for_authorization', browser_opened: false });
      expect(lastLine(result.stdout)).toMatchObject({ ok: true, data: { signup_status: 'needs_profile' } });
    } finally {
      await box.close();
    }
  });

  it('resumes a returning user whose account is already ready', async () => {
    const box = await sandbox();
    try {
      writeFileSync(box.stateFile, JSON.stringify({ listCalls: 0, toolCalls: [], signupReady: true }));
      const result = await runCli(['signup', '--json'], box.env(), box.cwd);

      expect(result.code, result.stderr).toBe(0);
      const last = lastLine(result.stdout);
      expect(last).toMatchObject({
        ok: true,
        data: { signup_status: 'ready', account_ready: true },
      });
      expect(last.data).not.toHaveProperty('next_step');
    } finally {
      await box.close();
    }
  });

  it('exits with the auth code and a resume hint when the user denies access', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(['signup', '--json'], box.env({ EVERYAI_MOCK_AUTHORIZE: 'deny' }), box.cwd);

      expect(result.code).toBe(3);
      expect(lastLine(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'auth', message: expect.stringContaining('every signup') },
      });
      expect(box.state().toolCalls).toEqual([]);
    } finally {
      await box.close();
    }
  });

  it('times out with the auth code and a resume hint when the browser step never finishes', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(
        ['signup', '--timeout', '1', '--json'],
        box.env({ EVERYAI_MOCK_AUTHORIZE: 'ignore' }),
        box.cwd,
      );

      expect(result.code).toBe(3);
      const out = lines(result.stdout);
      expect(out[0]).toMatchObject({
        event: 'authorization_required',
        timeout_seconds: 1,
        guidance: expect.stringContaining('waits up to 1 seconds'),
      });
      expect(out[1]).toMatchObject({ event: 'waiting_for_authorization', timeout_seconds: 1 });
      const error = lastLine(result.stdout).error as { code: string; message: string };
      expect(error.code).toBe('auth');
      expect(error.message).toContain('1s');
      expect(error.message).toContain('every signup');
    } finally {
      await box.close();
    }
  });

  it('rejects an invalid --timeout as usage before any network call', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(['signup', '--timeout', '0', '--json'], box.env(), box.cwd);
      expect(result.code).toBe(2);
      expect(box.state().authorizationRequests ?? []).toEqual([]);
    } finally {
      await box.close();
    }
  });

  it('never treats EVERY_TOKEN as a signup path', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(['signup', '--json'], box.env({ EVERY_TOKEN: 'test-token' }), box.cwd);

      expect(result.code).toBe(2);
      expect(lastLine(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'usage', message: expect.stringContaining('EVERY_TOKEN') },
      });
      expect(box.state().openedUrls ?? []).toEqual([]);
    } finally {
      await box.close();
    }
  });

  it('targets staging with --staging and stores staging credentials', async () => {
    const box = await sandbox(STAGING_BASE_URL);
    try {
      const result = await runCli(['signup', '--staging', '--json'], box.env(), box.cwd);

      expect(result.code, result.stderr).toBe(0);
      expect(lastLine(result.stdout)).toMatchObject({ ok: true, env: 'staging' });
      expect(new URL(String(lines(result.stdout)[0].url)).searchParams.get('resource')).toBe(STAGING_BASE_URL);
      expect(JSON.parse(await readFile(path.join(box.configDir, 'tokens.json'), 'utf8'))).toMatchObject({
        tokens: { staging: { access_token: 'exchanged-token' } },
      });
    } finally {
      await box.close();
    }
  });

  it('explains a server without the signup tools with a stable code', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(['signup', '--json'], box.env({ EVERYAI_MOCK_SIGNUP: '0' }), box.cwd);

      expect(result.code).toBe(6);
      expect(lastLine(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: 'signup_unsupported',
          message: expect.stringContaining('this server does not support agent signup yet'),
        },
      });
      expect(box.state().toolCalls).toEqual([]);
    } finally {
      await box.close();
    }
  });
});

describe('every signup status', () => {
  it('returns the server envelope and bypasses a fresh tools cache', async () => {
    const box = await sandbox();
    try {
      await seedToolCacheWithoutSignup(box);
      const result = await runCli(['signup', 'status', '--json'], box.env({ EVERY_TOKEN: 'test-token' }), box.cwd);

      expect(result.code, result.stderr).toBe(0);
      // `signup status` states the next step and never installs a skill.
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        data: { ...envelopes.needs_profile, next_step: NEXT_STEP },
        env: 'custom',
        schema_version: 1,
      });
      expect(box.state().listCalls).toBe(1);
      expect(box.state().openedUrls ?? []).toEqual([]);
    } finally {
      await box.close();
    }
  });

  it('uses the unsupported-server code when the tool is missing', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(
        ['signup', 'status', '--json'],
        box.env({ EVERY_TOKEN: 'test-token', EVERYAI_MOCK_SIGNUP: '0' }),
        box.cwd,
      );
      expect(result.code).toBe(6);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'signup_unsupported' } });
    } finally {
      await box.close();
    }
  });
});

describe('every signup complete', () => {
  it('requires --yes without a TTY and makes no tool call', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(
        ['signup', 'complete', '--org-name', 'Acme Studio', '--json'],
        box.env({ EVERY_TOKEN: 'test-token' }),
        box.cwd,
      );
      expect(result.code).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'permission' } });
      expect(box.state().toolCalls).toEqual([]);
    } finally {
      await box.close();
    }
  });

  it('sends the confirmed profile, retries the server confirmation once, and needs no --allow-destructive', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(
        [
          'signup', 'complete',
          '--org-name', '  Acme Studio  ',
          '--description', 'Brand strategy for independent restaurants.',
          '--link', 'https://acme.example',
          '--link', 'https://www.linkedin.com/company/acme',
          '--yes', '--json',
        ],
        box.env({ EVERY_TOKEN: 'test-token', EVERYAI_MOCK_CONFIRMATION_GATE: '1' }),
        box.cwd,
      );

      expect(result.code, result.stdout + result.stderr).toBe(0);
      const args = {
        organization_name: 'Acme Studio',
        description: 'Brand strategy for independent restaurants.',
        public_links: ['https://acme.example', 'https://www.linkedin.com/company/acme'],
      };
      expect(box.state().toolCalls).toEqual([
        { name: 'complete_signup', arguments: args },
        { name: 'complete_signup', arguments: { ...args, confirmation: 'complete signup' } },
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          signup_status: 'ready',
          account_ready: true,
          saved_fields: ['organization_name', 'description', 'public_links'],
          background_setup: { state: 'queued' },
        },
      });
    } finally {
      await box.close();
    }
  });

  it('sends only the name when the optional fields are omitted', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(
        ['signup', 'complete', '--org-name', 'Acme Studio', '--yes'],
        box.env({ EVERY_TOKEN: 'test-token' }),
        box.cwd,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(box.state().toolCalls).toEqual([
        { name: 'complete_signup', arguments: { organization_name: 'Acme Studio' } },
      ]);
      expect(result.stdout).toContain('Account ready');
      expect(result.stdout).toMatch(/Background setup/);
    } finally {
      await box.close();
    }
  });

  it.each([
    [['--org-name', '   '], 'org-name'],
    [['--org-name', 'Acme', '--link', 'http://acme.example'], 'https'],
    [['--org-name', 'Acme', '--link', 'not a url'], 'https'],
  ])('rejects invalid input %j as usage before any tool call', async (flags, fragment) => {
    const box = await sandbox();
    try {
      const result = await runCli(
        ['signup', 'complete', ...flags, '--yes', '--json'],
        box.env({ EVERY_TOKEN: 'test-token' }),
        box.cwd,
      );
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'usage', message: expect.stringContaining(fragment) },
      });
      expect(box.state().toolCalls).toEqual([]);
    } finally {
      await box.close();
    }
  });
});

describe('signup gate refusals from other commands', () => {
  it('turns signup_incomplete into guidance to finish signup, keeping exit 1', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(
        ['tool', 'call', 'list_invoices', '--json'],
        box.env({ EVERY_TOKEN: 'test-token', EVERYAI_MOCK_SIGNUP_GATE: '1' }),
        box.cwd,
      );
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout) as { error: { code: string; message: string } };
      expect(parsed.error.code).toBe('signup_incomplete');
      expect(parsed.error.message).toContain('every signup status');
      expect(parsed.error.message).toContain('every signup complete');
    } finally {
      await box.close();
    }
  });
});

describe('every login --create-account', () => {
  it('runs signup without a TTY and keeps --json output free of the deprecation note', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(['login', '--create-account', '--json'], box.env(), box.cwd);

      expect(result.code, result.stderr).toBe(0);
      expect(lines(result.stdout)[0]).toMatchObject({ event: 'authorization_required' });
      expect(lastLine(result.stdout)).toMatchObject({ ok: true, data: { signup_status: 'needs_profile' } });
      expect(result.stderr).not.toContain('deprecated');
      expect(box.state().openedUrls).toHaveLength(1);
    } finally {
      await box.close();
    }
  });

  it('prints a deprecation hint in human output', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(['login', '--create-account'], box.env(), box.cwd);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('`every login --create-account` is deprecated; use `every signup`');
      expect(result.stdout).toContain('Signup is not finished');
    } finally {
      await box.close();
    }
  });

  it('keeps EVERY_TOKEN behaviour unchanged', async () => {
    const box = await sandbox();
    try {
      const result = await runCli(['login', '--create-account', '--json'], box.env({ EVERY_TOKEN: 'test-token' }), box.cwd);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { every_token: true } });
      expect(box.state().openedUrls ?? []).toEqual([]);
    } finally {
      await box.close();
    }
  });
});

describe('installed skill refresh on signup', () => {
  it('refreshes stale installed copies and installs nowhere new when the offer was declined', async () => {
    const box = await sandbox();
    try {
      const unstamped = await writeSkill(path.join(box.home, '.claude', 'skills', 'use-every'), '# old skill\n');
      const newer = await writeSkill(
        path.join(box.cwd, '.agents', 'skills', 'use-every'),
        '---\nname: use-every\nmetadata:\n  every-skill-version: "999"\n---\n# from the future\n',
      );
      // The user declined the install offer earlier; that must still hold.
      await writeFile(path.join(box.configDir, 'hints.json'), JSON.stringify({ skill_offer_declined: true }));

      const result = await runCli(['signup', '--json'], box.env(), box.cwd);

      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(unstamped, 'utf8')).toBe(bundledSkill);
      expect(await readFile(newer, 'utf8')).toContain('# from the future');
      expect(result.stderr).toContain(`Updated the use-every skill at ${path.dirname(unstamped)}`);
      expect((lastLine(result.stdout).data as { skill: unknown }).skill).toMatchObject({
        installed: [],
        skipped_reason: 'declined',
      });
      for (const notInstalled of [
        path.join(box.cwd, '.claude', 'skills', 'use-every'),
        path.join(box.home, '.codex', 'skills', 'use-every'),
        path.join(box.home, '.agents', 'skills', 'use-every'),
      ]) {
        await expect(readFile(path.join(notInstalled, 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await box.close();
    }
  });
});

describe('skill install after an agent-run signup', () => {
  interface SkillReport {
    installed: Array<{ host: string; path: string }>;
    already_present: Array<{ host: string; path: string }>;
    failed: Array<{ host: string; path: string; reason: string }>;
    skipped_reason: string | null;
  }
  const skillOf = (stdout: string) => (lastLine(stdout).data as { skill: SkillReport }).skill;

  it('installs the skill at user level for each detected host, then reports already_present', async () => {
    const box = await sandbox();
    try {
      await Promise.all([mkdir(path.join(box.home, '.claude')), mkdir(path.join(box.home, '.codex'))]);
      const claudeSkill = path.join(box.home, '.claude', 'skills', 'use-every');
      const codexSkill = path.join(box.home, '.agents', 'skills', 'use-every');

      const first = await runCli(['signup', '--json'], box.env(), box.cwd);

      expect(first.code, first.stderr).toBe(0);
      expect(skillOf(first.stdout)).toEqual({
        name: 'use-every',
        installed: [
          { host: 'claude', path: claudeSkill },
          { host: 'codex', path: codexSkill },
        ],
        already_present: [],
        failed: [],
        skipped_reason: null,
      });
      expect(await readFile(path.join(claudeSkill, 'SKILL.md'), 'utf8')).toBe(bundledSkill);
      expect(await readFile(path.join(codexSkill, 'SKILL.md'), 'utf8')).toBe(bundledSkill);
      // stdout stays pure NDJSON; the notice goes to stderr.
      expect(lines(first.stdout)).toHaveLength(3);
      expect(first.stderr).toContain(`Installed the use-every skill for Claude Code at ${claudeSkill}`);
      // Nothing lands in the project.
      await expect(readFile(path.join(box.cwd, '.claude', 'skills', 'use-every', 'SKILL.md'))).rejects
        .toMatchObject({ code: 'ENOENT' });

      const second = await runCli(['signup', '--json'], box.env(), box.cwd);
      expect(second.code, second.stderr).toBe(0);
      expect(skillOf(second.stdout)).toMatchObject({
        installed: [],
        already_present: [
          { host: 'claude', path: claudeSkill },
          { host: 'codex', path: codexSkill },
        ],
        skipped_reason: null,
      });
    } finally {
      await box.close();
    }
  });

  it('installs the skill for a returning user whose account is already ready', async () => {
    const box = await sandbox();
    try {
      writeFileSync(box.stateFile, JSON.stringify({ listCalls: 0, toolCalls: [], signupReady: true }));
      await mkdir(path.join(box.home, '.claude'));
      const result = await runCli(['signup', '--json'], box.env(), box.cwd);

      expect(result.code, result.stderr).toBe(0);
      expect(lastLine(result.stdout)).toMatchObject({ data: { signup_status: 'ready', account_ready: true } });
      expect(skillOf(result.stdout).installed).toEqual([
        { host: 'claude', path: path.join(box.home, '.claude', 'skills', 'use-every') },
      ]);
    } finally {
      await box.close();
    }
  });

  it('skips the install with --no-skill', async () => {
    const box = await sandbox();
    try {
      await mkdir(path.join(box.home, '.claude'));
      const result = await runCli(['signup', '--no-skill', '--json'], box.env(), box.cwd);

      expect(result.code, result.stderr).toBe(0);
      expect(skillOf(result.stdout)).toMatchObject({ installed: [], skipped_reason: 'opt_out' });
      await expect(readFile(path.join(box.home, '.claude', 'skills', 'use-every', 'SKILL.md'))).rejects
        .toMatchObject({ code: 'ENOENT' });
    } finally {
      await box.close();
    }
  });

  it('keeps the signup successful when the install fails', async () => {
    const box = await sandbox();
    try {
      // `skills` is a file, so the copy into ~/.claude/skills/use-every cannot succeed.
      await mkdir(path.join(box.home, '.claude'));
      await writeFile(path.join(box.home, '.claude', 'skills'), 'not a directory');
      const result = await runCli(['signup', '--json'], box.env(), box.cwd);

      expect(result.code, result.stderr).toBe(0);
      expect(lastLine(result.stdout)).toMatchObject({ ok: true, data: { signup_status: 'needs_profile' } });
      const skill = skillOf(result.stdout);
      expect(skill.installed).toEqual([]);
      expect(skill.failed).toEqual([
        {
          host: 'claude',
          path: path.join(box.home, '.claude', 'skills', 'use-every'),
          reason: expect.any(String),
        },
      ]);
      expect(result.stderr).toContain('Warning: could not install the use-every skill for Claude Code');
    } finally {
      await box.close();
    }
  });

  it('installs without --json when there is no TTY and says so in plain words', async () => {
    const box = await sandbox();
    try {
      await mkdir(path.join(box.home, '.agents'));
      const codexSkill = path.join(box.home, '.agents', 'skills', 'use-every');
      const first = await runCli(['signup'], box.env(), box.cwd);
      expect(first.code, first.stderr).toBe(0);
      expect(first.stderr).toContain(`Installed the use-every skill for Codex at ${codexSkill}`);
      expect(await readFile(path.join(codexSkill, 'SKILL.md'), 'utf8')).toBe(bundledSkill);

      const second = await runCli(['signup'], box.env(), box.cwd);
      expect(second.stdout).toContain(`The use-every skill is already installed for Codex at ${codexSkill}.`);
    } finally {
      await box.close();
    }
  });
});

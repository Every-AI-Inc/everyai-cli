import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/commands/tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/commands/tools')>()),
  invokeToolCall: vi.fn(async (tool: string) => ({
    tool,
    structured_content: { signup_status: 'needs_profile', account_ready: false },
  })),
}));
vi.mock('../src/lib/auth/userinfo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth/userinfo')>()),
  requestUserInfo: vi.fn(async () => ({
    user_id: 'user_1',
    email: 'owner@example.com',
    org_id: 'org_1',
    org_slug: null,
    org_name: 'Owner',
  })),
}));

import { signupCommand, signupNextStep, signupWaitGuidance } from '../src/commands/signup';
import type { LoginFlowOptions } from '../src/lib/auth/flow';
import type { StoredTokenSet, TokenStore } from '../src/lib/auth/tokens';

const SKILL_OFFER = 'Teach your coding agent to use Every?';

function capture(isTTY: boolean): { stream: Writable & { isTTY: boolean }; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  }) as Writable & { isTTY: boolean };
  stream.isTTY = isTTY;
  return { stream, text: () => chunks.join('') };
}

function input(text: string, isTTY: boolean): Readable & { isTTY: boolean } {
  const stream = Readable.from([text]) as Readable & { isTTY: boolean };
  stream.isTTY = isTTY;
  return stream;
}

function memoryStore(): TokenStore {
  const tokens = new Map<string, StoredTokenSet>();
  return {
    backend: 'file',
    get: async (key) => tokens.get(key),
    set: async (key, value) => void tokens.set(key, value),
    delete: async (key) => void tokens.delete(key),
  };
}

async function fakeLoginFlow(opts: LoginFlowOptions): Promise<StoredTokenSet> {
  opts.onAuthorizationUrl?.('https://auth.example/authorize?state=abc');
  opts.onBrowserOpened?.(true);
  return {
    issuer: 'https://auth.example',
    client_id: 'client',
    access_token: 'token',
    expires_at: 4102444800,
    scope: 'openid',
  };
}

let root: string;
let cwd: string;
let homeDir: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-signup-flow-'));
  cwd = path.join(root, 'project');
  homeDir = path.join(root, 'home');
  await Promise.all([mkdir(cwd), mkdir(path.join(homeDir, '.claude'), { recursive: true })]);
  process.env.EVERY_CONFIG_DIR = path.join(root, 'config');
  process.env.EVERY_MCP_URL = 'https://mock-mcp.everyai.test';
  delete process.env.EVERY_TOKEN;
});

afterEach(async () => {
  process.env = { ...savedEnv };
  await rm(root, { recursive: true, force: true });
});

function run(
  opts: Parameters<typeof signupCommand>[0],
  io: { tty: boolean; answer?: string },
) {
  const stdout = capture(io.tty);
  const stderr = capture(io.tty);
  const promise = signupCommand(opts, {
    input: input(io.answer ?? '', io.tty),
    output: stdout.stream,
    errorOutput: stderr.stream,
    loginFlow: fakeLoginFlow,
    store: memoryStore(),
    skillRefresh: { cwd, homeDir },
  });
  return { promise, stdout, stderr };
}

const userSkill = () => path.join(homeDir, '.claude', 'skills', 'use-every', 'SKILL.md');
const projectSkill = () => path.join(cwd, '.claude', 'skills', 'use-every', 'SKILL.md');

describe('signup text helpers', () => {
  it('states the wait and the two ways to survive it', () => {
    expect(signupWaitGuidance(300)).toBe(
      'This command waits up to 300 seconds for the person to finish the browser step. ' +
        'Run it in the background, or allow a tool timeout of at least 5 minutes. ' +
        'Do not stop it before the last line.',
    );
    expect(signupWaitGuidance(30)).toContain('at least 1 minute.');
    expect(signupWaitGuidance(301)).toContain('at least 6 minutes');
  });

  it('gives a next step only while the account is not ready', () => {
    expect(signupNextStep({ account_ready: false })).toBe(
      'Ask the person for the organization name, then run: every signup complete --org-name "<name>" --yes --json',
    );
    expect(signupNextStep({ account_ready: true })).toBeUndefined();
  });
});

describe('every signup: person at a terminal', () => {
  it('still offers the skill interactively and installs the chosen project copy', async () => {
    const { promise, stdout, stderr } = run({}, { tty: true, answer: '1\n' });
    await promise;

    expect(stderr.text()).toContain(SKILL_OFFER);
    expect(stdout.text()).toContain('Signup is not finished');
    expect(stdout.text()).toContain('commit it to share with your team');
    expect(await readFile(projectSkill(), 'utf8')).toContain('name: use-every');
    // No silent user-level install for a person who can answer.
    await expect(readFile(userSkill())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('installs nothing when the person presses Enter', async () => {
    const { promise, stderr } = run({}, { tty: true, answer: '\n' });
    await promise;

    expect(stderr.text()).toContain(SKILL_OFFER);
    await expect(readFile(projectSkill())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(userSkill())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not offer with --no-skill', async () => {
    const { promise, stderr } = run({ skill: false }, { tty: true, answer: '1\n' });
    await promise;

    expect(stderr.text()).not.toContain(SKILL_OFFER);
    await expect(readFile(projectSkill())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('every signup: agent', () => {
  it('with --json on a TTY installs at user level, never prompts, and keeps stdout NDJSON', async () => {
    const { promise, stdout, stderr } = run({ json: true }, { tty: true, answer: '1\n' });
    await promise;

    expect(stderr.text()).not.toContain(SKILL_OFFER);
    const out = stdout.text().trim().split('\n').map((line) => JSON.parse(line));
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      event: 'authorization_required',
      timeout_seconds: 300,
      guidance: expect.stringContaining('at least 5 minutes'),
    });
    expect(out[2].data.skill).toMatchObject({
      installed: [{ host: 'claude', path: path.dirname(userSkill()) }],
      skipped_reason: null,
    });
    expect(out[2].data.next_step).toContain('every signup complete --org-name "<name>" --yes --json');
    expect(await readFile(userSkill(), 'utf8')).toContain('name: use-every');
  });

  it('without a TTY installs at user level and prints no offer', async () => {
    const { promise, stdout, stderr } = run({}, { tty: false });
    await promise;

    expect(stderr.text()).not.toContain(SKILL_OFFER);
    expect(stderr.text()).toContain('Installed the use-every skill for Claude Code');
    expect(stdout.text()).toContain('Next step: ask the person for the organization name');
    expect(await readFile(userSkill(), 'utf8')).toContain('name: use-every');
  });
});

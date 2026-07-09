import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 5_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
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

function parseJsonStdout(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed).not.toBe('');
  return JSON.parse(trimmed) as Record<string, unknown>;
}

describe('CLI contract', () => {
  it('uses usage exit code 2 without stdout for human unknown commands', async () => {
    const result = await runCli(['frobnicate']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe("error: unknown command 'frobnicate'");
  });

  it('emits a JSON usage envelope for unknown commands in --json mode', async () => {
    const result = await runCli(['frobnicate', '--json']);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    const parsed = parseJsonStdout(result.stdout);
    expect(parsed).toMatchObject({
      ok: false,
      error: { code: 'usage' },
      schema_version: 1,
    });
    expect(JSON.stringify(parsed)).not.toContain('Error:');
  });

  it('maps subcommand option errors to usage exit code 2', async () => {
    const result = await runCli(['ping', '--bad-option', '--json']);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(parseJsonStdout(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'usage' },
      schema_version: 1,
    });
  });

  it('emits version through the JSON envelope when --json is set', async () => {
    const result = await runCli(['--json', '--version']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseJsonStdout(result.stdout)).toEqual({
      ok: true,
      data: { version: '0.0.0' },
      schema_version: 1,
    });
  });

  it('emits help through the JSON envelope when --json is set', async () => {
    const result = await runCli(['--json', '--help']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = parseJsonStdout(result.stdout);
    expect(parsed).toMatchObject({ ok: true, schema_version: 1 });
    expect((parsed.data as { help: string }).help).toContain('Usage: every');
  });

  it('emits auth status through the JSON envelope without requiring login', async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-status-'));
    try {
      const result = await runCli(['auth', 'status', '--json'], {
        EVERY_CONFIG_DIR: configDir,
        EVERYAI_FORCE_FILE_STORE: '1',
        EVERY_TOKEN: '',
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true,
        data: {
          logged_in: false,
          storage_backend: 'file',
          every_token: false,
        },
        schema_version: 1,
      });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('fails fast with exit 3 when login is run without a TTY', async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-login-'));
    try {
      const result = await runCli(['login', '--json'], {
        EVERY_CONFIG_DIR: configDir,
        EVERYAI_FORCE_FILE_STORE: '1',
        EVERY_TOKEN: '',
      });

      expect(result.code).toBe(3);
      expect(result.stderr).toBe('');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: 'auth',
          message: 'login requires a browser; set EVERY_TOKEN for headless use',
        },
        schema_version: 1,
      });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

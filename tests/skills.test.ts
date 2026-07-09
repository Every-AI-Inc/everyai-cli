import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');
const skillPath = path.join(repoRoot, 'skills', 'use-every', 'SKILL.md');

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], timeoutMs = 5_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
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

function parseFrontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).not.toBeNull();

  const fields: Record<string, string> = {};
  for (const line of match![1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) fields[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return fields;
}

describe('skills commands', () => {
  it('installs the bundled use-every skill to a custom dir idempotently', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-skills-'));
    try {
      const first = await runCli(['skills', 'install', 'claude', '--dir', dir, '--json']);
      const second = await runCli(['skills', 'install', 'claude', '--dir', dir, '--json']);

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(first.stderr).toBe('');
      expect(second.stderr).toBe('');

      const parsed = parseJsonStdout(second.stdout);
      expect(parsed).toMatchObject({
        ok: true,
        data: {
          installed_to: path.join(dir, 'use-every'),
          files: ['SKILL.md'],
        },
        schema_version: 1,
      });
      expect(existsSync(path.join(dir, 'use-every', 'SKILL.md'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns usage exit code for unknown skills targets', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-skills-'));
    try {
      const result = await runCli(['skills', 'install', 'unknown', '--dir', dir, '--json']);

      expect(result.code).toBe(2);
      expect(result.stderr).toBe('');
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'usage' },
        schema_version: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists bundled skills and target install locations', async () => {
    const result = await runCli(['skills', 'list', '--json']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseJsonStdout(result.stdout)).toMatchObject({
      ok: true,
      data: {
        skills: [
          {
            name: 'use-every',
            targets: {
              claude: { install_to: expect.stringContaining(path.join('.claude', 'skills', 'use-every')) },
              codex: { install_to: expect.stringContaining(path.join('.agents', 'skills', 'use-every')) },
            },
          },
        ],
      },
      schema_version: 1,
    });
  });
});

describe('use-every skill contract', () => {
  it('has parseable frontmatter and mentions core safety flags', () => {
    const text = readFileSync(skillPath, 'utf8');
    const frontmatter = parseFrontmatter(text);

    expect(frontmatter.name).toBe('use-every');
    // Assert shape, not verbatim copy — the description is editable content.
    expect(frontmatter.description).toMatch(/Every AI CLI/);
    expect(frontmatter.description).toMatch(/invoices/);
    expect(frontmatter.description.length).toBeGreaterThan(40);
    expect(text).toContain('--yes');
    expect(text).toContain('--allow-destructive');
    expect(text).toContain('--json');
    expect(text).toContain('creation-only');
    expect(text).toContain('sales_tax_applied');
    expect(text).toMatch(/paginate/i);
    expect(text).toContain('server-enforced read-only');
  });
});

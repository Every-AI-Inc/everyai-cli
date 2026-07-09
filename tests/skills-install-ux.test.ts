import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');
const tsxLoader = pathToFileURL(path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--import=${tsxLoader}`, entrypoint, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('skills install completion guidance', () => {
  it('suggests a detected other host and mentions global installs via --dir', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-skills-ux-'));
    const destination = path.join(cwd, 'claude-skills');
    try {
      await mkdir(path.join(cwd, '.agents'));
      const result = await runCli(['skills', 'install', 'claude', '--dir', destination], cwd);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Codex detected — also run: every skills install codex');
      expect(result.stdout).toContain('For a global install, use --dir <path>.');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not suggest the other host when its skill is already installed', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-skills-ux-'));
    const destination = path.join(cwd, 'claude-skills');
    try {
      await mkdir(path.join(cwd, '.agents', 'skills', 'use-every'), { recursive: true });
      const result = await runCli(['skills', 'install', 'claude', '--dir', destination], cwd);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('also run: every skills install codex');
      expect(result.stdout).toContain('For a global install, use --dir <path>.');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

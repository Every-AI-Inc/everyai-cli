import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoInstallSkill, userSkillTargets } from '../src/lib/skill-auto-install';
import { bundledSkillDir, skillInstallPaths } from '../src/lib/skill-refresh';

let root: string;
let cwd: string;
let homeDir: string;
let log: string;
const errorOutput = new Writable({ write(chunk, _encoding, done) { log += String(chunk); done(); } });
const noHints = async () => ({});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-skill-auto-'));
  cwd = path.join(root, 'project');
  homeDir = path.join(root, 'home');
  await Promise.all([mkdir(cwd), mkdir(homeDir)]);
  log = '';
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(extra: Parameters<typeof autoInstallSkill>[0] = {}) {
  return autoInstallSkill({ cwd, homeDir, errorOutput, readHints: noHints, ...extra });
}

describe('userSkillTargets', () => {
  it('installs only into paths that the refresh recognizes', () => {
    const targets = userSkillTargets(homeDir);
    const known = skillInstallPaths(cwd, homeDir);
    expect(known.claude).toContain(targets.claude.target);
    expect(known.codex).toContain(targets.codex.target);
    expect(targets.claude.target.startsWith(homeDir)).toBe(true);
    expect(targets.codex.target.startsWith(homeDir)).toBe(true);
  });
});

describe('autoInstallSkill', () => {
  it('reports no_agent_host and writes nothing when no host is detected', async () => {
    const result = await run();
    expect(result).toEqual({
      name: 'use-every',
      installed: [],
      already_present: [],
      failed: [],
      skipped_reason: 'no_agent_host',
    });
    expect(log).toBe('');
  });

  it('installs the bundled skill at user level for Claude Code when ~/.claude exists', async () => {
    await mkdir(path.join(homeDir, '.claude'));
    const result = await run();
    const target = path.join(homeDir, '.claude', 'skills', 'use-every');
    expect(result).toMatchObject({
      installed: [{ host: 'claude', path: target }],
      already_present: [],
      failed: [],
      skipped_reason: null,
    });
    expect(await readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe(
      await readFile(path.join(bundledSkillDir(), 'SKILL.md'), 'utf8'),
    );
    expect(log).toContain(`Installed the use-every skill for Claude Code at ${target}`);
  });

  it.each(['.codex', '.agents'])('detects Codex from ~/%s and installs to ~/.agents/skills', async (marker) => {
    await mkdir(path.join(homeDir, marker));
    const result = await run();
    const target = path.join(homeDir, '.agents', 'skills', 'use-every');
    expect(result.installed).toEqual([{ host: 'codex', path: target }]);
    expect(result.skipped_reason).toBeNull();
    expect(await readFile(path.join(target, 'SKILL.md'), 'utf8')).toContain('name: use-every');
  });

  it('installs for both hosts when both are detected', async () => {
    await Promise.all([mkdir(path.join(homeDir, '.claude')), mkdir(path.join(homeDir, '.codex'))]);
    const result = await run();
    expect(result.installed.map((entry) => entry.host)).toEqual(['claude', 'codex']);
  });

  it('reports already_present and leaves an existing user-level copy untouched', async () => {
    const existing = path.join(homeDir, '.codex', 'skills', 'use-every');
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, 'SKILL.md'), '# mine\n');

    const result = await run();

    expect(result).toMatchObject({
      installed: [],
      already_present: [{ host: 'codex', path: existing }],
      skipped_reason: null,
    });
    expect(await readFile(path.join(existing, 'SKILL.md'), 'utf8')).toBe('# mine\n');
    expect(log).toBe('');
  });

  it('still installs at user level when only a project copy exists in the current folder', async () => {
    const projectCopy = path.join(cwd, '.claude', 'skills', 'use-every');
    await mkdir(projectCopy, { recursive: true });
    await mkdir(path.join(homeDir, '.claude'));

    const result = await run();

    const userCopy = path.join(homeDir, '.claude', 'skills', 'use-every');
    expect(result).toMatchObject({
      installed: [{ host: 'claude', path: userCopy }],
      already_present: [],
      skipped_reason: null,
    });
    expect(await readFile(path.join(userCopy, 'SKILL.md'), 'utf8')).toContain('name: use-every');
  });

  it('is idempotent: a second run reports already_present', async () => {
    await mkdir(path.join(homeDir, '.claude'));
    const first = await run();
    const second = await run();
    expect(second.installed).toEqual([]);
    expect(second.already_present).toEqual(first.installed);
  });

  it('respects the skill_offer_declined hint', async () => {
    await mkdir(path.join(homeDir, '.claude'));
    const copySkill = vi.fn();
    const result = await run({ readHints: async () => ({ skill_offer_declined: true }), copySkill });
    expect(result).toMatchObject({ installed: [], skipped_reason: 'declined' });
    expect(copySkill).not.toHaveBeenCalled();
  });

  it('does nothing when disabled (--no-skill)', async () => {
    await mkdir(path.join(homeDir, '.claude'));
    const copySkill = vi.fn();
    const readHints = vi.fn(noHints);
    const result = await run({ enabled: false, copySkill, readHints });
    expect(result).toMatchObject({ installed: [], skipped_reason: 'opt_out' });
    expect(copySkill).not.toHaveBeenCalled();
    expect(readHints).not.toHaveBeenCalled();
  });

  it('records a failed copy, warns, and continues with the other host', async () => {
    await Promise.all([mkdir(path.join(homeDir, '.claude')), mkdir(path.join(homeDir, '.codex'))]);
    const copySkill = vi.fn(async (_source: string, target: string) => {
      if (target.includes('.claude')) throw new Error('EACCES: permission denied');
    });
    const result = await run({ copySkill });
    expect(result.failed).toEqual([
      {
        host: 'claude',
        path: path.join(homeDir, '.claude', 'skills', 'use-every'),
        reason: 'EACCES: permission denied',
      },
    ]);
    expect(result.installed.map((entry) => entry.host)).toEqual(['codex']);
    expect(log).toContain('Warning: could not install the use-every skill for Claude Code');
    expect(log).toContain('every skills install claude --global');
  });

  it('never throws: an unexpected error becomes skipped_reason error', async () => {
    const result = await run({
      readHints: async () => {
        throw new Error('boom');
      },
    });
    expect(result).toMatchObject({ installed: [], skipped_reason: 'error' });
    expect(log).toContain('Warning');
  });
});

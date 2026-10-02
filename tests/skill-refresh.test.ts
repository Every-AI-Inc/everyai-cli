import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bundledSkillDir,
  parseSkillVersion,
  refreshInstalledSkills,
} from '../src/lib/skill-refresh';

let root: string;
let cwd: string;
let homeDir: string;
let bundled: string;
let log: string;
const errorOutput = new Writable({ write(chunk, _encoding, done) { log += String(chunk); done(); } });

async function install(dir: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), body);
  return path.join(dir, 'SKILL.md');
}

function stamped(version: number | string, extra = ''): string {
  return `---\nname: use-every\nmetadata:\n  every-skill-version: "${version}"\n---\n${extra}`;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'everyai-cli-skill-refresh-'));
  cwd = path.join(root, 'project');
  homeDir = path.join(root, 'home');
  await Promise.all([mkdir(cwd), mkdir(homeDir)]);
  bundled = await readFile(path.join(bundledSkillDir(), 'SKILL.md'), 'utf8');
  log = '';
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('bundled skill stamp', () => {
  it('carries a parseable integer revision', () => {
    expect(parseSkillVersion(bundled)).toBeGreaterThanOrEqual(2);
  });

  it('reads unstamped and body-only mentions as missing', () => {
    expect(parseSkillVersion('# no frontmatter\nevery-skill-version: "9"\n')).toBeUndefined();
    expect(parseSkillVersion('---\nname: use-every\n---\n  every-skill-version: "9"\n')).toBeUndefined();
    expect(parseSkillVersion(stamped(7))).toBe(7);
  });
});

describe('refreshInstalledSkills', () => {
  it('replaces older and unstamped installs in every known location', async () => {
    const older = await install(path.join(cwd, '.claude', 'skills', 'use-every'), stamped(1, '# older\n'));
    const missing = await install(path.join(homeDir, '.codex', 'skills', 'use-every'), '# unstamped\n');
    await writeFile(path.join(path.dirname(older), 'stale-extra.md'), 'left over');

    const refreshed = await refreshInstalledSkills({ cwd, homeDir, errorOutput });

    expect(await readFile(older, 'utf8')).toBe(bundled);
    expect(await readFile(missing, 'utf8')).toBe(bundled);
    await expect(readFile(path.join(path.dirname(older), 'stale-extra.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(refreshed.map((entry) => [entry.path, entry.from])).toEqual([
      [path.dirname(older), 1],
      [path.dirname(missing), null],
    ]);
    expect(log).toContain(`Updated the use-every skill at ${path.dirname(older)}`);
  });

  it('leaves current and newer installs alone and never installs where none exists', async () => {
    const version = parseSkillVersion(bundled)!;
    const current = await install(path.join(homeDir, '.claude', 'skills', 'use-every'), stamped(version, '# mine\n'));
    const newer = await install(path.join(homeDir, '.agents', 'skills', 'use-every'), stamped(version + 1, '# newer\n'));

    expect(await refreshInstalledSkills({ cwd, homeDir, errorOutput })).toEqual([]);

    expect(await readFile(current, 'utf8')).toContain('# mine');
    expect(await readFile(newer, 'utf8')).toContain('# newer');
    for (const absent of [
      path.join(cwd, '.claude', 'skills', 'use-every'),
      path.join(cwd, '.agents', 'skills', 'use-every'),
      path.join(homeDir, '.codex', 'skills', 'use-every'),
    ]) {
      await expect(readFile(path.join(absent, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(log).toBe('');
  });

  it('skips a symlinked install, which something else manages', async () => {
    const target = path.join(root, 'managed-skill');
    const managed = await install(target, '# managed elsewhere\n');
    await mkdir(path.join(cwd, '.claude', 'skills'), { recursive: true });
    await symlink(target, path.join(cwd, '.claude', 'skills', 'use-every'));

    expect(await refreshInstalledSkills({ cwd, homeDir, errorOutput })).toEqual([]);
    expect(await readFile(managed, 'utf8')).toBe('# managed elsewhere\n');
  });

  it('never throws, even when the bundled source is unreadable', async () => {
    await install(path.join(cwd, '.claude', 'skills', 'use-every'), '# unstamped\n');
    await expect(
      refreshInstalledSkills({ cwd, homeDir, errorOutput, sourceDir: path.join(root, 'nope') }),
    ).resolves.toEqual([]);
  });
});

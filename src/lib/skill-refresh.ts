import { cp, lstat, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'use-every';
/** Frontmatter `metadata` key carrying the bundled skill's integer revision. */
export const SKILL_VERSION_KEY = 'every-skill-version';

export type SkillHost = 'claude' | 'codex';

/**
 * Every place the CLI installs (`every skills install`, the post-login offer) or
 * recognizes an installed `use-every` skill. Refresh only ever touches these.
 */
export function skillInstallPaths(cwd: string, homeDir: string): Record<SkillHost, string[]> {
  return {
    claude: [
      path.join(cwd, '.claude', 'skills', SKILL_NAME),
      path.join(homeDir, '.claude', 'skills', SKILL_NAME),
    ],
    codex: [
      path.join(cwd, '.agents', 'skills', SKILL_NAME),
      path.join(homeDir, '.codex', 'skills', SKILL_NAME),
      path.join(homeDir, '.agents', 'skills', SKILL_NAME),
    ],
  };
}

export function bundledSkillDir(): string {
  return fileURLToPath(new URL('../../skills/use-every/', import.meta.url));
}

/**
 * Read the revision stamp from a SKILL.md frontmatter block. Copies installed
 * before stamping existed carry none and read as `undefined`.
 */
export function parseSkillVersion(markdown: string): number | undefined {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter) return undefined;
  const pattern = new RegExp(`^\\s+${SKILL_VERSION_KEY}:\\s*["']?(\\d+)["']?\\s*$`, 'm');
  const value = frontmatter.match(pattern)?.[1];
  return value === undefined ? undefined : Number(value);
}

export interface SkillRefreshOptions {
  cwd?: string;
  homeDir?: string;
  errorOutput?: Writable;
  sourceDir?: string;
}

export interface RefreshedSkill {
  path: string;
  from: number | null;
  to: number;
}

async function installedSkillText(dir: string): Promise<string | undefined> {
  try {
    // A symlinked install is managed by something else (a repo, a plugin); leave it.
    if ((await lstat(dir)).isSymbolicLink()) return undefined;
    return await readFile(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Replace installed copies of the bundled skill whose stamp is older or missing.
 *
 * An npm update ships a new skill with the CLI but never touches copies already
 * installed into agent skill directories, so agents keep following stale
 * guidance. Runs after a successful `every signup`/`every login`. It never
 * installs into a location that has no copy, never downgrades a newer copy, and
 * never fails the command that called it.
 */
export async function refreshInstalledSkills(
  opts: SkillRefreshOptions = {},
): Promise<RefreshedSkill[]> {
  const refreshed: RefreshedSkill[] = [];
  try {
    const sourceDir = opts.sourceDir ?? bundledSkillDir();
    const bundled = parseSkillVersion(await readFile(path.join(sourceDir, 'SKILL.md'), 'utf8'));
    if (bundled === undefined) return refreshed;

    const paths = skillInstallPaths(opts.cwd ?? process.cwd(), opts.homeDir ?? os.homedir());
    const candidates = Array.from(new Set([...paths.claude, ...paths.codex]));
    for (const dir of candidates) {
      const text = await installedSkillText(dir);
      if (text === undefined) continue;
      const installed = parseSkillVersion(text);
      if (installed !== undefined && installed >= bundled) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        await cp(sourceDir, dir, { recursive: true, force: true });
        refreshed.push({ path: dir, from: installed ?? null, to: bundled });
        opts.errorOutput?.write(`Updated the use-every skill at ${dir} to revision ${bundled}.\n`);
      } catch {
        opts.errorOutput?.write(`Warning: could not update the use-every skill at ${dir}.\n`);
      }
    }
  } catch {
    // Keeping an agent's skill current is a courtesy; it must never fail auth.
  }
  return refreshed;
}

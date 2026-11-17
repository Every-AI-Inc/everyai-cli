import { access, cp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { HintsFile, readHints } from './hints.js';
import { bundledSkillDir, SKILL_NAME, SkillHost, skillInstallPaths } from './skill-refresh.js';

export type SkillSkippedReason = 'opt_out' | 'declined' | 'no_agent_host' | 'error';

export interface SkillLocation {
  host: SkillHost;
  path: string;
}

/** The `skill` object that `every signup` reports after an agent-run signup. */
export interface SkillAutoInstallResult {
  name: typeof SKILL_NAME;
  /** User-level copies that this run wrote. */
  installed: SkillLocation[];
  /** Hosts that already had a copy (project or user level); nothing was written. */
  already_present: SkillLocation[];
  /** Hosts where the copy failed. A failure never fails the signup. */
  failed: Array<SkillLocation & { reason: string }>;
  /** Why no install was attempted, or `null` when at least one host was examined. */
  skipped_reason: SkillSkippedReason | null;
}

export interface SkillAutoInstallOptions {
  /** `false` when the caller passed `--no-skill`. */
  enabled?: boolean;
  cwd?: string;
  homeDir?: string;
  sourceDir?: string;
  errorOutput?: Writable;
  pathExists?: (filePath: string) => Promise<boolean>;
  readHints?: () => Promise<HintsFile>;
  copySkill?: (sourceDir: string, targetDir: string) => Promise<void>;
}

const HOST_LABEL: Record<SkillHost, string> = { claude: 'Claude Code', codex: 'Codex' };

async function defaultPathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function defaultCopySkill(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(path.dirname(targetDir), { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true, force: true });
}

/**
 * Where an agent host keeps its user-level state (the detection markers) and
 * where its user-level skill goes. The targets are members of
 * `skillInstallPaths`, so the refresh after a later login keeps them current.
 */
export function userSkillTargets(homeDir: string): Record<SkillHost, { markers: string[]; target: string }> {
  return {
    claude: {
      markers: [path.join(homeDir, '.claude')],
      target: path.join(homeDir, '.claude', 'skills', SKILL_NAME),
    },
    codex: {
      markers: [path.join(homeDir, '.codex'), path.join(homeDir, '.agents')],
      target: path.join(homeDir, '.agents', 'skills', SKILL_NAME),
    },
  };
}

function emptyResult(skipped_reason: SkillSkippedReason | null): SkillAutoInstallResult {
  return { name: SKILL_NAME, installed: [], already_present: [], failed: [], skipped_reason };
}

async function firstExisting(
  pathExists: (filePath: string) => Promise<boolean>,
  paths: string[],
): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Install the bundled skill at user level for each detected agent host that has
 * no copy. A coding agent runs `every signup` without a TTY, so the interactive
 * offer cannot reach the person; this is the equivalent step for that case.
 *
 * It never overwrites a copy, never throws, and never fails the caller.
 */
export async function autoInstallSkill(
  opts: SkillAutoInstallOptions = {},
): Promise<SkillAutoInstallResult> {
  if (opts.enabled === false) return emptyResult('opt_out');
  const errorOutput = opts.errorOutput;
  try {
    const hints = await (opts.readHints ?? readHints)();
    if (hints.skill_offer_declined) return emptyResult('declined');

    const pathExists = opts.pathExists ?? defaultPathExists;
    const copySkill = opts.copySkill ?? defaultCopySkill;
    const homeDir = opts.homeDir ?? os.homedir();
    const sourceDir = opts.sourceDir ?? bundledSkillDir();
    const known = skillInstallPaths(opts.cwd ?? process.cwd(), homeDir);
    const targets = userSkillTargets(homeDir);
    const result = emptyResult(null);
    let detected = 0;

    for (const host of ['claude', 'codex'] as const) {
      if (!(await firstExisting(pathExists, targets[host].markers))) continue;
      detected += 1;
      const existing = await firstExisting(pathExists, known[host]);
      if (existing) {
        result.already_present.push({ host, path: existing });
        continue;
      }
      const target = targets[host].target;
      try {
        await copySkill(sourceDir, target);
        result.installed.push({ host, path: target });
        errorOutput?.write(`Installed the ${SKILL_NAME} skill for ${HOST_LABEL[host]} at ${target}.\n`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.failed.push({ host, path: target, reason });
        errorOutput?.write(
          `Warning: could not install the ${SKILL_NAME} skill for ${HOST_LABEL[host]} at ${target}. ` +
            `Run: every skills install ${host} --global\n`,
        );
      }
    }

    if (detected === 0) result.skipped_reason = 'no_agent_host';
    return result;
  } catch {
    errorOutput?.write(`Warning: could not check for the ${SKILL_NAME} skill.\n`);
    return emptyResult('error');
  }
}

import { access, mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDir } from './config.js';

const GENERIC_SKILL_TARGET = 'claude|codex';

type SkillHintTarget = 'claude' | 'codex' | typeof GENERIC_SKILL_TARGET;

function skillHintTargetForEnv(env: NodeJS.ProcessEnv): SkillHintTarget {
  if (env.CLAUDECODE !== undefined) return 'claude';
  if (Object.keys(env).some((key) => key.startsWith('CODEX_') && env[key] !== undefined)) {
    return 'codex';
  }
  return GENERIC_SKILL_TARGET;
}

export function skillHintForEnv(env: NodeJS.ProcessEnv = process.env): string {
  const target = skillHintTargetForEnv(env);
  return `Tip: teach your coding agent this CLI — run: every skills install ${target}  (shown once)`;
}

export interface HintsFile {
  skill_hint_shown?: boolean;
  skill_offer_declined?: boolean;
  [key: string]: unknown;
}

function hintsPath(): string {
  return path.join(getConfigDir(), 'hints.json');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readHints(): Promise<HintsFile> {
  try {
    const parsed = JSON.parse(await readFile(hintsPath(), 'utf8')) as HintsFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return {};
    }
    return {};
  }
}

export async function writeHints(value: HintsFile): Promise<void> {
  const filePath = hintsPath();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

async function localSkillInstalled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const cwd = process.cwd();
  const target = skillHintTargetForEnv(env);
  const claudeInstalled = () => pathExists(path.join(cwd, '.claude', 'skills', 'use-every'));
  const codexInstalled = () => pathExists(path.join(cwd, '.agents', 'skills', 'use-every'));

  if (target === 'claude') return claudeInstalled();
  if (target === 'codex') return codexInstalled();
  return (await claudeInstalled()) || (await codexInstalled());
}

export async function maybeShowSkillHint(): Promise<void> {
  try {
    const hints = await readHints();
    if (hints.skill_hint_shown) return;
    if (await localSkillInstalled()) return;

    process.stderr.write(`${skillHintForEnv()}\n`);
    await writeHints({ ...hints, skill_hint_shown: true });
  } catch {
    // Hints must never affect command success.
  }
}

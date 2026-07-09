import { access, mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDir } from './config.js';

const SKILL_HINT =
  'Tip: teach your coding agent this CLI — run: every skills install claude|codex  (shown once)';

interface HintsFile {
  skill_hint_shown?: boolean;
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

async function readHints(): Promise<HintsFile> {
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

async function writeHints(value: HintsFile): Promise<void> {
  const filePath = hintsPath();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

async function localSkillInstalled(): Promise<boolean> {
  const cwd = process.cwd();
  return (
    (await pathExists(path.join(cwd, '.claude', 'skills', 'use-every'))) ||
    (await pathExists(path.join(cwd, '.agents', 'skills', 'use-every')))
  );
}

export async function maybeShowSkillHint(): Promise<void> {
  try {
    const hints = await readHints();
    if (hints.skill_hint_shown) return;
    if (await localSkillInstalled()) return;

    process.stderr.write(`${SKILL_HINT}\n`);
    await writeHints({ ...hints, skill_hint_shown: true });
  } catch {
    // Hints must never affect command success.
  }
}

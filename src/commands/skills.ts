import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from '../lib/errors.js';
import { ExitCode } from '../lib/exit-codes.js';
import { emit } from '../lib/output.js';

interface SkillsOptions {
  json?: boolean;
}

export interface SkillsInstallOptions extends SkillsOptions {
  global?: boolean;
  dir?: string;
}

export interface SkillsListOptions extends SkillsOptions {
  global?: boolean;
  dir?: string;
}

type SkillTarget = 'claude' | 'codex';

export interface SkillsInstallResult {
  installed_to: string;
  files: string[];
}

interface TargetInfo {
  target: SkillTarget;
  root: string;
  install_to: string;
}

const SKILL_NAME = 'use-every';
const TARGET_ROOTS: Record<SkillTarget, { local: string[]; global: string[] }> = {
  claude: {
    local: ['.claude', 'skills'],
    global: ['.claude', 'skills'],
  },
  codex: {
    local: ['.agents', 'skills'],
    global: ['.agents', 'skills'],
  },
};

function bundledSkillDir(): string {
  return fileURLToPath(new URL('../../skills/use-every/', import.meta.url));
}

function assertTarget(target: string): asserts target is SkillTarget {
  if (target !== 'claude' && target !== 'codex') {
    throw new CliError(`Unknown skills target: ${target}`, ExitCode.USAGE, 'usage');
  }
}

function targetRoot(target: SkillTarget, opts: SkillsInstallOptions | SkillsListOptions): string {
  if (opts.dir) return path.resolve(opts.dir);
  const parts = opts.global ? TARGET_ROOTS[target].global : TARGET_ROOTS[target].local;
  return opts.global ? path.join(os.homedir(), ...parts) : path.join(process.cwd(), ...parts);
}

function targetInfo(target: SkillTarget, opts: SkillsInstallOptions | SkillsListOptions): TargetInfo {
  const root = targetRoot(target, opts);
  return {
    target,
    root,
    install_to: path.join(root, SKILL_NAME),
  };
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join('/');
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(normalizeRelativePath(relative));
  }

  return files;
}

function emitCommand<T>(data: T, human: string, opts: SkillsOptions): void {
  if (opts.json) emit(data, { json: true });
  else process.stdout.write(`${human}\n`);
}

async function pathIsDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function hostDetected(target: SkillTarget): Promise<boolean> {
  const cwd = process.cwd();
  const home = os.homedir();
  const candidates = target === 'claude'
    ? [path.join(cwd, '.claude'), path.join(home, '.claude')]
    : [path.join(cwd, '.agents'), path.join(home, '.codex')];

  for (const candidate of candidates) {
    if (await pathIsDirectory(candidate)) return true;
  }
  return false;
}

async function hostSkillInstalled(target: SkillTarget): Promise<boolean> {
  const cwd = process.cwd();
  const home = os.homedir();
  const candidates = target === 'claude'
    ? [
        path.join(cwd, '.claude', 'skills', SKILL_NAME),
        path.join(home, '.claude', 'skills', SKILL_NAME),
      ]
    : [
        path.join(cwd, '.agents', 'skills', SKILL_NAME),
        path.join(home, '.codex', 'skills', SKILL_NAME),
        path.join(home, '.agents', 'skills', SKILL_NAME),
      ];

  for (const candidate of candidates) {
    if (await pathIsDirectory(candidate)) return true;
  }
  return false;
}

async function installHuman(target: TargetInfo, files: string[]): Promise<string> {
  const lines = [`Installed ${SKILL_NAME} for ${target.target} to ${target.install_to}`];
  for (const file of files) lines.push(`- ${file}`);

  const otherTarget: SkillTarget = target.target === 'claude' ? 'codex' : 'claude';
  if ((await hostDetected(otherTarget)) && !(await hostSkillInstalled(otherTarget))) {
    const hostName = otherTarget === 'claude' ? 'Claude Code' : 'Codex';
    lines.push(`${hostName} detected — also run: every skills install ${otherTarget}`);
  }
  lines.push('For a global install, use --dir <path>.');

  return lines.join('\n');
}

export async function installBundledSkill(
  target: string,
  opts: SkillsInstallOptions = {},
): Promise<SkillsInstallResult> {
  assertTarget(target);
  const info = targetInfo(target, opts);
  const source = bundledSkillDir();
  const files = await listFiles(source);

  await mkdir(info.root, { recursive: true });
  await rm(info.install_to, { recursive: true, force: true });
  await cp(source, info.install_to, { recursive: true, force: true });

  return { installed_to: info.install_to, files };
}

export async function skillsInstallCommand(
  target: string,
  opts: SkillsInstallOptions = {},
): Promise<void> {
  assertTarget(target);
  const info = targetInfo(target, opts);
  const result = await installBundledSkill(target, opts);

  emitCommand(
    result,
    await installHuman(info, result.files),
    opts,
  );
}

function listHuman(skills: Array<{ name: string; targets: Record<SkillTarget, TargetInfo> }>): string {
  const lines = ['Available bundled skills:'];
  for (const skill of skills) {
    lines.push(skill.name);
    lines.push(`  claude: ${skill.targets.claude.install_to}`);
    lines.push(`  codex: ${skill.targets.codex.install_to}`);
  }
  return lines.join('\n');
}

export async function skillsListCommand(opts: SkillsListOptions = {}): Promise<void> {
  const skills = [
    {
      name: SKILL_NAME,
      targets: {
        claude: targetInfo('claude', opts),
        codex: targetInfo('codex', opts),
      },
    },
  ];

  emitCommand({ skills }, listHuman(skills), opts);
}

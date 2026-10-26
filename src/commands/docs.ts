import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { emit } from '../lib/output.js';

export interface DocsOptions {
  json?: boolean;
  staging?: boolean;
}

interface DocsResult {
  commands: string;
  conventions: string;
  workflows: string;
}

function optionFlags(command: Command): string[] {
  return command.options
    .filter((option) => !option.hidden)
    .map((option) => option.flags);
}

function argumentUsage(command: Command): string[] {
  const registered = (
    command as Command & {
      registeredArguments?: Array<{ required?: boolean; name?: () => string }>;
    }
  ).registeredArguments;

  return (registered ?? []).map((arg) => {
    const name = arg.name?.() ?? 'arg';
    return arg.required ? `<${name}>` : `[${name}]`;
  });
}

function commandLine(command: Command, parents: string[]): string {
  const names = [...parents, command.name()].filter(Boolean);
  const parts = [names.join(' '), ...argumentUsage(command), ...optionFlags(command)];
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// Deprecated aliases (e.g. `every contact`) are registered hidden; like hidden
// options, they stay out of the offline docs so agents learn only current names.
function isHidden(command: Command): boolean {
  return (command as Command & { _hidden?: boolean })._hidden === true;
}

function walkCommands(command: Command, parents: string[] = []): string[] {
  const line = commandLine(command, parents);
  const children = command.commands
    .filter((child) => !isHidden(child))
    .flatMap((child) => walkCommands(child, [...parents, command.name()]));
  return [line, ...children];
}

export function commandTree(program: Command): string {
  return walkCommands(program).join('\n');
}

export function conventionsBlock(): string {
  return [
    'JSON envelope:',
    '  Success: {"ok":true,"data":...,"env":"production|staging|custom","schema_version":1}',
    '  Error:   {"ok":false,"error":{"message":"...","code":"..."},"env":"production|staging|custom","schema_version":1}',
    '  every signup --json is NDJSON: {"event":"authorization_required","url":...},',
    '    {"event":"waiting_for_authorization","browser_opened":...}, then the envelope as the last line.',
    '',
    'Exit codes:',
    '  0 ok',
    '  1 tool/generic error',
    '  2 usage',
    '  3 auth',
    '  4 permission/confirmation needed',
    '  5 rate limited',
    '  6 not found (code signup_unsupported: the server has no agent signup yet)',
    '  7 network/timeout',
    '',
    'Safety tiers:',
    '  read: runs without confirmation',
    '  write: requires y/N interactively or --yes non-interactively; server text confirmation retries once',
    '  destructive: requires typed confirmation interactively or --yes --allow-destructive non-interactively',
    '  ai-mediated: server-enforced read-only, but gated because it routes through Every AI; prefer deterministic tools',
    '  human approval: never auto-retries; approve in Every, then re-run the identical command',
    '',
    'Argument forms:',
    '  every tool call <name> --arg k=v --arg count=2',
    '  every tool call <name> --args -',
    '  every tool call <name> --args file.json',
    '',
    'Environment:',
    '  EVERY_TOKEN skips browser login for headless use; it never creates an account (use every signup).',
    '  Target precedence: --staging > EVERY_MCP_URL > EVERY_ENV=staging|production > production.',
  ].join('\n');
}

function bundledSkillPath(): string {
  return fileURLToPath(new URL('../../skills/use-every/SKILL.md', import.meta.url));
}

function canonicalWorkflows(markdown: string): string {
  const match = markdown.match(/## Canonical Workflows\s*([\s\S]*?)(?:\n## |\s*$)/);
  return match?.[1]?.trim() ?? markdown.trim();
}

export async function docsCommand(program: Command, opts: DocsOptions = {}): Promise<void> {
  const workflows = canonicalWorkflows(await readFile(bundledSkillPath(), 'utf8'));
  const data: DocsResult = {
    commands: commandTree(program),
    conventions: conventionsBlock(),
    workflows,
  };

  if (opts.json) {
    emit(data, { json: true, staging: opts.staging });
    return;
  }

  process.stdout.write(
    [
      '# every docs',
      '',
      '## Commands',
      data.commands,
      '',
      '## Conventions',
      data.conventions,
      '',
      '## Workflows',
      data.workflows,
    ].join('\n') + '\n',
  );
}

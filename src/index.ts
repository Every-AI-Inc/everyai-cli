#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { pingCommand } from './commands/ping.js';
import { CliError } from './lib/errors.js';
import { emitError } from './lib/output.js';
import { ExitCode } from './lib/exit-codes.js';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

/** Attach the global options every command accepts (before OR after the name). */
function withGlobalOptions(cmd: Command): Command {
  return cmd
    .option('--json', 'emit machine-readable JSON output')
    .option('--staging', 'target the staging MCP server');
}

const program = new Command();

withGlobalOptions(
  program
    .name('every')
    .description('Every AI CLI — the agent-agnostic surface for Every AI')
    .version(pkg.version, '-v, --version', 'print the CLI version'),
);

withGlobalOptions(
  program
    .command('ping')
    .description('Check connectivity to the Every MCP server (unauthenticated)'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await pingCommand({ json: opts.json, staging: opts.staging });
});

const CLEAN_EXIT_CODES = new Set([
  'commander.version',
  'commander.help',
  'commander.helpDisplayed',
]);

async function main(): Promise<void> {
  // We own the exit codes, so intercept commander's process.exit calls.
  program.exitOverride();
  const wantsJson = process.argv.includes('--json');

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help / --version wrote their output already; treat as success.
      process.exit(CLEAN_EXIT_CODES.has(err.code) ? ExitCode.OK : ExitCode.USAGE);
    }
    if (err instanceof CliError) {
      emitError(err.message, err.code, { json: wantsJson });
      process.exit(err.exitCode);
    }
    const message = err instanceof Error ? err.message : String(err);
    emitError(message, 'generic', { json: wantsJson });
    process.exit(ExitCode.GENERIC);
  }
}

void main();

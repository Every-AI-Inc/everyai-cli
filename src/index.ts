#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { pingCommand } from './commands/ping.js';
import {
  authStatusCommand,
  loginCommand,
  logoutCommand,
  orgCommand,
  whoamiCommand,
} from './commands/auth.js';
import { CliError } from './lib/errors.js';
import { emit, emitError } from './lib/output.js';
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
let jsonMode = false;
let commanderStdout = '';

program.exitOverride();
program.configureOutput({
  writeOut(str) {
    if (jsonMode) commanderStdout += str;
    else process.stdout.write(str);
  },
  outputError(str, write) {
    if (!jsonMode) write(str);
  },
});

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

withGlobalOptions(
  program
    .command('login')
    .description('Log in with browser-based OAuth and store tokens locally'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await loginCommand({ json: opts.json, staging: opts.staging });
});

withGlobalOptions(
  program
    .command('logout')
    .description('Delete stored auth tokens for the selected environment'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await logoutCommand({ json: opts.json, staging: opts.staging });
});

withGlobalOptions(
  program
    .command('whoami')
    .description('Show the current authenticated user and verify MCP liveness'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await whoamiCommand({ json: opts.json, staging: opts.staging });
});

const authCommand = withGlobalOptions(
  program.command('auth').description('Inspect authentication state'),
);

withGlobalOptions(
  authCommand.command('status').description('Show local auth status without network access'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await authStatusCommand({ json: opts.json, staging: opts.staging });
});

withGlobalOptions(
  program
    .command('org')
    .description(
      'Show org claims from the current token; multi-org selection lands in a later phase',
    ),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await orgCommand({ json: opts.json, staging: opts.staging });
});

const CLEAN_EXIT_CODES = new Set([
  'commander.version',
  'commander.help',
  'commander.helpDisplayed',
]);

function cleanCommanderMessage(err: CommanderError): string {
  return err.message.replace(/^error:\s*/i, '');
}

function emitCommanderSuccess(err: CommanderError): void {
  if (err.code === 'commander.version') {
    emit({ version: pkg.version }, { json: true });
    return;
  }

  emit({ help: commanderStdout.trimEnd() }, { json: true });
}

async function main(): Promise<void> {
  jsonMode = process.argv.includes('--json');
  commanderStdout = '';

  try {
    await program.parseAsync(process.argv);

    if (program.args.length === 0) {
      if (jsonMode) {
        emit({ help: program.helpInformation().trimEnd() }, { json: true });
      } else {
        program.outputHelp();
      }
    }
  } catch (err) {
    if (err instanceof CommanderError) {
      if (CLEAN_EXIT_CODES.has(err.code)) {
        if (jsonMode) emitCommanderSuccess(err);
        process.exit(ExitCode.OK);
      }

      if (jsonMode) emitError(cleanCommanderMessage(err), 'usage', { json: true });
      process.exit(ExitCode.USAGE);
    }
    if (err instanceof CliError) {
      emitError(err.message, err.code, { json: jsonMode });
      process.exit(err.exitCode);
    }
    const message = err instanceof Error ? err.message : String(err);
    emitError(message, 'generic', { json: jsonMode });
    process.exit(ExitCode.GENERIC);
  }
}

void main();

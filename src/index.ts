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
import { policyExplainCommand } from './commands/policy.js';
import {
  toolCallCommand,
  toolsDescribeCommand,
  toolsListCommand,
} from './commands/tools.js';
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

const toolsCommand = withGlobalOptions(
  program.command('tools').description('Inspect the Every MCP tool registry'),
);

withGlobalOptions(
  toolsCommand
    .command('list')
    .description('List available MCP tools')
    .option('--no-cache', 'bypass and rewrite the local tool registry cache'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await toolsListCommand({
    json: opts.json,
    staging: opts.staging,
    noCache: opts.noCache,
  });
});

withGlobalOptions(
  toolsCommand
    .command('describe')
    .description('Describe an MCP tool and its input schema')
    .argument('<name>', 'tool name')
    .option('--no-cache', 'bypass and rewrite the local tool registry cache'),
).action(async (name: string, _options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await toolsDescribeCommand(name, {
    json: opts.json,
    staging: opts.staging,
    noCache: opts.noCache,
  });
});

const toolCommand = withGlobalOptions(
  program.command('tool').description('Invoke a single Every MCP tool'),
);

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

withGlobalOptions(
  toolCommand
    .command('call')
    .description('Call an MCP tool with JSON arguments')
    .argument('<name>', 'tool name')
    .option('--no-cache', 'bypass and rewrite the local tool registry cache')
    .option('--args <file>', 'JSON object file to use for tool arguments; use - for stdin')
    .option('--arg <k=v>', 'overlay one argument value; value is parsed as JSON when possible', collectOption, [])
    .option('--yes', 'confirm write or AI-mediated tool calls')
    .option('--allow-destructive', 'allow destructive tool calls when combined with --yes')
    .option('--read-only', 'deny write, destructive, and AI-mediated tool calls')
    .option('--timeout <secs>', 'tool call timeout in seconds'),
).action(async (name: string, _options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await toolCallCommand(name, {
    json: opts.json,
    staging: opts.staging,
    noCache: opts.noCache,
    args: opts.args,
    arg: opts.arg,
    yes: opts.yes,
    allowDestructive: opts.allowDestructive,
    readOnly: opts.readOnly,
    timeout: opts.timeout,
  });
});

const policyCommand = withGlobalOptions(
  program.command('policy').description('Explain local tool safety policy'),
);

withGlobalOptions(
  policyCommand
    .command('explain')
    .description('Explain how a tool is classified and gated')
    .argument('<name>', 'tool name'),
).action(async (name: string, _options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await policyExplainCommand(name, { json: opts.json, staging: opts.staging });
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

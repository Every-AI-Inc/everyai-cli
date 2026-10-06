#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, CommanderError, Option } from 'commander';
import { pingCommand } from './commands/ping.js';
import { docsCommand } from './commands/docs.js';
import {
  authStatusCommand,
  loginCommand,
  logoutCommand,
  orgCommand,
  orgSwitchCommand,
  whoamiCommand,
} from './commands/auth.js';
import { policyExplainCommand } from './commands/policy.js';
import {
  signupCommand,
  signupCompleteCommand,
  signupStatusCommand,
} from './commands/signup.js';
import {
  toolCallCommand,
  toolsDescribeCommand,
  toolsListCommand,
} from './commands/tools.js';
import {
  dealListCommand,
  dealMoveCommand,
  invoiceCreateCommand,
  invoiceListCommand,
  invoiceSendCommand,
  personListCommand,
  proposalSendCommand,
  recipientsGetCommand,
  recipientsSetCommand,
} from './commands/aliases.js';
import { skillsInstallCommand, skillsListCommand } from './commands/skills.js';
import { CliError } from './lib/errors.js';
import { deprecationNote, emit, emitError } from './lib/output.js';
import { ExitCode } from './lib/exit-codes.js';
import { runDefaultFirstRunMenu } from './lib/first-run.js';

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
  writeErr(str) {
    if (jsonMode) commanderStdout += str;
    else process.stderr.write(str);
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
    .command('docs')
    .description('Print complete offline CLI docs for humans and agents'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await docsCommand(program, { json: opts.json, staging: opts.staging });
});

const signup = withGlobalOptions(
  program
    .command('signup')
    .allowExcessArguments(false)
    .description('Create an Every account or sign in via one browser step; no TTY needed')
    .option('--timeout <seconds>', 'how long to wait for the browser authorization', '300')
    .addHelpText(
      'after',
      [
        '',
        'With --json, stdout is NDJSON: an authorization_required event with the URL,',
        'a waiting_for_authorization event, then the result envelope as the last line.',
        '',
        'Then finish signup:',
        '  every signup complete --org-name "Acme Studio" --yes --json',
        '',
      ].join('\n'),
    ),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await signupCommand({ json: opts.json, staging: opts.staging, timeout: opts.timeout });
});

withGlobalOptions(
  signup.command('status').description('Show signup status and the profile still needed'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await signupStatusCommand({ json: opts.json, staging: opts.staging });
});

withGlobalOptions(
  signup
    .command('complete')
    .description('Finish signup with the organization profile the user confirmed')
    .requiredOption('--org-name <name>', 'organization name the user confirmed (required)')
    .option('--description <text>', 'short description of the business')
    .option('--link <url>', 'public https link (website, LinkedIn, ...); repeatable', collectOption, [])
    .option('--yes', 'confirm the write (required when non-interactive)')
    .option('--read-only', 'deny the write (for automation guards)'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await signupCompleteCommand({
    json: opts.json,
    staging: opts.staging,
    orgName: opts.orgName,
    description: opts.description,
    link: opts.link,
    yes: opts.yes,
    readOnly: opts.readOnly,
  });
});

withGlobalOptions(
  program
    .command('login')
    .description('Log in with browser OAuth and store tokens (new users: every signup)')
    .option('--create-account', 'deprecated alias for every signup')
    .option('--org <id|slug|name>', 'verify the workspace selected during login'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await loginCommand({
    json: opts.json,
    staging: opts.staging,
    createAccount: opts.createAccount,
    org: opts.org,
  });
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

const org = withGlobalOptions(
  program
    .command('org')
    .allowExcessArguments(false)
    .description(
      'Show or switch the workspace bound to the current token',
    ),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await orgCommand({ json: opts.json, staging: opts.staging });
});

withGlobalOptions(
  org.command('switch')
    .description('Switch workspace using the browser consent selector')
    .option('--org <ref>', 'verify the selected workspace by id, slug, or name'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await orgSwitchCommand({ json: opts.json, staging: opts.staging, org: opts.org });
});

const toolsCommand = withGlobalOptions(
  program.command('tools').description('Inspect the Every MCP tool registry'),
);

withGlobalOptions(
  toolsCommand
    .command('list')
    .description('List available MCP tools')
    .option('--no-cache', 'bypass and rewrite the local tool registry cache')
    .option('--filter <substr>', 'case-insensitive substring filter for name or description'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await toolsListCommand({
    json: opts.json,
    staging: opts.staging,
    noCache: opts.noCache,
    filter: opts.filter,
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

function collectOption(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

function withToolExecutionOptions(cmd: Command): Command {
  return cmd
    .option('--no-cache', 'bypass and rewrite the local tool registry cache')
    .option('--yes', 'confirm write or AI-mediated tool calls')
    .option('--allow-destructive', 'allow destructive tool calls when combined with --yes')
    .option('--read-only', 'deny write, destructive, and AI-mediated tool calls')
    .option('--timeout <secs>', 'tool call timeout in seconds');
}

const TOOL_CALL_HELP = [
  '',
  'Fastest full-tool argument forms:',
  '  every tool call <name> --arg key=value --arg count=2',
  '  every tool call <name> --args -',
  '  every tool call <name> --args file.json',
  '',
].join('\n');

withGlobalOptions(
  withToolExecutionOptions(
    toolCommand
    .command('call')
    .description('Call an MCP tool with JSON arguments')
    .argument('<name>', 'tool name')
    .option('--args <file>', 'JSON object file to use for tool arguments; use - for stdin')
    .option('--arg <k=v>', 'overlay one argument value; value is parsed as JSON when possible', collectOption, [])
  ),
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

const invoiceCommand = withToolExecutionOptions(
  withGlobalOptions(
    program
      .command('invoice')
      .description('Work with invoices')
      .addHelpText(
        'after',
        [
          '',
          'Create a simple invoice:',
          '  every invoice create --company "Acme" --amount 100 --yes --json',
          '',
          'For rich invoices, use the full tool:',
          '  every tool call create_invoice --arg command=\'{"operation_id":"<uuid>","party":{"kind":"company","id":"<id>"},"line_items":[{"description":"Work","quantity":1,"unit_price":100}]}\'',
          '  every tool call create_invoice --args -',
          '  every tool call create_invoice --args file.json',
          '',
        ].join('\n'),
      ),
  ),
);

withGlobalOptions(
  withToolExecutionOptions(
    invoiceCommand
      .command('create')
      .description('Create a simple draft invoice for a Company or a Person')
      .option('--company <name>', 'Company name to resolve via list_companies')
      .option('--person <name>', 'Person name to resolve via list_people')
      .option('--company-id <id>', 'Company id; skips name resolution')
      .option('--person-id <id>', 'Person id; skips name resolution')
      .addOption(new Option('--client <name>', 'deprecated alias for --company').hideHelp())
      .addOption(
        new Option('--client-id <id>', 'deprecated: use --company-id or --person-id').hideHelp(),
      )
      .requiredOption('--amount <n>', 'unit price for the single line item')
      .option('--description <text>', 'line item description')
      .option('--quantity <q>', 'line item quantity'),
  ),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  if (opts.client !== undefined) {
    deprecationNote('`--client` is deprecated; use `--company` (or `--person` for a Person).');
  }
  if (opts.clientId !== undefined) {
    deprecationNote('`--client-id` is deprecated; use `--company-id` or `--person-id`.');
  }
  await invoiceCreateCommand({
    json: opts.json,
    staging: opts.staging,
    noCache: opts.noCache,
    yes: opts.yes,
    allowDestructive: opts.allowDestructive,
    readOnly: opts.readOnly,
    timeout: opts.timeout,
    client: opts.client,
    company: opts.company,
    person: opts.person,
    companyId: opts.companyId,
    personId: opts.personId,
    clientId: opts.clientId,
    amount: opts.amount,
    description: opts.description,
    quantity: opts.quantity,
  });
});

withGlobalOptions(
  withToolExecutionOptions(
    invoiceCommand
      .command('list')
      .description('List invoices')
      .option('--status <s>', 'invoice or payment status filter')
      .option('--search <q>', 'invoice search query')
      .option('--limit <n>', 'maximum number of invoices to return'),
  ),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await invoiceListCommand({
    json: opts.json,
    staging: opts.staging,
    noCache: opts.noCache,
    yes: opts.yes,
    allowDestructive: opts.allowDestructive,
    readOnly: opts.readOnly,
    timeout: opts.timeout,
    status: opts.status,
    search: opts.search,
    limit: opts.limit,
  });
});

withGlobalOptions(
  withToolExecutionOptions(
    invoiceCommand
      .command('send')
      .description('Preview recipients, confirm, and send an invoice')
      .option('--expect-digest <digest>', 'require the digest from the approved recipient preview')
      .argument('<invoice_id>', 'invoice id'),
  ),
).action(async (invoiceId: string, _options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await invoiceSendCommand(invoiceId, {
    json: opts.json,
    staging: opts.staging,
    noCache: opts.cache === false,
    yes: opts.yes,
    allowDestructive: opts.allowDestructive,
    readOnly: opts.readOnly,
    timeout: opts.timeout,
    expectDigest: opts.expectDigest,
  });
});

const proposalCommand = withToolExecutionOptions(withGlobalOptions(
  program.command('proposal').description('Work with proposals'),
));
withGlobalOptions(withToolExecutionOptions(
  proposalCommand.command('send').description('Preview recipients, confirm, and send a proposal')
    .option('--expect-digest <digest>', 'require the digest from the approved recipient preview')
    .argument('<proposal>', 'proposal id'),
)).action(async (proposal: string, _options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await proposalSendCommand(proposal, { ...opts, noCache: opts.cache === false });
});

const recipientsCommand = withToolExecutionOptions(withGlobalOptions(
  program.command('recipients').description('Read or set invoice and proposal recipients'),
));
for (const action of ['get', 'set'] as const) {
  const command = withGlobalOptions(withToolExecutionOptions(
    recipientsCommand.command(action).description(`${action === 'get' ? 'Read' : 'Set'} exact To and CC recipients`)
      .argument('<party>', 'Person or Company name')
      .requiredOption('--kind <kind>', 'invoice or proposal')
      .option('--company <name>', 'Company name to resolve via list_companies')
      .option('--person <name>', 'Person name to resolve via list_people')
      .option('--company-id <id>', 'Company id; skips name resolution')
      .option('--person-id <id>', 'Person id; skips name resolution'),
  ));
  if (action === 'set') {
    command.requiredOption('--to <email-or-id>', 'To email address or eligible method id')
      .option('--cc <email-or-id>', 'CC email address or eligible method id; repeat for more recipients', collectOption)
      .option('--clear-cc', 'remove all CC recipients');
  }
  command.action(async (party: string, _options: unknown, cmd: Command) => {
    const opts = cmd.optsWithGlobals();
    // Commander represents --no-cache as cache:false.
    opts.noCache = opts.cache === false;
    await (action === 'get' ? recipientsGetCommand : recipientsSetCommand)(party, opts);
  });
}

const dealCommand = withToolExecutionOptions(
  withGlobalOptions(
    program
      .command('deal')
      .description('Work with deals')
      .addHelpText('after', TOOL_CALL_HELP),
  ),
);

withGlobalOptions(
  withToolExecutionOptions(
    dealCommand
      .command('list')
      .description('List deals')
      .option('--stage <s>', 'deal stage filter')
      .option('--search <q>', 'deal search query')
      .option('--limit <n>', 'maximum number of deals to return'),
  ),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await dealListCommand({
    json: opts.json,
    staging: opts.staging,
    noCache: opts.noCache,
    yes: opts.yes,
    allowDestructive: opts.allowDestructive,
    readOnly: opts.readOnly,
    timeout: opts.timeout,
    stage: opts.stage,
    search: opts.search,
    limit: opts.limit,
  });
});

withGlobalOptions(
  withToolExecutionOptions(
    dealCommand
      .command('move')
      .description('Move a deal to another stage')
      .argument('<deal_id>', 'deal id')
      .argument('<stage>', 'target stage'),
  ),
).action(async (dealId: string, stage: string, _options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await dealMoveCommand(dealId, stage, {
    json: opts.json,
    staging: opts.staging,
    noCache: opts.noCache,
    yes: opts.yes,
    allowDestructive: opts.allowDestructive,
    readOnly: opts.readOnly,
    timeout: opts.timeout,
  });
});

/**
 * Register `list` under `every person` and under the hidden, deprecated
 * `every contact` alias ("contact" is retired vocabulary: the product's people
 * model is People and Companies).
 */
function addPersonListCommand(parent: Command, deprecation?: string): void {
  withGlobalOptions(
    withToolExecutionOptions(
      parent
        .command('list')
        .description('List People')
        .option('--search <q>', 'search People by name, email, phone, or employer')
        .option('--limit <n>', 'maximum number of People to return'),
    ),
  ).action(async (_options: unknown, command: Command) => {
    if (deprecation) deprecationNote(deprecation);
    const opts = command.optsWithGlobals();
    await personListCommand({
      json: opts.json,
      staging: opts.staging,
      noCache: opts.noCache,
      yes: opts.yes,
      allowDestructive: opts.allowDestructive,
      readOnly: opts.readOnly,
      timeout: opts.timeout,
      search: opts.search,
      limit: opts.limit,
    });
  });
}

addPersonListCommand(
  withToolExecutionOptions(
    withGlobalOptions(
      program
        .command('person')
        .description('Work with People')
        .addHelpText('after', TOOL_CALL_HELP),
    ),
  ),
);

addPersonListCommand(
  withToolExecutionOptions(
    withGlobalOptions(
      program
        .command('contact', { hidden: true })
        .description('Deprecated alias for every person'),
    ),
  ),
  '`every contact` is deprecated; use `every person`.',
);

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

const skillsCommand = withGlobalOptions(
  program.command('skills').description('Install bundled Every agent skills'),
);

withGlobalOptions(
  skillsCommand
    .command('list')
    .description('List bundled skills and install locations')
    .option('--global', 'show global install locations')
    .option('--dir <path>', 'override the destination root'),
).action(async (_options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await skillsListCommand({
    json: opts.json,
    global: opts.global,
    dir: opts.dir,
  });
});

withGlobalOptions(
  skillsCommand
    .command('install')
    .description('Install a bundled skill for an agent target')
    .argument('<target>', 'agent target: claude or codex')
    .option('--global', 'install into the global target skill directory')
    .option('--dir <path>', 'override the destination root'),
).action(async (target: string, _options: unknown, command: Command) => {
  const opts = command.optsWithGlobals();
  await skillsInstallCommand(target, {
    json: opts.json,
    global: opts.global,
    dir: opts.dir,
  });
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

  emit({ help: commanderStdout.trimEnd() || program.helpInformation().trimEnd() }, { json: true });
}

function isBareInvocation(): boolean {
  return process.argv.slice(2).length === 0;
}

async function maybeRunFirstRunMenu(): Promise<boolean> {
  if (!isBareInvocation() || jsonMode || !process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  await runDefaultFirstRunMenu({
    staging: program.opts().staging,
    showHelp: () => program.outputHelp(),
    login: () => loginCommand({ staging: program.opts().staging, skipMenu: true }),
    createAccount: () => signupCommand({ staging: program.opts().staging }),
  });
  return true;
}

async function main(): Promise<void> {
  jsonMode = process.argv.includes('--json');
  commanderStdout = '';

  try {
    // Bare invocation must be handled BEFORE commander: with subcommands and no
    // root action, parseAsync throws commander.help on empty args, so a menu
    // call after it would never run.
    if (await maybeRunFirstRunMenu()) return;

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
      emitError(err.message, err.code, { json: jsonMode }, err.details);
      process.exit(err.exitCode);
    }
    const message = err instanceof Error ? err.message : String(err);
    emitError(message, 'generic', { json: jsonMode });
    process.exit(ExitCode.GENERIC);
  }
}

void main();

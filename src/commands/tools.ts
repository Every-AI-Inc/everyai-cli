import { readFile } from 'node:fs/promises';
import { environmentNameForBaseUrl, resolveBaseUrl } from '../lib/config.js';
import { CliError } from '../lib/errors.js';
import { ExitCode } from '../lib/exit-codes.js';
import { callTool, listTools, McpTool } from '../lib/mcp.js';
import { emit } from '../lib/output.js';
import {
  Classification,
  classify,
  promptForTool,
  requirementDescription,
  requirementFor,
} from '../lib/policy.js';
import { getToken } from '../lib/auth/tokens.js';
import { fetchUserInfo, UserInfo } from '../lib/auth/userinfo.js';
import { maybeShowSkillHint } from '../lib/hints.js';

interface BaseCommandOptions {
  json?: boolean;
  staging?: boolean;
}

export interface ToolsListOptions extends BaseCommandOptions {
  noCache?: boolean;
  filter?: string;
}

export interface ToolsDescribeOptions extends BaseCommandOptions {
  noCache?: boolean;
}

export interface ToolCallOptions extends BaseCommandOptions {
  noCache?: boolean;
  args?: string;
  arg?: string[];
  yes?: boolean;
  allowDestructive?: boolean;
  readOnly?: boolean;
  timeout?: string;
}

type ClassifiedTool = McpTool & { classification: Classification };
type ArgsFactory = () => Promise<Record<string, unknown>>;
export interface ToolCallData {
  tool: string;
  is_error: boolean;
  content: unknown;
  structured_content?: unknown;
  org?: { org_id: string | null; org_name: string | null };
  [key: string]: unknown;
}

type DataAugmenter = (data: ToolCallData) => ToolCallData | Promise<ToolCallData>;

export type ToolExecutionOptions = Omit<ToolCallOptions, 'args' | 'arg'>;

function emitCommand<T>(data: T, human: string, opts: BaseCommandOptions): void {
  if (opts.json) emit(data, { json: true, staging: opts.staging });
  else process.stdout.write(`${human}\n`);
}

function compactText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function firstSentence(value: unknown): string {
  const compact = compactText(value);
  const match = compact.match(/^(.+?[.!?])(?:\s|$)/);
  return match?.[1] ?? compact;
}

function truncate(value: string, max = 70): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function toolSummary(tool: McpTool): string {
  const title = compactText(tool.title);
  const sentence = firstSentence(tool.description);
  if (title && sentence && sentence !== title) return truncate(`${title} - ${sentence}`);
  return truncate(title || sentence || '');
}

function withClassification(tool: McpTool): ClassifiedTool {
  return { ...tool, classification: classify(tool) };
}

function toolsListHuman(tools: ClassifiedTool[]): string {
  const nameWidth = Math.min(
    36,
    Math.max('name'.length, ...tools.map((tool) => tool.name.length)),
  );
  const levelWidth = 'ai-mediated'.length;
  const lines = [
    `${'name'.padEnd(nameWidth)}  ${'classification'.padEnd(levelWidth)}  description`,
    `${'-'.repeat(nameWidth)}  ${'-'.repeat(levelWidth)}  ${'-'.repeat(11)}`,
  ];

  for (const tool of tools) {
    lines.push(
      `${tool.name.padEnd(nameWidth)}  ${tool.classification.level.padEnd(levelWidth)}  ${toolSummary(tool)}`,
    );
  }

  return lines.join('\n');
}

function findTool(tools: McpTool[], name: string): McpTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new CliError(`Tool not found: ${name}`, ExitCode.NOT_FOUND, 'not_found');
  return tool;
}

function describeHuman(tool: ClassifiedTool): string {
  const requirements = requirementDescription(tool.classification.level);
  const lines = [
    `Name: ${tool.name}`,
    `Classification: ${tool.classification.level}`,
    `Source: ${tool.classification.source}`,
    `Reason: ${tool.classification.reason}`,
    `Interactive: ${requirements.interactive}`,
    `Non-interactive: ${requirements.non_interactive}`,
  ];

  if (tool.title) lines.push(`Title: ${tool.title}`);
  if (tool.description) lines.push('', 'Description:', String(tool.description).trim());

  lines.push('', 'Input schema:', JSON.stringify(tool.inputSchema ?? {}, null, 2));
  lines.push(
    '',
    'Fastest argument forms:',
    `  every tool call ${tool.name} --arg key=value --arg other='{"json":true}'`,
    `  every tool call ${tool.name} --args -`,
    `  every tool call ${tool.name} --args file.json`,
  );
  return lines.join('\n');
}

async function resolveTools(opts: ToolsListOptions): Promise<McpTool[]> {
  const baseUrl = resolveBaseUrl({ staging: opts.staging });
  const token = await getToken({ baseUrl });
  return listTools(baseUrl, token, { noCache: opts.noCache });
}

export async function toolsListCommand(opts: ToolsListOptions = {}): Promise<void> {
  const filter = opts.filter?.toLowerCase();
  const tools = (await resolveTools(opts))
    .filter((tool) => {
      if (!filter) return true;
      return (
        tool.name.toLowerCase().includes(filter) ||
        compactText(tool.description).toLowerCase().includes(filter)
      );
    })
    .map(withClassification);
  emitCommand(tools, toolsListHuman(tools), opts);
  await maybeShowSkillHint();
}

export async function toolsDescribeCommand(
  name: string,
  opts: ToolsDescribeOptions = {},
): Promise<void> {
  const tool = withClassification(findTool(await resolveTools(opts), name));
  const requirements = requirementDescription(tool.classification.level);
  emitCommand(
    {
      tool,
      classification: tool.classification,
      requirements,
      input_schema: tool.inputSchema ?? {},
    },
    describeHuman(tool),
    opts,
  );
  await maybeShowSkillHint();
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function assertJsonObject(value: unknown, source: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(`${source} must be a JSON object`, ExitCode.USAGE, 'usage');
  }
}

async function readArgsFile(file: string): Promise<Record<string, unknown>> {
  const text = file === '-' ? await readStdin() : await readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to parse --args JSON: ${detail}`, ExitCode.USAGE, 'usage');
  }
  assertJsonObject(parsed, '--args');
  return parsed;
}

function parseArgValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function applyArgOverlay(args: Record<string, unknown>, entry: string): void {
  const equals = entry.indexOf('=');
  if (equals <= 0) {
    throw new CliError(`--arg must be k=v: ${entry}`, ExitCode.USAGE, 'usage');
  }

  const key = entry.slice(0, equals);
  const value = entry.slice(equals + 1);
  args[key] = parseArgValue(value);
}

async function assembleArgs(opts: ToolCallOptions): Promise<Record<string, unknown>> {
  const args = opts.args ? await readArgsFile(opts.args) : {};
  for (const entry of opts.arg ?? []) applyArgOverlay(args, entry);
  return args;
}

function timeoutMs(value: string | undefined): number {
  if (value === undefined) return 120_000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError('--timeout must be a positive number of seconds', ExitCode.USAGE, 'usage');
  }
  return Math.round(seconds * 1000);
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return undefined;
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string'
        ? candidate.text
        : undefined;
    })
    .filter((text): text is string => text !== undefined);
}

function contentAsText(content: unknown): string {
  const text = textBlocks(content).join('\n');
  if (text) return text;
  if (content === undefined || content === null) return '';
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

function toolCallHuman(result: {
  content: unknown;
  structured_content?: unknown;
}): string {
  const parts = [];
  const text = contentAsText(result.content);
  if (text) parts.push(text);
  if (result.structured_content !== undefined) {
    parts.push(JSON.stringify(result.structured_content, null, 2));
  }
  return parts.join('\n');
}

function orgLabel(userinfo: UserInfo | undefined): { org_id: string | null; org_name: string | null } {
  return {
    org_id: userinfo?.org_id ?? null,
    org_name: userinfo?.org_name ?? null,
  };
}

function targetLabel(
  userinfo: UserInfo | undefined,
  environment: string,
): string {
  const orgName = userinfo?.org_name ?? 'unknown org';
  const orgId = userinfo?.org_id ?? 'unknown';
  return `${orgName} (${orgId}) · ${environment}`;
}

async function resolveWriteTarget(baseUrl: string): Promise<UserInfo | undefined> {
  try {
    return await fetchUserInfo({ baseUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Warning: could not verify target org: ${message}\n`);
    return undefined;
  }
}

export async function invokeToolCall(
  name: string,
  opts: ToolExecutionOptions = {},
  argsFactory: ArgsFactory = async () => ({}),
): Promise<ToolCallData> {
  const baseUrl = resolveBaseUrl({ staging: opts.staging });
  const token = await getToken({ baseUrl });
  const tools = await listTools(baseUrl, token, { noCache: opts.noCache });
  const tool = findTool(tools, name);
  const classification = classify(tool);
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const readOnlyMode = opts.readOnly === true || process.env.EVERY_READ_ONLY === '1';
  const requirement = requirementFor(classification.level, {
    interactive,
    yes: opts.yes,
    allowDestructive: opts.allowDestructive,
    readOnlyMode,
  });

  if (!requirement.allowed) {
    throw new CliError(requirement.denialMessage ?? 'Tool call denied by policy.', ExitCode.PERMISSION, 'permission');
  }

  const gated = classification.level !== 'read';
  const environment = environmentNameForBaseUrl(baseUrl);
  const userinfo = gated ? await resolveWriteTarget(baseUrl) : undefined;
  const target = gated ? targetLabel(userinfo, environment) : undefined;

  if (requirement.prompt) {
    const confirmed = await promptForTool(name, classification.level, requirement.prompt, target);
    if (!confirmed) {
      throw new CliError('Tool call cancelled.', ExitCode.PERMISSION, 'permission');
    }
  }

  if (gated && !opts.json && target) {
    process.stderr.write(`→ ${target}\n`);
  }

  const args = await argsFactory();
  const result = await callTool(baseUrl, token, name, args, { timeoutMs: timeoutMs(opts.timeout) });
  const data = {
    tool: name,
    is_error: result.isError,
    content: result.content,
    structured_content: result.structuredContent,
    ...(gated ? { org: orgLabel(userinfo) } : {}),
  };

  if (result.isError) {
    const message = contentAsText(result.content) || 'Tool returned an error.';
    throw new CliError(message, ExitCode.GENERIC, 'generic');
  }

  return data;
}

export async function executeToolCall(
  name: string,
  opts: ToolExecutionOptions = {},
  argsFactory: ArgsFactory = async () => ({}),
  augmentData: DataAugmenter = (data) => data,
): Promise<void> {
  const data = await augmentData(await invokeToolCall(name, opts, argsFactory));
  emitCommand(data, toolCallHuman(data), opts);
  await maybeShowSkillHint();
}

export async function toolCallCommand(
  name: string,
  opts: ToolCallOptions = {},
): Promise<void> {
  await executeToolCall(name, opts, () => assembleArgs(opts));
}

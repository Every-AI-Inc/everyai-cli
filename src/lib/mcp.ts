import { mkdir, readFile, rename, stat, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { CliError } from './errors.js';
import { ExitCode } from './exit-codes.js';
import { environmentKeyForBaseUrl } from './auth/tokens.js';

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const TOOL_CACHE_TTL_MS = 10 * 60 * 1000;

export interface McpCallOptions {
  timeoutMs?: number;
}

export interface ListToolsOptions {
  noCache?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CallToolResult {
  content: unknown;
  structuredContent?: unknown;
  isError: boolean;
}

interface JsonRpcResponse<T> {
  jsonrpc?: string;
  id?: unknown;
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface ToolCacheFile {
  fetched_at: string | number;
  tools: McpTool[];
}

function mcpUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/`;
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function classifyHttpStatus(status: number): { exitCode: ExitCode; code: string } {
  if (status === 401) return { exitCode: ExitCode.AUTH, code: 'auth' };
  if (status === 402 || status === 403) {
    return { exitCode: ExitCode.PERMISSION, code: 'permission' };
  }
  if (status === 404) return { exitCode: ExitCode.NOT_FOUND, code: 'not_found' };
  if (status === 429) return { exitCode: ExitCode.RATE_LIMIT, code: 'rate_limit' };
  if (status === 406 || status >= 500) return { exitCode: ExitCode.NETWORK, code: 'network' };
  return { exitCode: ExitCode.GENERIC, code: 'generic' };
}

function dataBlocksFromSse(raw: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line === '') {
      if (current.length > 0) {
        blocks.push(current.join('\n'));
        current = [];
      }
      continue;
    }

    if (line.startsWith('data:')) current.push(line.slice('data:'.length).trimStart());
  }

  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}

function jsonTextFromResponse(raw: string): string {
  const trimmed = raw.trim();
  const blocks = dataBlocksFromSse(raw);
  if (blocks.length === 0) return trimmed;

  const parseable = blocks.find((block) => {
    try {
      JSON.parse(block);
      return true;
    } catch {
      return false;
    }
  });

  return parseable ?? blocks[0].trim();
}

function toolNameFromParams(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const name = (params as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function isUnknownToolError(error: NonNullable<JsonRpcResponse<unknown>['error']>, toolName?: string): boolean {
  const message = error.message ?? '';
  const lower = message.toLowerCase();
  const mentionsTool = toolName ? lower.includes(toolName.toLowerCase()) : false;
  const messageMatches =
    /unknown tool|tool .*not found|tool not found|no such tool|not found.*tool/i.test(message);

  if (messageMatches) return true;
  if (error.code === -32601) return true;
  return error.code === -32602 && mentionsTool;
}

function jsonRpcErrorToCliError(
  error: NonNullable<JsonRpcResponse<unknown>['error']>,
  params: unknown,
): CliError {
  const message = error.message ?? 'MCP JSON-RPC request failed';
  const toolName = toolNameFromParams(params);

  if (isUnknownToolError(error, toolName)) {
    return new CliError(message, ExitCode.NOT_FOUND, 'not_found');
  }

  if (error.code === -32602) return new CliError(message, ExitCode.USAGE, 'usage');

  return new CliError(message, ExitCode.GENERIC, 'generic');
}

function parseJsonRpcResponse<T>(raw: string, params: unknown): T {
  let body: JsonRpcResponse<T>;
  try {
    body = JSON.parse(jsonTextFromResponse(raw)) as JsonRpcResponse<T>;
  } catch {
    throw new CliError('Unexpected response from MCP server (not JSON)', ExitCode.NETWORK, 'network');
  }

  if (body.error) throw jsonRpcErrorToCliError(body.error, params);
  return body.result as T;
}

export async function mcpCall<T = unknown>(
  baseUrl: string,
  token: string,
  method: string,
  params: unknown = {},
  { timeoutMs = DEFAULT_MCP_TIMEOUT_MS }: McpCallOptions = {},
): Promise<T> {
  const url = mcpUrl(baseUrl);
  let response: Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `everyai-cli-${Date.now()}`,
        method,
        params,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new CliError(`Timed out reaching ${url} after ${timeoutMs}ms`, ExitCode.NETWORK, 'network');
    }

    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to reach ${url}: ${detail}`, ExitCode.NETWORK, 'network');
  }

  if (response.status === 401) {
    throw new CliError('Not logged in. Run \'every login\'.', ExitCode.AUTH, 'auth');
  }

  if (!response.ok) {
    const classified = classifyHttpStatus(response.status);
    throw new CliError(
      `MCP ${method} failed for ${url}: HTTP ${response.status}`,
      classified.exitCode,
      classified.code,
    );
  }

  return parseJsonRpcResponse<T>(await response.text(), params);
}

function safeEnvironmentKey(baseUrl: string): string {
  return environmentKeyForBaseUrl(baseUrl).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function toolsCacheFilePath(baseUrl: string): string {
  return path.join(getConfigDir(), 'cache', `tools-${safeEnvironmentKey(baseUrl)}.json`);
}

function fetchedAtMs(value: string | number): number {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isToolArray(value: unknown): value is McpTool[] {
  return Array.isArray(value) && value.every((tool) => {
    return Boolean(tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string');
  });
}

export async function readCachedTools(
  baseUrl: string,
  { allowStale = false }: { allowStale?: boolean } = {},
): Promise<McpTool[] | undefined> {
  let parsed: ToolCacheFile;
  try {
    parsed = JSON.parse(await readFile(toolsCacheFilePath(baseUrl), 'utf8')) as ToolCacheFile;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }

  if (!isToolArray(parsed.tools)) return undefined;
  if (!allowStale && Date.now() - fetchedAtMs(parsed.fetched_at) > TOOL_CACHE_TTL_MS) {
    return undefined;
  }

  return parsed.tools;
}

async function writeToolCache(baseUrl: string, tools: McpTool[]): Promise<void> {
  const filePath = toolsCacheFilePath(baseUrl);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(
    tempPath,
    JSON.stringify({ fetched_at: new Date().toISOString(), tools }, null, 2),
    { mode: 0o600 },
  );
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

export async function toolCacheFileMode(baseUrl: string): Promise<number | undefined> {
  try {
    return (await stat(toolsCacheFilePath(baseUrl))).mode & 0o777;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

export async function listTools(
  baseUrl: string,
  token: string,
  { noCache }: ListToolsOptions = {},
): Promise<McpTool[]> {
  if (!noCache) {
    const cached = await readCachedTools(baseUrl);
    if (cached) return cached;
  }

  const result = await mcpCall<{ tools?: unknown }>(baseUrl, token, 'tools/list', {});
  if (!isToolArray(result?.tools)) {
    throw new CliError('MCP tools/list returned an invalid tool registry', ExitCode.GENERIC, 'generic');
  }

  await writeToolCache(baseUrl, result.tools);
  return result.tools;
}

export async function callTool(
  baseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  { timeoutMs = DEFAULT_TOOL_TIMEOUT_MS }: McpCallOptions = {},
): Promise<CallToolResult> {
  const result = await mcpCall<{
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  }>(baseUrl, token, 'tools/call', { name, arguments: args }, { timeoutMs });

  return {
    content: result?.content ?? [],
    structuredContent: result?.structuredContent,
    isError: result?.isError === true,
  };
}

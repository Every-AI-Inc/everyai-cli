import { resolveBaseUrl } from '../lib/config.js';
import { readCachedTools } from '../lib/mcp.js';
import { emit } from '../lib/output.js';
import { classify, requirementDescription } from '../lib/policy.js';

interface PolicyExplainOptions {
  json?: boolean;
  staging?: boolean;
}

function emitCommand<T>(data: T, human: string, opts: PolicyExplainOptions): void {
  if (opts.json) emit(data, { json: true });
  else process.stdout.write(`${human}\n`);
}

export async function policyExplainCommand(
  name: string,
  opts: PolicyExplainOptions = {},
): Promise<void> {
  const baseUrl = resolveBaseUrl({ staging: opts.staging });
  const cachedTools = await readCachedTools(baseUrl, { allowStale: true }).catch(() => undefined);
  const tool = cachedTools?.find((candidate) => candidate.name === name) ?? { name };
  const classification = classify(tool);
  const requirements = requirementDescription(classification.level);
  const note = cachedTools?.some((candidate) => candidate.name === name)
    ? undefined
    : 'No cached tool metadata matched this name; classification used local overrides and name patterns only.';

  const data = {
    tool: name,
    level: classification.level,
    source: classification.source,
    reason: classification.reason,
    requirements,
    note,
  };

  const human = [
    `Tool: ${name}`,
    `Level: ${data.level}`,
    `Source: ${data.source}`,
    `Reason: ${data.reason}`,
    `Interactive: ${requirements.interactive}`,
    `Non-interactive: ${requirements.non_interactive}`,
    note ? `Note: ${note}` : undefined,
  ].filter((line): line is string => Boolean(line)).join('\n');

  emitCommand(data, human, opts);
}

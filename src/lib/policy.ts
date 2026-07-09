import { createInterface } from 'node:readline/promises';

export type PolicyLevel = 'read' | 'write' | 'destructive' | 'ai-mediated';
export type PolicySource = 'override' | 'annotation';

export interface PolicyTool {
  name: string;
  readOnly?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    readOnly?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
  };
}

export interface Classification {
  level: PolicyLevel;
  source: PolicySource;
  reason: string;
}

export interface RequirementOptions {
  interactive: boolean;
  yes?: boolean;
  allowDestructive?: boolean;
  readOnlyMode?: boolean;
}

export interface InvocationRequirement {
  allowed: boolean;
  prompt?: 'confirm' | 'typed';
  denialMessage?: string;
}

export interface RequirementDescription {
  interactive: string;
  non_interactive: string;
}

function annotationFlag(tool: PolicyTool, flattened: keyof PolicyTool, hint: string): boolean {
  const direct = tool[flattened];
  if (typeof direct === 'boolean') return direct;
  const annotations = tool.annotations as Record<string, unknown> | undefined;
  const hinted = annotations?.[hint];
  if (typeof hinted === 'boolean') return hinted;
  const alternate = annotations?.[flattened];
  return typeof alternate === 'boolean' ? alternate : false;
}

/**
 * Annotations are hints; this table encodes what we know the server actually
 * does. Keep these overrides conservative because they define the local safety
 * boundary before any network-side tool invocation.
 */
function overrideClassification(name: string): Classification | undefined {
  if (name === 'ask_assistant') {
    return {
      level: 'ai-mediated',
      source: 'override',
      reason:
        'ask_assistant routes to a write-capable Every AI agent despite its read-only annotation.',
    };
  }

  if (/^delete_|^void_/.test(name)) {
    return {
      level: 'destructive',
      source: 'override',
      reason: 'Tool name matches delete_/void_, which can remove or void account records.',
    };
  }

  if (/^send_/.test(name)) {
    return {
      level: 'destructive',
      source: 'override',
      reason: 'Tool name matches send_; sending has external impact on real recipients.',
    };
  }

  if (name === 'record_payment') {
    return {
      level: 'destructive',
      source: 'override',
      reason: 'record_payment changes financial records.',
    };
  }

  return undefined;
}

export function classify(tool: PolicyTool): Classification {
  const overridden = overrideClassification(tool.name);
  if (overridden) return overridden;

  const readOnly = annotationFlag(tool, 'readOnly', 'readOnlyHint');
  const destructive = annotationFlag(tool, 'destructive', 'destructiveHint');
  const openWorld = annotationFlag(tool, 'openWorld', 'openWorldHint');

  if (readOnly) {
    return {
      level: 'read',
      source: 'annotation',
      reason: 'Tool annotation marks it read-only.',
    };
  }

  if (destructive) {
    return {
      level: 'destructive',
      source: 'annotation',
      reason: 'Tool annotation marks it destructive.',
    };
  }

  if (openWorld) {
    return {
      level: 'destructive',
      source: 'annotation',
      reason: 'Tool annotation marks it open-world and not read-only.',
    };
  }

  return {
    level: 'write',
    source: 'annotation',
    reason: 'Tool is not annotated read-only; defaulting to write.',
  };
}

function readOnlyDenial(level: PolicyLevel): string {
  if (level === 'ai-mediated') {
    return 'Denied by read-only mode (--read-only/EVERY_READ_ONLY=1): ai-mediated tools are not allowed.';
  }
  return `Denied by read-only mode (--read-only/EVERY_READ_ONLY=1): ${level} tools are not allowed.`;
}

function aiMediatedExplanation(): string {
  return "This tool sends your request to Every's AI agent, which can take actions on your account; it is not mechanically read-only.";
}

export function requirementFor(
  level: PolicyLevel,
  { interactive, yes, allowDestructive, readOnlyMode }: RequirementOptions,
): InvocationRequirement {
  if (level === 'read') return { allowed: true };

  if (readOnlyMode) {
    return { allowed: false, denialMessage: readOnlyDenial(level) };
  }

  if (level === 'write' || level === 'ai-mediated') {
    if (yes) return { allowed: true };
    if (interactive) return { allowed: true, prompt: 'confirm' };

    const prefix = level === 'ai-mediated' ? `${aiMediatedExplanation()} ` : '';
    return {
      allowed: false,
      denialMessage: `${prefix}Re-run with --yes to confirm this write.`,
    };
  }

  if (yes && allowDestructive) return { allowed: true };
  if (interactive) return { allowed: true, prompt: 'typed' };

  const missing = [
    yes ? undefined : '--yes',
    allowDestructive ? undefined : '--allow-destructive',
  ].filter((flag): flag is string => Boolean(flag));

  return {
    allowed: false,
    denialMessage: `This destructive tool requires ${missing.join(' and ')} in non-interactive mode.`,
  };
}

export function requirementDescription(level: PolicyLevel): RequirementDescription {
  if (level === 'read') {
    return {
      interactive: 'Allowed with no confirmation.',
      non_interactive: 'Allowed with no confirmation.',
    };
  }

  if (level === 'write') {
    return {
      interactive: 'Requires y/N confirmation unless --yes is supplied.',
      non_interactive: 'Requires --yes.',
    };
  }

  if (level === 'ai-mediated') {
    return {
      interactive: `${aiMediatedExplanation()} Requires y/N confirmation unless --yes is supplied.`,
      non_interactive: `${aiMediatedExplanation()} Requires --yes.`,
    };
  }

  return {
    interactive:
      'Requires typing the tool name unless both --yes and --allow-destructive are supplied.',
    non_interactive: 'Requires --yes and --allow-destructive.',
  };
}

function confirmationPrompt(level: PolicyLevel, target?: string): string {
  const targetText = target ? ` Target: ${target}.` : '';
  if (level === 'ai-mediated') {
    return `${aiMediatedExplanation()}${targetText}\nContinue? [y/N] `;
  }

  return `This tool can modify your Every account.${targetText} Continue? [y/N] `;
}

export async function promptForTool(
  toolName: string,
  level: PolicyLevel,
  prompt: 'confirm' | 'typed',
  target?: string,
): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (prompt === 'confirm') {
      const answer = await rl.question(confirmationPrompt(level, target));
      return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
    }

    const targetText = target ? ` for ${target}` : '';
    const answer = await rl.question(`Type ${toolName} to confirm${targetText}: `);
    return answer.trim() === toolName;
  } finally {
    rl.close();
  }
}

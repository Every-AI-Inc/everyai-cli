export const MCP_GATE_MARKER_PREFIX = 'EVERY_MCP_GATE:';
export const MCP_GATE_META_KEY = 'everyai/mcp_gate';
export const SERVER_CONFIRMATION_ARG = 'confirmation';

export interface TextConfirmationMarker {
  version: 1;
  type: 'text_confirmation';
  confirmation: string;
}

export interface HumanApprovalMarker {
  version: 1;
  type: 'human_approval';
  status: string;
  request_id?: string;
  expires_at?: string;
}

export type McpGateMarker = TextConfirmationMarker | HumanApprovalMarker;

interface LocatedMarker {
  marker: McpGateMarker;
  start: number;
  end: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Return the first complete JSON object beginning at `start`. A balanced scan
 * handles escaped quotes and braces inside confirmation text without relying
 * on a phrase-shaped regex.
 */
function jsonObjectAt(text: string, start: number): string | undefined {
  if (text[start] !== '{') return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function validatedMarker(value: unknown): McpGateMarker | undefined {
  if (!isObject(value) || value.version !== 1 || typeof value.type !== 'string') {
    return undefined;
  }

  if (
    value.type === 'text_confirmation' &&
    typeof value.confirmation === 'string' &&
    value.confirmation.trim().length > 0
  ) {
    return {
      version: 1,
      type: 'text_confirmation',
      confirmation: value.confirmation,
    };
  }

  if (
    value.type === 'human_approval' &&
    typeof value.status === 'string' &&
    value.status.trim().length > 0
  ) {
    const marker: HumanApprovalMarker = {
      version: 1,
      type: 'human_approval',
      status: value.status,
    };
    if (typeof value.request_id === 'string') marker.request_id = value.request_id;
    if (typeof value.expires_at === 'string') marker.expires_at = value.expires_at;
    return marker;
  }

  return undefined;
}

/**
 * Read the trusted gate contract from MCP result metadata. Only this path may
 * authorize a retry or classify a result as permission-related.
 */
export function parseMcpGateMetadata(meta: unknown): McpGateMarker | undefined {
  if (!isObject(meta)) return undefined;
  return validatedMarker(meta[MCP_GATE_META_KEY]);
}

/**
 * Parse the server's text marker for display cleanup only. Never use prose to
 * authorize a retry: tool output may include attacker-controlled text after a
 * partial side effect.
 */
function locateMcpGateMarker(text: string): LocatedMarker | undefined {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const markerAt = text.indexOf(MCP_GATE_MARKER_PREFIX, searchFrom);
    if (markerAt === -1) return undefined;

    const jsonAt = markerAt + MCP_GATE_MARKER_PREFIX.length;
    const raw = jsonObjectAt(text, jsonAt);
    if (raw) {
      try {
        const marker = validatedMarker(JSON.parse(raw));
        if (marker) {
          return {
            marker,
            start: markerAt,
            end: jsonAt + raw.length,
          };
        }
      } catch {
        // Keep looking: a malformed occurrence must not hide a later valid one.
      }
    }
    searchFrom = jsonAt + 1;
  }
  return undefined;
}

/** Parse the prose copy for display cleanup and tests, never authorization. */
export function parseMcpGateMarker(text: string): McpGateMarker | undefined {
  return locateMcpGateMarker(text)?.marker;
}

/** Remove the machine marker from human-facing error copy. */
export function withoutMcpGateMarker(text: string): string {
  const located = locateMcpGateMarker(text);
  if (!located) return text;
  return `${text.slice(0, located.start)}${text.slice(located.end)}`
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

import { describe, it, expect } from 'vitest';
import {
  successEnvelope,
  errorEnvelope,
  formatSuccess,
  formatError,
} from '../src/lib/output';

describe('output envelope', () => {
  it('builds a success envelope with schema_version 1 and ok:true', () => {
    const env = successEnvelope({ hello: 'world' });
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe(1);
    expect(env.data).toEqual({ hello: 'world' });
  });

  it('builds an error envelope with schema_version 1 and ok:false', () => {
    const env = errorEnvelope('boom', 'network');
    expect(env.ok).toBe(false);
    expect(env.schema_version).toBe(1);
    expect(env.error).toEqual({ message: 'boom', code: 'network' });
  });

  it('formats --json success as pure JSON with the envelope shape', () => {
    const out = formatSuccess({ a: 1 }, { json: true });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.data).toEqual({ a: 1 });
  });

  it('never mixes human prose into --json error output', () => {
    const out = formatError('boom', 'network', { json: true });
    // Must parse cleanly as a single JSON object...
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.error).toEqual({ message: 'boom', code: 'network' });
    // ...and carry none of the human-mode framing.
    expect(out).not.toContain('Error:');
  });

  it('uses human text (not JSON) when --json is off', () => {
    expect(formatError('boom', 'network', {})).toBe('Error: boom');
    expect(formatSuccess('hi', {})).toBe('hi');
  });
});

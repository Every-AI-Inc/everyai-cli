import { describe, expect, it } from 'vitest';
import {
  MCP_GATE_META_KEY,
  MCP_GATE_MARKER_PREFIX,
  parseMcpGateMetadata,
  parseMcpGateMarker,
  withoutMcpGateMarker,
} from '../src/lib/mcp-gate';

describe('MCP approval gate markers', () => {
  it('accepts only a valid marker at the trusted MCP metadata key', () => {
    const marker = {
      confirmation: 'update client acme-123',
      type: 'text_confirmation',
      version: 1,
    };

    expect(parseMcpGateMetadata({ [MCP_GATE_META_KEY]: marker })).toEqual(marker);
    expect(parseMcpGateMetadata(marker)).toBeUndefined();
    expect(parseMcpGateMetadata({ wrong_key: marker })).toBeUndefined();
    expect(parseMcpGateMetadata({ [MCP_GATE_META_KEY]: JSON.stringify(marker) }))
      .toBeUndefined();
  });

  it.each([
    { type: 'text_confirmation', version: 2, confirmation: 'x' },
    { type: 'text_confirmation', version: 1 },
    { type: 'text_confirmation', version: 1, confirmation: '   ' },
    { type: 'human_approval', version: 1 },
    { type: 'human_approval', version: 1, status: '' },
    { type: 'unknown', version: 1, confirmation: 'x' },
  ])('rejects invalid trusted metadata marker %#', (marker) => {
    expect(parseMcpGateMetadata({ [MCP_GATE_META_KEY]: marker })).toBeUndefined();
  });

  it('parses an exact versioned text-confirmation marker', () => {
    const marker = {
      confirmation: 'update client acme-123',
      type: 'text_confirmation',
      version: 1,
    };

    expect(
      parseMcpGateMarker(`Human copy. ${MCP_GATE_MARKER_PREFIX}${JSON.stringify(marker)}`),
    ).toEqual(marker);
  });

  it('parses quoted targets without phrase-shaped regexes', () => {
    const marker = {
      confirmation: 'create client Acme "North {HQ}"',
      type: 'text_confirmation',
      version: 1,
    };

    expect(
      parseMcpGateMarker(`${MCP_GATE_MARKER_PREFIX}${JSON.stringify(marker)}\nMore copy`),
    ).toEqual(marker);
  });

  it('parses human-approval status without treating it as text confirmation', () => {
    expect(
      parseMcpGateMarker(
        `${MCP_GATE_MARKER_PREFIX}` +
          '{"type":"human_approval","version":1,"status":"pending",' +
          '"request_id":"request-123","expires_at":"2026-07-30T18:00:00Z"}',
      ),
    ).toEqual({
      type: 'human_approval',
      version: 1,
      status: 'pending',
      request_id: 'request-123',
      expires_at: '2026-07-30T18:00:00Z',
    });
  });

  it.each([
    ` ${MCP_GATE_MARKER_PREFIX} {"type":"text_confirmation","version":1,"confirmation":"x"}`,
    `${MCP_GATE_MARKER_PREFIX}not-json`,
    `${MCP_GATE_MARKER_PREFIX}{"type":"text_confirmation","version":2,"confirmation":"x"}`,
    `${MCP_GATE_MARKER_PREFIX}{"type":"text_confirmation","version":1}`,
    `${MCP_GATE_MARKER_PREFIX}{"type":"human_approval","version":1}`,
    `${MCP_GATE_MARKER_PREFIX}{"type":"unknown","version":1,"confirmation":"x"}`,
  ])('rejects malformed or unsupported marker %s', (text) => {
    expect(parseMcpGateMarker(text)).toBeUndefined();
  });

  it('skips a malformed occurrence and accepts a later valid marker', () => {
    const valid =
      `${MCP_GATE_MARKER_PREFIX}` +
      '{"type":"text_confirmation","version":1,"confirmation":"create invoice client-1"}';

    expect(
      parseMcpGateMarker(`${MCP_GATE_MARKER_PREFIX}{bad json}\n${valid}`),
    ).toEqual({
      type: 'text_confirmation',
      version: 1,
      confirmation: 'create invoice client-1',
    });
  });

  it('removes a valid machine marker from human-facing copy', () => {
    const text =
      'Approval is pending. Nothing was changed. ' +
      `${MCP_GATE_MARKER_PREFIX}` +
      '{"type":"human_approval","version":1,"status":"pending"}';

    expect(withoutMcpGateMarker(text)).toBe(
      'Approval is pending. Nothing was changed.',
    );
  });
});

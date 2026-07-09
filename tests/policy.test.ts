import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, requirementFor } from '../src/lib/policy';

interface FixtureTool {
  name: string;
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
}

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'tools-annotations.json',
);
const tools = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureTool[];

function isOverridden(name: string): boolean {
  return (
    name === 'ask_assistant' ||
    name === 'record_payment' ||
    /^delete_|^void_|^send_/.test(name)
  );
}

describe('policy classification', () => {
  it('covers the full snapshotted live tool registry', () => {
    expect(tools).toHaveLength(52);
  });

  it('classifies destructive name and financial-record overrides as destructive', () => {
    const destructiveTools = tools.filter((tool) => {
      return /^send_|^delete_|^void_/.test(tool.name) || tool.name === 'record_payment';
    });

    expect(destructiveTools.length).toBeGreaterThan(0);
    for (const tool of destructiveTools) {
      expect(classify(tool)).toMatchObject({ level: 'destructive', source: 'override' });
    }
  });

  it('classifies ask_assistant as ai-mediated despite readOnly:true', () => {
    const askAssistant = tools.find((tool) => tool.name === 'ask_assistant');

    expect(askAssistant).toMatchObject({ readOnly: true });
    expect(classify(askAssistant!)).toMatchObject({
      level: 'ai-mediated',
      source: 'override',
    });
  });

  it('classifies annotation-readOnly tools as read except local overrides', () => {
    for (const tool of tools.filter((candidate) => candidate.readOnly && !isOverridden(candidate.name))) {
      expect(classify(tool)).toMatchObject({ level: 'read', source: 'annotation' });
    }
  });

  it('never classifies create/update/send/delete tools as read', () => {
    const mutableByName = tools.filter((tool) => /^(create|update|send|delete)_/.test(tool.name));

    expect(mutableByName.length).toBeGreaterThan(0);
    for (const tool of mutableByName) {
      expect(classify(tool).level).not.toBe('read');
    }
  });
});

describe('policy requirements', () => {
  it('requires --yes for non-interactive writes', () => {
    expect(requirementFor('write', { interactive: false })).toMatchObject({
      allowed: false,
      denialMessage: 'Re-run with --yes to confirm this write.',
    });
    expect(requirementFor('write', { interactive: false, yes: true })).toEqual({
      allowed: true,
    });
  });

  it('requires both destructive flags in non-interactive mode', () => {
    expect(requirementFor('destructive', { interactive: false, yes: true })).toMatchObject({
      allowed: false,
      denialMessage: expect.stringContaining('--allow-destructive'),
    });
    expect(
      requirementFor('destructive', {
        interactive: false,
        yes: true,
        allowDestructive: true,
      }),
    ).toEqual({ allowed: true });
  });

  it('read-only mode allows only read tools', () => {
    expect(requirementFor('read', { interactive: false, readOnlyMode: true })).toEqual({
      allowed: true,
    });
    expect(requirementFor('ai-mediated', { interactive: false, readOnlyMode: true })).toMatchObject({
      allowed: false,
      denialMessage: expect.stringContaining('read-only mode'),
    });
  });
});

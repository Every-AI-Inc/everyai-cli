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
    name === 'run_recurring_invoice_now' ||
    /^delete_|^void_|^send_|^cancel_/.test(name)
  );
}

function tool(name: string): FixtureTool {
  const found = tools.find((candidate) => candidate.name === name);
  expect(found, `missing ${name} from production fixture`).toBeDefined();
  return found!;
}

describe('policy classification', () => {
  it('covers the full snapshotted live tool registry', () => {
    expect(tools).toHaveLength(78);
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

  it('classifies the new Gmail tools correctly', () => {
    for (const name of ['search_gmail_threads', 'get_gmail_thread', 'get_gmail_message']) {
      expect(classify(tool(name))).toMatchObject({ level: 'read', source: 'annotation' });
    }
    expect(classify(tool('draft_email'))).toMatchObject({ level: 'write', source: 'annotation' });
    expect(classify(tool('send_email'))).toMatchObject({
      level: 'destructive',
      source: 'override',
    });
  });

  it('keeps non-destructive open-world calendar and booking actions at write', () => {
    for (const name of [
      'create_calendar_event',
      'reschedule_calendar_event',
      'create_booking',
      'reschedule_booking',
    ]) {
      expect(tool(name)).toMatchObject({ readOnly: false, destructive: false, openWorld: true });
      expect(classify(tool(name))).toMatchObject({ level: 'write', source: 'annotation' });
    }
  });

  it('classifies cancel actions and immediate recurring invoice runs as destructive', () => {
    for (const name of [
      'cancel_calendar_event',
      'cancel_booking',
      'run_recurring_invoice_now',
    ]) {
      expect(classify(tool(name))).toMatchObject({
        level: 'destructive',
        source: 'override',
      });
    }
  });

  it('classifies the remaining new reads as free and recurring invoice mutations as writes', () => {
    for (const name of [
      'list_calendar_events',
      'check_calendar_availability',
      'check_booking_availability',
      'list_prospects',
      'view_prospect',
      'network_summary',
      'get_daily_brief',
      'get_heartbeat_summary',
      'get_financial_report',
      'list_recurring_invoices',
    ]) {
      expect(classify(tool(name))).toMatchObject({ level: 'read', source: 'annotation' });
    }

    for (const name of [
      'create_recurring_invoice',
      'update_recurring_invoice',
      'pause_recurring_invoice',
      'resume_recurring_invoice',
    ]) {
      expect(classify(tool(name))).toMatchObject({ level: 'write', source: 'annotation' });
    }
  });

  it('explains high-risk tools correctly without annotation metadata', () => {
    expect(classify({ name: 'send_email' })).toMatchObject({ level: 'destructive', source: 'override' });
    expect(classify({ name: 'draft_email' })).toMatchObject({ level: 'write', source: 'annotation' });
    expect(classify({ name: 'cancel_booking' })).toMatchObject({ level: 'destructive', source: 'override' });
    expect(classify({ name: 'run_recurring_invoice_now' })).toMatchObject({
      level: 'destructive',
      source: 'override',
    });
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

  it('describes ask_assistant as server-enforced read-only', () => {
    expect(requirementFor('ai-mediated', { interactive: false })).toMatchObject({
      allowed: false,
      denialMessage: expect.stringContaining('server-enforced read-only'),
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

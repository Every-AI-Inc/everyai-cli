import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PluginMetadata {
  name: string;
  description?: string;
  author?: { name?: string };
  homepage?: string;
  repository?: string;
  version?: string;
}

describe('agent plugin packaging', () => {
  it('has a valid Claude Code plugin manifest named every', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
    ) as PluginMetadata;

    expect(manifest).toMatchObject({
      name: 'every',
      author: { name: 'Every AI Inc.' },
      homepage: 'https://every.ai',
      repository: 'https://github.com/Every-AI-Inc/everyai-cli',
    });
    expect(manifest.version).toBeUndefined();
    expect(readdirSync(new URL('../.claude-plugin/', import.meta.url))).toEqual(['plugin.json']);
  });
});

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
    expect(readdirSync(new URL('../.claude-plugin/', import.meta.url)).sort()).toEqual([
      'marketplace.json',
      'plugin.json',
    ]);
  });

  it('has a Claude Code marketplace that serves `/plugin install every@everyai-cli`', () => {
    const marketplace = JSON.parse(
      readFileSync(new URL('../.claude-plugin/marketplace.json', import.meta.url), 'utf8'),
    ) as { name: string; owner: { name: string }; plugins: Array<{ name: string; source: string }> };
    const manifest = JSON.parse(
      readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
    ) as PluginMetadata;
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

    expect(marketplace.name).toBe('everyai-cli');
    expect(marketplace.owner.name).toBe('Every AI Inc.');
    // The plugin is the repository root, where .claude-plugin/plugin.json and skills/ live.
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: manifest.name, source: './' })]);
    expect(readme).toContain('/plugin marketplace add Every-AI-Inc/everyai-cli');
    expect(readme).toContain(`/plugin install ${manifest.name}@${marketplace.name}`);
  });
});

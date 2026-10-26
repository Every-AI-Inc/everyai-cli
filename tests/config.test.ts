import { describe, it, expect, afterEach } from 'vitest';
import {
  CONFIG_DIR,
  getConfigDir,
  resolveBaseUrl,
  PROD_BASE_URL,
  STAGING_BASE_URL,
} from '../src/lib/config';

const ORIGINAL = {
  EVERY_MCP_URL: process.env.EVERY_MCP_URL,
  EVERY_ENV: process.env.EVERY_ENV,
  EVERY_CONFIG_DIR: process.env.EVERY_CONFIG_DIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('resolveBaseUrl', () => {
  it('returns the staging URL when { staging: true }', () => {
    delete process.env.EVERY_MCP_URL;
    delete process.env.EVERY_ENV;
    expect(resolveBaseUrl({ staging: true })).toBe(STAGING_BASE_URL);
    expect(resolveBaseUrl({ staging: true })).toBe(
      'https://admin-mcp-staging.up.railway.app',
    );
  });

  it('returns the prod URL by default', () => {
    delete process.env.EVERY_MCP_URL;
    delete process.env.EVERY_ENV;
    expect(resolveBaseUrl({})).toBe(PROD_BASE_URL);
    expect(resolveBaseUrl()).toBe('https://admin-mcp.every.ai');
  });

  it('uses --staging before EVERY_MCP_URL', () => {
    process.env.EVERY_MCP_URL = 'http://localhost:9999';
    expect(resolveBaseUrl({})).toBe('http://localhost:9999');
    expect(resolveBaseUrl({ staging: true })).toBe(STAGING_BASE_URL);
  });

  it('uses EVERY_ENV when no flag or URL override is set', () => {
    delete process.env.EVERY_MCP_URL;
    process.env.EVERY_ENV = 'staging';
    expect(resolveBaseUrl()).toBe(STAGING_BASE_URL);

    process.env.EVERY_ENV = 'production';
    expect(resolveBaseUrl()).toBe(PROD_BASE_URL);
  });

  it('uses EVERY_MCP_URL before EVERY_ENV', () => {
    process.env.EVERY_MCP_URL = 'http://localhost:9999';
    process.env.EVERY_ENV = 'staging';
    expect(resolveBaseUrl()).toBe('http://localhost:9999');
  });
});

describe('getConfigDir', () => {
  it('keeps the existing default path when XDG_CONFIG_HOME is unset', () => {
    delete process.env.EVERY_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    expect(getConfigDir()).toBe(CONFIG_DIR);
  });

  it('honors XDG_CONFIG_HOME when EVERY_CONFIG_DIR is unset', () => {
    delete process.env.EVERY_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
    expect(getConfigDir()).toBe('/tmp/xdg-config/everyai');
  });

  it('keeps EVERY_CONFIG_DIR as the strongest config-dir override', () => {
    process.env.EVERY_CONFIG_DIR = '/tmp/every-config';
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
    expect(getConfigDir()).toBe('/tmp/every-config');
  });
});

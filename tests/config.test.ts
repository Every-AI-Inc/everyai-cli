import { describe, it, expect, afterEach } from 'vitest';
import {
  CONFIG_DIR,
  getConfigDir,
  PROD_SIGNUP_URL,
  resolveBaseUrl,
  PROD_BASE_URL,
  signupUrlForBaseUrl,
  STAGING_BASE_URL,
  STAGING_SIGNUP_URL,
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

describe('signupUrlForBaseUrl', () => {
  it('returns the production signup URL for the production base URL', () => {
    expect(signupUrlForBaseUrl(PROD_BASE_URL)).toBe(PROD_SIGNUP_URL);
    expect(signupUrlForBaseUrl(PROD_BASE_URL)).toBe('https://app.every.ai/sign-up');
  });

  it('returns the staging signup URL for the staging base URL', () => {
    expect(signupUrlForBaseUrl(STAGING_BASE_URL)).toBe(STAGING_SIGNUP_URL);
    expect(signupUrlForBaseUrl(STAGING_BASE_URL)).toBe(
      'https://app.staging.every.ai/sign-up',
    );
  });

  it('returns the production signup URL for a custom base URL', () => {
    expect(signupUrlForBaseUrl('http://localhost:9999')).toBe(PROD_SIGNUP_URL);
  });
});

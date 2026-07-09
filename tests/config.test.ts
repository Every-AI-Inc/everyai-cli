import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveBaseUrl,
  PROD_BASE_URL,
  STAGING_BASE_URL,
} from '../src/lib/config';

const ORIGINAL = process.env.EVERY_MCP_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EVERY_MCP_URL;
  else process.env.EVERY_MCP_URL = ORIGINAL;
});

describe('resolveBaseUrl', () => {
  it('returns the staging URL when { staging: true }', () => {
    delete process.env.EVERY_MCP_URL;
    expect(resolveBaseUrl({ staging: true })).toBe(STAGING_BASE_URL);
    expect(resolveBaseUrl({ staging: true })).toBe(
      'https://admin-mcp-staging.up.railway.app',
    );
  });

  it('returns the prod URL by default', () => {
    delete process.env.EVERY_MCP_URL;
    expect(resolveBaseUrl({})).toBe(PROD_BASE_URL);
    expect(resolveBaseUrl()).toBe('https://admin-mcp.every.ai');
  });

  it('honors the EVERY_MCP_URL override over both prod and staging', () => {
    process.env.EVERY_MCP_URL = 'http://localhost:9999';
    expect(resolveBaseUrl({})).toBe('http://localhost:9999');
    expect(resolveBaseUrl({ staging: true })).toBe('http://localhost:9999');
  });
});

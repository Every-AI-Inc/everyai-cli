export interface JwtClaims {
  sub?: string;
  email?: string;
  org_id?: string;
  org_slug?: string;
  org_name?: string;
  organization_id?: string;
  organization_slug?: string;
  organization_name?: string;
  exp?: number;
  iat?: number;
  [claim: string]: unknown;
}

export function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;

  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as JwtClaims;
  } catch {
    return null;
  }
}


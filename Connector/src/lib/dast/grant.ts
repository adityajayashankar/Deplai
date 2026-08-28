import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const DAST_POLICY_VERSION = '2026.08.1';

export function dastAuthzSecret(): string {
  return String(process.env.DAST_AUTHZ_SECRET || process.env.DEPLAI_SERVICE_KEY || '').trim();
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newVerificationToken(): string {
  return randomBytes(32).toString('base64url');
}

export type DastGrantPayload = {
  asset_id: string;
  project_id: string;
  hostname: string;
  scope_mode: string;
  status: string;
  verification_expires_at: string;
  issued_at: string;
  grant_expires_at: string;
  policy_version: string;
  verification_method?: string;
  scheme?: string;
  signature?: string;
};

export function canonicalGrant(payload: DastGrantPayload): string {
  return [
    payload.asset_id || '',
    payload.project_id || '',
    String(payload.hostname || '').trim().replace(/\.$/, '').toLowerCase(),
    payload.scope_mode || '',
    payload.status || '',
    payload.verification_expires_at || '',
    payload.issued_at || '',
    payload.grant_expires_at || '',
    payload.policy_version || DAST_POLICY_VERSION,
  ].join('|');
}

export function signGrant(payload: DastGrantPayload, secret = dastAuthzSecret()): string {
  if (!secret) {
    throw new Error('DAST authorization signing secret is not configured.');
  }
  return createHmac('sha256', secret).update(canonicalGrant(payload), 'utf8').digest('hex');
}

export function verifyGrant(payload: DastGrantPayload, secret = dastAuthzSecret()): boolean {
  const provided = String(payload.signature || '').trim();
  if (!provided || !secret) return false;
  const expected = signGrant(payload, secret);
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function issueGrant(input: {
  assetId: string;
  projectId: string;
  hostname: string;
  scopeMode: string;
  verificationExpiresAt: string;
  verificationMethod?: string;
  scheme?: string;
  ttlSeconds?: number;
}): DastGrantPayload {
  const issuedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const ttl = Math.max(60, input.ttlSeconds || Number(process.env.DAST_GRANT_TTL_SECONDS || 900));
  const grantExpires = new Date(Date.now() + ttl * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const payload: DastGrantPayload = {
    asset_id: input.assetId,
    project_id: input.projectId,
    hostname: input.hostname.trim().replace(/\.$/, '').toLowerCase(),
    scope_mode: input.scopeMode,
    status: 'VERIFIED',
    verification_expires_at: input.verificationExpiresAt,
    issued_at: issuedAt,
    grant_expires_at: grantExpires,
    policy_version: DAST_POLICY_VERSION,
    verification_method: input.verificationMethod,
    scheme: input.scheme || 'https',
  };
  payload.signature = signGrant(payload);
  return payload;
}

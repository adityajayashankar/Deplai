import { randomUUID } from 'node:crypto';
import { query } from '@/lib/db';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { DAST_POLICY_VERSION, hashToken, issueGrant, newVerificationToken } from './grant';
import { hostnameInScope, type DastScopeMode } from './scope';
import { ensureDastSchema } from './schema';

export type DastAssetRow = {
  id: string;
  project_id: string;
  user_id: string;
  target_url: string;
  normalized_url: string;
  hostname: string;
  scheme: string;
  port: number | null;
  path_prefix: string | null;
  environment: string;
  scope_mode: DastScopeMode;
  status: string;
  verification_method: string | null;
  verification_token_hash: string;
  verification_token: string | null;
  verified_at: string | Date | null;
  expires_at: string | Date | null;
  last_checked_at: string | Date | null;
  revoked_at: string | Date | null;
  evidence_hash: string | null;
  created_by: string;
  created_at: string | Date;
};

const USER_NOT_AUTHORIZED =
  'This target is not associated with the selected project and ownership has not been verified.';

function iso(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parsePublicTarget(raw: string): {
  ok: true;
  url: string;
  hostname: string;
  scheme: string;
  port: number | null;
  path: string;
} | { ok: false; code: string; error: string } {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, code: 'DAST_INVALID_TARGET', error: 'A target URL is required.' };
  if (input.length > 2048) return { ok: false, code: 'DAST_INVALID_TARGET', error: 'Target URL is too long.' };
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, code: 'DAST_INVALID_TARGET', error: 'Target URL is malformed.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'DAST_INVALID_TARGET', error: 'Dynamic testing only accepts http or https targets.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: 'DAST_UNSAFE_TARGET', error: 'Target URL must not include credentials.' };
  }
  const hostname = parsed.hostname.trim().replace(/\.$/, '').toLowerCase();
  if (!hostname) return { ok: false, code: 'DAST_INVALID_TARGET', error: 'Target URL is missing a hostname.' };
  if (hostname === 'localhost' || hostname === 'localhost.localdomain' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { ok: false, code: 'DAST_UNSAFE_TARGET', error: 'Target hostname is not allowed for dynamic testing.' };
  }
  if (hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1' || hostname === '169.254.169.254') {
    return { ok: false, code: 'DAST_PRIVATE_IP_BLOCKED', error: 'Target must be a public application URL, not an internal address.' };
  }
  const port = parsed.port ? Number(parsed.port) : null;
  return {
    ok: true,
    url: parsed.toString(),
    hostname,
    scheme: parsed.protocol.replace(':', ''),
    port: Number.isFinite(port) ? port : null,
    path: parsed.pathname || '/',
  };
}

export function publicAsset(row: DastAssetRow, { includeToken = false } = {}) {
  return {
    id: row.id,
    project_id: row.project_id,
    target_url: row.target_url,
    hostname: row.hostname,
    scheme: row.scheme,
    environment: row.environment,
    scope_mode: row.scope_mode,
    status: row.status,
    verification_method: row.verification_method,
    verified_at: row.verified_at ? iso(row.verified_at) : null,
    expires_at: row.expires_at ? iso(row.expires_at) : null,
    dns_name: `_deplai-verify.${row.hostname}`,
    verification_token: includeToken && row.status === 'PENDING' ? row.verification_token : undefined,
    txt_value: includeToken && row.status === 'PENDING' && row.verification_token
      ? `deplai-domain-verification=${row.verification_token}`
      : undefined,
    http_path: includeToken && row.status === 'PENDING' && row.verification_token
      ? `/.well-known/deplai-verification/${row.verification_token}`
      : undefined,
  };
}

export async function listAssets(userId: string, projectId: string): Promise<DastAssetRow[]> {
  await ensureDastSchema();
  return query<DastAssetRow[]>(
    `SELECT * FROM dast_assets WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC`,
    [userId, projectId],
  );
}

export async function getAsset(userId: string, assetId: string): Promise<DastAssetRow | null> {
  await ensureDastSchema();
  const rows = await query<DastAssetRow[]>(
    `SELECT * FROM dast_assets WHERE id = ? AND user_id = ? LIMIT 1`,
    [assetId, userId],
  );
  return rows[0] || null;
}

export async function getAssetById(assetId: string): Promise<DastAssetRow | null> {
  await ensureDastSchema();
  const rows = await query<DastAssetRow[]>(
    `SELECT * FROM dast_assets WHERE id = ? LIMIT 1`,
    [assetId],
  );
  return rows[0] || null;
}

export async function writeAudit(input: {
  projectId: string;
  userId: string;
  assetId?: string | null;
  scanId?: string | null;
  action: string;
  decision: string;
  reason?: string;
}) {
  await ensureDastSchema();
  await query(
    `INSERT INTO dast_audit_events
      (id, project_id, user_id, asset_id, scan_id, action, decision, reason, policy_version, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      input.projectId,
      input.userId,
      input.assetId || null,
      input.scanId || null,
      input.action,
      input.decision,
      input.reason || null,
      DAST_POLICY_VERSION,
      input.scanId || input.assetId || null,
    ],
  );
}

export async function createAsset(input: {
  userId: string;
  projectId: string;
  targetUrl: string;
  environment: string;
  scopeMode: DastScopeMode;
}): Promise<DastAssetRow> {
  await ensureDastSchema();
  const parsed = parsePublicTarget(input.targetUrl);
  if (!parsed.ok) {
    throw Object.assign(new Error(parsed.error), { code: parsed.code, status: 400 });
  }
  const token = newVerificationToken();
  const id = randomUUID();
  await query(
    `INSERT INTO dast_assets (
      id, project_id, user_id, target_url, normalized_url, hostname, scheme, port, path_prefix,
      environment, scope_mode, status, verification_token_hash, verification_token, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.userId,
      input.targetUrl.trim(),
      parsed.url,
      parsed.hostname,
      parsed.scheme,
      parsed.port,
      parsed.path === '/' ? null : parsed.path,
      input.environment || 'production',
      input.scopeMode,
      hashToken(token),
      token,
      input.userId,
    ],
  );
  await writeAudit({
    projectId: input.projectId,
    userId: input.userId,
    assetId: id,
    action: 'DAST_ASSET_CREATED',
    decision: 'allow',
    reason: 'PENDING',
  });
  const created = await getAsset(input.userId, id);
  if (!created) throw new Error('Failed to create DAST asset.');
  return created;
}

export async function revokeAsset(userId: string, assetId: string): Promise<DastAssetRow | null> {
  const asset = await getAsset(userId, assetId);
  if (!asset) return null;
  await query(
    `UPDATE dast_assets
     SET status = 'REVOKED', revoked_at = UTC_TIMESTAMP(), verification_token = NULL, updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND user_id = ?`,
    [assetId, userId],
  );
  await writeAudit({
    projectId: asset.project_id,
    userId,
    assetId,
    action: 'DAST_DOMAIN_REVOKED',
    decision: 'deny',
    reason: 'REVOKED',
  });
  return getAsset(userId, assetId);
}

async function agenticOwnership(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${AGENTIC_URL}${path}`, {
    method: 'POST',
    headers: agenticHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as {
    ok?: boolean;
    code?: string;
    message?: string;
    evidence_hash?: string;
  };
  if (!response.ok) {
    throw Object.assign(new Error(payload.message || 'Ownership check failed.'), {
      code: payload.code || 'DAST_DOMAIN_NOT_VERIFIED',
      status: response.status,
    });
  }
  return payload;
}

export async function verifyAsset(userId: string, assetId: string, method: 'DNS_TXT' | 'HTTP') {
  const asset = await getAsset(userId, assetId);
  if (!asset) return null;
  if (asset.status === 'REVOKED') {
    throw Object.assign(new Error(USER_NOT_AUTHORIZED), { code: 'DAST_VERIFICATION_REVOKED', status: 403 });
  }
  if (!asset.verification_token) {
    throw Object.assign(new Error('Verification token is no longer available. Recreate the target.'), {
      code: 'DAST_DOMAIN_NOT_VERIFIED',
      status: 400,
    });
  }

  const payload = method === 'DNS_TXT'
    ? await agenticOwnership('/api/dast/ownership/dns', {
        domain: asset.hostname,
        expected_token_hash: asset.verification_token_hash,
      })
    : await agenticOwnership('/api/dast/ownership/http', {
        hostname: asset.hostname,
        token: asset.verification_token,
        expected_token_hash: asset.verification_token_hash,
        scheme: asset.scheme === 'http' ? 'http' : 'https',
      });

  await query(
    `UPDATE dast_assets SET last_checked_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?`,
    [assetId],
  );

  if (!payload.ok) {
    throw Object.assign(new Error(payload.message || 'Ownership has not been verified.'), {
      code: payload.code || 'DAST_DOMAIN_NOT_VERIFIED',
      status: 400,
    });
  }

  const ttlDays = Math.max(1, Number(process.env.DAST_VERIFICATION_TTL_DAYS || 90));
  await query(
    `UPDATE dast_assets
     SET status = 'VERIFIED',
         verification_method = ?,
         verified_at = UTC_TIMESTAMP(),
         expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY),
         evidence_hash = ?,
         verification_token = NULL,
         updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND user_id = ?`,
    [method, ttlDays, payload.evidence_hash || null, assetId, userId],
  );
  await writeAudit({
    projectId: asset.project_id,
    userId,
    assetId,
    action: 'DAST_DOMAIN_VERIFIED',
    decision: 'allow',
    reason: method,
  });
  return getAsset(userId, assetId);
}

export function isAssetVerified(asset: DastAssetRow): { ok: true } | { ok: false; code: string; error: string } {
  if (asset.status === 'REVOKED' || asset.revoked_at) {
    return { ok: false, code: 'DAST_VERIFICATION_REVOKED', error: USER_NOT_AUTHORIZED };
  }
  if (asset.status === 'PENDING') {
    return { ok: false, code: 'DAST_DOMAIN_NOT_VERIFIED', error: 'Ownership of this domain has not been verified for the selected project.' };
  }
  if (asset.status === 'EXPIRED' || (asset.expires_at && new Date(asset.expires_at).getTime() <= Date.now())) {
    return { ok: false, code: 'DAST_VERIFICATION_EXPIRED', error: USER_NOT_AUTHORIZED };
  }
  if (asset.status !== 'VERIFIED') {
    return { ok: false, code: 'DAST_TARGET_NOT_AUTHORIZED', error: USER_NOT_AUTHORIZED };
  }
  return { ok: true };
}

export async function resolveAuthorizedAsset(input: {
  userId: string;
  projectId: string;
  assetId?: string;
  targetUrl?: string;
}): Promise<{ asset: DastAssetRow; grant: ReturnType<typeof issueGrant>; targetUrl: string }> {
  let asset: DastAssetRow | null = null;
  let targetUrl = String(input.targetUrl || '').trim();

  if (input.assetId) {
    asset = await getAsset(input.userId, input.assetId);
    if (asset && asset.project_id !== input.projectId) asset = null;
  }

  if (!asset && targetUrl) {
    const parsed = parsePublicTarget(targetUrl);
    if (!parsed.ok) {
      throw Object.assign(new Error(parsed.error), { code: parsed.code, status: 400 });
    }
    const rows = await listAssets(input.userId, input.projectId);
    const verified = rows.filter((row) => isAssetVerified(row).ok);
    const hostMatches = verified.filter((row) => hostnameInScope(parsed.hostname, row.hostname, row.scope_mode));
    hostMatches.sort((a, b) => {
      if (a.scope_mode === b.scope_mode) return 0;
      return a.scope_mode === 'VERIFIED_HOST' ? -1 : 1;
    });
    asset = hostMatches[0] || null;
  }

  if (!asset) {
    throw Object.assign(new Error(USER_NOT_AUTHORIZED), { code: 'DAST_TARGET_NOT_AUTHORIZED', status: 403 });
  }

  const verified = isAssetVerified(asset);
  if (!verified.ok) {
    throw Object.assign(new Error(verified.error), { code: verified.code, status: 403 });
  }

  const parsed = parsePublicTarget(targetUrl || asset.normalized_url || asset.target_url);
  if (!parsed.ok) {
    throw Object.assign(new Error(parsed.error), { code: parsed.code, status: 400 });
  }
  if (!hostnameInScope(parsed.hostname, asset.hostname, asset.scope_mode)) {
    throw Object.assign(new Error(USER_NOT_AUTHORIZED), { code: 'DAST_TARGET_OUTSIDE_SCOPE', status: 403 });
  }

  const grant = issueGrant({
    assetId: asset.id,
    projectId: asset.project_id,
    hostname: asset.hostname,
    scopeMode: asset.scope_mode,
    verificationExpiresAt: iso(asset.expires_at) || new Date(Date.now() + 90 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    verificationMethod: asset.verification_method || undefined,
    scheme: asset.scheme,
  });

  return { asset, grant, targetUrl: parsed.url };
}

export async function createScanRecord(input: {
  userId: string;
  projectId: string;
  asset: DastAssetRow;
  targetUrl: string;
  profile: string;
  intent: string;
  idempotencyKey?: string;
}) {
  await ensureDastSchema();
  if (input.idempotencyKey) {
    const existing = await query<Array<{ id: string }>>(
      `SELECT id FROM dast_scans WHERE user_id = ? AND idempotency_key = ? LIMIT 1`,
      [input.userId, input.idempotencyKey],
    );
    if (existing[0]) return existing[0].id;
  }
  const id = randomUUID();
  await query(
    `INSERT INTO dast_scans (
      id, project_id, user_id, asset_id, target_url, scan_profile, scan_intent, status, idempotency_key, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, UTC_TIMESTAMP())`,
    [
      id,
      input.projectId,
      input.userId,
      input.asset.id,
      input.targetUrl,
      input.profile,
      input.intent,
      input.idempotencyKey || null,
    ],
  );
  await writeAudit({
    projectId: input.projectId,
    userId: input.userId,
    assetId: input.asset.id,
    scanId: id,
    action: 'DAST_SCAN_AUTHORIZED',
    decision: 'allow',
    reason: input.asset.scope_mode,
  });
  return id;
}

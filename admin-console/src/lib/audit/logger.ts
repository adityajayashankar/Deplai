import { createHmac } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { getAdminConfig } from '@/lib/config';
import { query } from '@/lib/db';

export type AuditInput = {
  actorAdminId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  sessionId?: string | null;
  success?: boolean;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
};

const SENSITIVE_KEY = /password|secret|token|hash|key|credential|authorization/i;

function redactValue(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = redactValue(entry);
    }
  }
  return output;
}

function canonicalEvent(input: AuditInput, previousHash: string): string {
  return JSON.stringify({
    previousHash,
    actorAdminId: input.actorAdminId || null,
    action: input.action,
    targetType: input.targetType || null,
    targetId: input.targetId || null,
    requestId: input.requestId || null,
    ip: input.ip || null,
    sessionId: input.sessionId || null,
    success: input.success !== false,
    reason: input.reason || null,
    before: redactValue(input.before ?? null),
    after: redactValue(input.after ?? null),
    metadata: redactValue(input.metadata ?? null),
  });
}

async function latestEventHash(): Promise<string> {
  const rows = await query<Array<{ event_hash: string }>>(
    `SELECT event_hash FROM admin_audit_logs ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  return rows[0]?.event_hash || 'GENESIS';
}

export async function writeAdminAuditLog(input: AuditInput): Promise<string> {
  const id = uuidv4();
  const previousHash = await latestEventHash();
  const canonical = canonicalEvent(input, previousHash);
  const eventHash = createHmac('sha256', getAdminConfig().auditHmacSecret)
    .update(canonical)
    .digest('hex');

  await query(
    `INSERT INTO admin_audit_logs
      (id, previous_hash, event_hash, actor_admin_id, action, target_type, target_id,
       request_id, ip, session_id, success, reason, before_json, after_json, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      previousHash,
      eventHash,
      input.actorAdminId || null,
      input.action.slice(0, 96),
      input.targetType?.slice(0, 64) || null,
      input.targetId?.slice(0, 64) || null,
      input.requestId?.slice(0, 64) || null,
      input.ip?.slice(0, 64) || null,
      input.sessionId?.slice(0, 36) || null,
      input.success === false ? 0 : 1,
      input.reason?.slice(0, 512) || null,
      input.before ? JSON.stringify(redactValue(input.before)) : null,
      input.after ? JSON.stringify(redactValue(input.after)) : null,
      input.metadata ? JSON.stringify(redactValue(input.metadata)) : null,
    ],
  );

  return id;
}

export async function recordSecurityEvent(input: {
  adminId?: string | null;
  eventType: string;
  ip?: string | null;
  metadata?: unknown;
}): Promise<void> {
  await query(
    `INSERT INTO admin_security_events (id, admin_id, event_type, ip, metadata_json)
     VALUES (?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      input.adminId || null,
      input.eventType.slice(0, 96),
      input.ip?.slice(0, 64) || null,
      input.metadata ? JSON.stringify(redactValue(input.metadata)) : null,
    ],
  );
}

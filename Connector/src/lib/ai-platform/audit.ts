import { randomUUID } from 'node:crypto';
import { query } from '@/lib/db';
import { ensureAiPlatformSchema } from './schema';
import { redactUnknown } from './redact';

export async function writeAudit(input: {
  userId: string;
  actor: string;
  action: string;
  resource: string;
  result: 'success' | 'failure';
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await ensureAiPlatformSchema();
    await query(
      `INSERT INTO ai_audit_events (id, user_id, actor, action, resource, result, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.userId,
        input.actor,
        input.action,
        input.resource,
        input.result,
        JSON.stringify(redactUnknown(input.metadata || {})),
      ],
    );
  } catch {
    /* audit must never break the request */
  }
}

export async function listAuditEvents(userId: string, limit = 100) {
  await ensureAiPlatformSchema();
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  try {
    return await query<Array<{
      id: string;
      actor: string;
      action: string;
      resource: string;
      result: string;
      metadata_json: unknown;
      created_at: Date | string;
    }>>(
      `SELECT id, actor, action, resource, result, metadata_json, created_at FROM ai_audit_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ${safeLimit}`,
      [userId],
    );
  } catch {
    return [];
  }
}

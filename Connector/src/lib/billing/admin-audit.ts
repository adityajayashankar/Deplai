import { v4 as uuidv4 } from 'uuid';
import { query } from '@/lib/db';
import { ensureFulfillmentSchema } from './fulfillment-schema';

export type AdminAuditLogRow = {
  id: string;
  actor: string;
  action: string;
  target: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  created_at: string;
};

function asIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function parseJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

export async function listAdminAuditLog(input: {
  action?: string;
  limit: number;
  offset: number;
}): Promise<{ events: AdminAuditLogRow[]; total: number; limit: number; offset: number }> {
  await ensureFulfillmentSchema();
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit) || 50));
  const offset = Math.max(0, Math.trunc(input.offset) || 0);
  const action = String(input.action || '').trim();
  const where = action ? 'WHERE action LIKE ?' : '';
  const params = action ? [`${action}%`] : [];
  try {
    const countRows = await query<Array<{ n: number | string }>>(
      `SELECT COUNT(*) AS n FROM admin_audit_log ${where}`,
      params,
    );
    const rows = await query<Array<{
      id: string;
      actor: string;
      action: string;
      target: string;
      before_json: unknown;
      after_json: unknown;
      reason: string | null;
      created_at: Date | string;
    }>>(
      `SELECT id, actor, action, target, before_json, after_json, reason, created_at
       FROM admin_audit_log
       ${where}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return {
      events: rows.map((row) => ({
        id: row.id,
        actor: row.actor,
        action: row.action,
        target: row.target,
        before: parseJson(row.before_json),
        after: parseJson(row.after_json),
        reason: row.reason,
        created_at: asIso(row.created_at) || '',
      })),
      total: Number(countRows[0]?.n || 0),
      limit,
      offset,
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_TABLE_ERROR') {
      return { events: [], total: 0, limit, offset };
    }
    throw error;
  }
}

export async function writeAdminAuditLog(input: {
  actor: string;
  action: string;
  target: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}): Promise<string> {
  await ensureFulfillmentSchema();
  const id = uuidv4();
  await query(
    `INSERT INTO admin_audit_log
      (id, actor, action, target, before_json, after_json, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.actor.slice(0, 255),
      input.action.slice(0, 64),
      input.target.slice(0, 191),
      input.before == null ? null : JSON.stringify(input.before),
      input.after == null ? null : JSON.stringify(input.after),
      input.reason || null,
    ],
  );
  return id;
}

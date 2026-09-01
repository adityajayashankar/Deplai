import { query } from '@/lib/db';

export async function listAuditLogs(input: { limit?: number; offset?: number; action?: string }) {
  const limit = Math.min(Math.max(input.limit || 50, 1), 100);
  const offset = Math.max(input.offset || 0, 0);
  const params: unknown[] = [];
  let where = '1=1';
  if (input.action?.trim()) {
    where += ' AND action LIKE ?';
    params.push(`%${input.action.trim()}%`);
  }

  const rows = await query<Array<{
    id: string;
    action: string;
    target_type: string | null;
    target_id: string | null;
    actor_admin_id: string | null;
    success: number;
    reason: string | null;
    created_at: Date | string;
  }>>(
    `SELECT id, action, target_type, target_id, actor_admin_id, success, reason, created_at
     FROM admin_audit_logs
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const countRows = await query<Array<{ total: number }>>(
    `SELECT COUNT(*) AS total FROM admin_audit_logs WHERE ${where}`,
    params,
  );

  return {
    total: Number(countRows[0]?.total || 0),
    events: rows.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      actorAdminId: row.actor_admin_id,
      success: Boolean(row.success),
      reason: row.reason,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

export async function listSecurityEvents(input: { limit?: number; offset?: number }) {
  const limit = Math.min(Math.max(input.limit || 50, 1), 100);
  const offset = Math.max(input.offset || 0, 0);
  const rows = await query<Array<{
    id: string;
    admin_id: string | null;
    event_type: string;
    ip: string | null;
    created_at: Date | string;
  }>>(
    `SELECT id, admin_id, event_type, ip, created_at
     FROM admin_security_events
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );

  return rows.map((row) => ({
    id: row.id,
    adminId: row.admin_id,
    eventType: row.event_type,
    ip: row.ip,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

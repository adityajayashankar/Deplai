import { NextRequest, NextResponse } from 'next/server';
import { isAdminUser, requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await params;
  const rows = await query<Array<{ id: string; user_id: string }>>(
    `SELECT id, user_id FROM dast_scans WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows[0] || (rows[0].user_id !== auth.user.id && !isAdminUser(auth.user))) {
    return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
  }
  const dbEvents = await query(
    `SELECT id, action, decision, reason, policy_version, created_at FROM dast_audit_events WHERE scan_id = ? ORDER BY created_at ASC`,
    [id],
  );
  let agentEvents: unknown[] = [];
  try {
    const response = await fetch(`${AGENTIC_URL}/api/dast/scans/${encodeURIComponent(id)}/audit`, {
      headers: agenticHeaders(),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const payload = await response.json() as { events?: unknown[] };
      agentEvents = Array.isArray(payload.events) ? payload.events : [];
    }
  } catch {
    agentEvents = [];
  }
  return NextResponse.json({ events: [...(Array.isArray(dbEvents) ? dbEvents : []), ...agentEvents] });
}

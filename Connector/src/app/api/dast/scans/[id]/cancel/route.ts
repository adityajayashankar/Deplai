import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await params;
  const rows = await query<Array<{ id: string }>>(
    `SELECT id FROM dast_scans WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, auth.user.id],
  );
  if (!rows[0]) return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
  await query(`UPDATE dast_scans SET status = 'cancelled', finished_at = UTC_TIMESTAMP() WHERE id = ?`, [id]);
  try {
    await fetch(`${AGENTIC_URL}/api/dast/scans/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: agenticHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ scan_id: id }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // Local cancel flag still recorded.
  }
  return NextResponse.json({ ok: true, scan_id: id, status: 'cancelled' });
}

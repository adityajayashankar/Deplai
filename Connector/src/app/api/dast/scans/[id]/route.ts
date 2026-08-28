import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await params;
  const rows = await query<Array<Record<string, unknown>>>(
    `SELECT * FROM dast_scans WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, auth.user.id],
  );
  if (!rows[0]) return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
  let checkpoint = null;
  try {
    const response = await fetch(`${AGENTIC_URL}/api/dast/scans/${encodeURIComponent(id)}`, {
      headers: agenticHeaders(),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) checkpoint = await response.json();
  } catch {
    checkpoint = null;
  }
  return NextResponse.json({ scan: rows[0], checkpoint });
}

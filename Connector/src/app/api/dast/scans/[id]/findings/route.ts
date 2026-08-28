import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await params;
  const rows = await query<Array<{ id: string; project_id: string }>>(
    `SELECT id, project_id FROM dast_scans WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, auth.user.id],
  );
  if (!rows[0]) return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
  const response = await fetch(`${AGENTIC_URL}/api/scan/results/${encodeURIComponent(String(rows[0].project_id))}`, {
    headers: agenticHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    return NextResponse.json({ findings: [] });
  }
  const payload = await response.json().catch(() => ({})) as { unified_findings?: Array<{ category?: string }> };
  const findings = Array.isArray(payload.unified_findings)
    ? payload.unified_findings.filter((item) => item.category === 'dast')
    : [];
  return NextResponse.json({ findings });
}

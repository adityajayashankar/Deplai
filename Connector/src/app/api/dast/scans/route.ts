import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { query } from '@/lib/db';
import { POST as authorize } from '../authorize/route';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const projectId = String(request.nextUrl.searchParams.get('project_id') || '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  const ownership = await verifyProjectOwnership(auth.user.id, projectId);
  if ('error' in ownership) return ownership.error;
  const scans = await query(
    `SELECT id, asset_id, target_url, scan_profile, scan_intent, status, compliance_status, finding_count, created_at, finished_at
     FROM dast_scans WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 50`,
    [auth.user.id, projectId],
  );
  return NextResponse.json({ scans });
}

export const POST = authorize;

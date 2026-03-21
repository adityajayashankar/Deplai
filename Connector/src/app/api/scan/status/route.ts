import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

export async function GET(request: NextRequest) {
  try {
    const { error, user } = await requireAuth();
    if (error) return error;

    const projectId = request.nextUrl.searchParams.get('project_id');
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const { error: ownershipError } = await verifyProjectOwnership(user!.id, projectId);
    if (ownershipError) return ownershipError;

    const response = await fetch(`${AGENTIC_URL}/api/scan/status/${projectId}`, {
      headers: agenticHeaders(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      // Log the failure so it's observable, but still return not_initiated
      // so the UI doesn't break. The scan completion poller in agent-chat
      // relies on this returning a valid status object.
      console.warn(`Scan status backend returned ${response.status} for ${projectId}`);
      return NextResponse.json({ status: 'not_initiated' });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: any) {
    console.error('Scan status error:', error);
    return NextResponse.json({ status: 'not_initiated' });
  }
}

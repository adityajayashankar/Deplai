import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { fetchAgenticLogs, getDeployment } from '@/lib/deploy-exec/store';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await params;
  const row = await getDeployment(auth.user.id, id);
  if (!row) return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
  try {
    const remote = await fetchAgenticLogs(id);
    return NextResponse.json({ deployment_id: id, logs: remote.logs || [] });
  } catch {
    return NextResponse.json({ deployment_id: id, logs: [] });
  }
}

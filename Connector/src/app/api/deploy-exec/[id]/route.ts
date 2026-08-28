import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { fetchAgentic, getDeployment, syncDeployment } from '@/lib/deploy-exec/store';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await params;
  const row = await getDeployment(auth.user.id, id);
  if (!row) return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
  let remote: Record<string, unknown> = {};
  try {
    remote = await fetchAgentic(id);
    await syncDeployment(id, remote);
  } catch {
    remote = {};
  }
  return NextResponse.json({
    deployment: { ...row, ...remote, deployment_id: id },
    result: remote.result || row.result_class,
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getDeployment, postAgentic, syncDeployment } from '@/lib/deploy-exec/store';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await params;
  const row = await getDeployment(auth.user.id, id);
  if (!row) return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
  const body = await request.json().catch(() => ({})) as Record<string, string>;
  const remote = await postAgentic(id, 'cancel', body);
  await syncDeployment(id, remote);
  return NextResponse.json(remote);
}

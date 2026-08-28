import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { publicAsset, verifyAsset } from '@/lib/dast/store';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { method?: string };
  const method = String(body.method || 'DNS_TXT').toUpperCase();
  if (method !== 'DNS_TXT' && method !== 'HTTP') {
    return NextResponse.json({ error: 'method must be DNS_TXT or HTTP' }, { status: 400 });
  }
  try {
    const asset = await verifyAsset(auth.user.id, id, method);
    if (!asset) return NextResponse.json({ error: 'Target not found' }, { status: 404 });
    return NextResponse.json({ asset: publicAsset(asset) });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const status = Number((error as { status?: number }).status || 400);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Verification failed', code }, { status });
  }
}

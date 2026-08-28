import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { publicAsset, revokeAsset } from '@/lib/dast/store';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const { id } = await params;
  const asset = await revokeAsset(auth.user.id, id);
  if (!asset) return NextResponse.json({ error: 'Target not found' }, { status: 404 });
  return NextResponse.json({ asset: publicAsset(asset) });
}

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { listAdminAuditLog } from '@/lib/billing/admin-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const params = request.nextUrl.searchParams;
  try {
    const result = await listAdminAuditLog({
      action: params.get('action') || '',
      limit: Number(params.get('limit') || 50),
      offset: Number(params.get('offset') || 0),
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load admin audit log';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

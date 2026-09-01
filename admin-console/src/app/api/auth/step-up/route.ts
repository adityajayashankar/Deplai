import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/auth/password';
import { getAdminById } from '@/lib/admin/accounts';
import { readSessionToken, requireAdminApi } from '@/lib/http/request-context';
import { getSessionByToken, grantStepUp } from '@/lib/auth/sessions';
import { writeAdminAuditLog } from '@/lib/audit/logger';
import type { StepUpScope } from '@/lib/authorization/permissions';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await requireAdminApi(request, { requireMfa: true });
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => ({})) as { password?: string; scope?: StepUpScope };
  const password = String(body.password || '');
  const scope = body.scope;
  if (!password || !scope) {
    return NextResponse.json({ error: 'Password and scope are required' }, { status: 400 });
  }

  const admin = await getAdminById(auth.context.session.adminId);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const adminWithHash = await import('@/lib/admin/accounts').then((m) => m.getAdminByEmail(admin.email));
  if (!adminWithHash) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const valid = await verifyPassword(password, adminWithHash.passwordHash);
  if (!valid) {
    await writeAdminAuditLog({
      actorAdminId: admin.id,
      action: 'ADMIN_STEP_UP_FAILURE',
      ip: auth.context.ip,
      metadata: { scope },
      success: false,
    });
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  const expiresAt = await grantStepUp(auth.context.session.id, admin.id, scope);
  await writeAdminAuditLog({
    actorAdminId: admin.id,
    action: 'ADMIN_STEP_UP_SUCCESS',
    ip: auth.context.ip,
    metadata: { scope },
    success: true,
  });

  return NextResponse.json({ elevated: true, expiresAt: expiresAt.toISOString(), scope });
}

export async function GET(request: NextRequest) {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return NextResponse.json({ authenticated: false });
  const session = await getSessionByToken(sessionToken);
  if (!session) return NextResponse.json({ authenticated: false });
  return NextResponse.json({
    authenticated: true,
    mfaVerified: session.mfaVerified,
    email: session.email,
    role: session.role,
  });
}

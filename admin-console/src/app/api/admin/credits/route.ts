import { NextRequest, NextResponse } from 'next/server';
import { writeAdminAuditLog } from '@/lib/audit/logger';
import { requireAdminApi } from '@/lib/http/request-context';
import {
  debitOrganizationCredits,
  getOrganizationCreditBalance,
  grantOrganizationCredits,
  setOrganizationWalletStatus,
} from '@/lib/platform/credits';
import { resolveOrganizationId } from '@/lib/platform/organizations-admin';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAdminApi(request, { permission: 'ADMIN_BILLING_READ' });
  if ('error' in auth) return auth.error;

  const organizationId = request.nextUrl.searchParams.get('organizationId');
  if (!organizationId) {
    return NextResponse.json({ error: 'organizationId is required' }, { status: 400 });
  }

  const balance = await getOrganizationCreditBalance(organizationId);
  return NextResponse.json({
    organizationId,
    available: Number(balance.availableUnits) / 1_000_000,
    reserved: Number(balance.reservedUnits) / 1_000_000,
    balance: Number(balance.balanceUnits) / 1_000_000,
    status: balance.status,
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminApi(request, { permission: 'ADMIN_BILLING_WRITE', stepUp: 'credits.adjust' });
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => ({})) as {
    action?: 'grant' | 'debit' | 'freeze' | 'unfreeze';
    organizationId?: string;
    userId?: string;
    credits?: number;
    reason?: string;
  };

  const action = body.action;
  const reason = String(body.reason || '').trim();
  if (!action || !reason) {
    return NextResponse.json({ error: 'action and reason are required' }, { status: 400 });
  }

  try {
    const organizationId = await resolveOrganizationId({
      organizationId: body.organizationId,
      userId: body.userId,
    });

    if (action === 'freeze' || action === 'unfreeze') {
      const balance = await setOrganizationWalletStatus(organizationId, action === 'freeze' ? 'FROZEN' : 'ACTIVE');
      await writeAdminAuditLog({
        actorAdminId: auth.context.session.adminId,
        action: action === 'freeze' ? 'CREDIT_WALLET_FROZEN' : 'CREDIT_WALLET_UNFROZEN',
        targetType: 'organization',
        targetId: organizationId,
        ip: auth.context.ip,
        sessionId: auth.context.session.id,
        reason,
      });
      return NextResponse.json({
        organizationId,
        status: balance.status,
        available: Number(balance.availableUnits) / 1_000_000,
      });
    }

    const credits = Number(body.credits);
    if (!Number.isFinite(credits) || credits <= 0) {
      return NextResponse.json({ error: 'credits must be a positive number' }, { status: 400 });
    }

    if (action === 'grant') {
      const result = await grantOrganizationCredits({
        organizationId,
        userId: body.userId || null,
        credits,
        sourceType: 'admin',
        sourceId: reason,
        idempotencyKey: `admin-console:${auth.context.session.id}:${Date.now()}:${credits}`,
      });
      await writeAdminAuditLog({
        actorAdminId: auth.context.session.adminId,
        action: 'CREDIT_ADJUSTED',
        targetType: 'organization',
        targetId: organizationId,
        ip: auth.context.ip,
        sessionId: auth.context.session.id,
        reason,
        after: { credits, direction: 'grant', grantId: result.grantId },
      });
      return NextResponse.json({
        organizationId,
        grantId: result.grantId,
        available: Number(result.balance.availableUnits) / 1_000_000,
      });
    }

    if (action === 'debit') {
      const result = await debitOrganizationCredits({
        organizationId,
        userId: body.userId || null,
        credits,
        source: 'admin_console',
        idempotencyKey: `admin-console-debit:${auth.context.session.id}:${Date.now()}:${credits}`,
      });
      await writeAdminAuditLog({
        actorAdminId: auth.context.session.adminId,
        action: 'CREDIT_ADJUSTED',
        targetType: 'organization',
        targetId: organizationId,
        ip: auth.context.ip,
        sessionId: auth.context.session.id,
        reason,
        after: { credits, direction: 'debit', ...result },
      });
      return NextResponse.json({ organizationId, ...result });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Credit operation failed' },
      { status: 400 },
    );
  }
}

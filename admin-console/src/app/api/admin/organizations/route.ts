import { NextRequest, NextResponse } from 'next/server';
import { writeAdminAuditLog } from '@/lib/audit/logger';
import { requireAdminApi } from '@/lib/http/request-context';
import { listOrganizations } from '@/lib/platform/organizations';
import { setComplimentaryAccess } from '@/lib/platform/complimentary';
import {
  getOrganizationDetail,
  setOrganizationStatus,
} from '@/lib/platform/organizations-admin';
import {
  cancelOrganizationSubscription,
  updateOrganizationSubscription,
} from '@/lib/platform/subscriptions';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await requireAdminApi(request, { permission: 'ADMIN_ORG_READ' });
  if ('error' in auth) return auth.error;

  const url = request.nextUrl;
  const organizationId = url.searchParams.get('id');
  if (organizationId) {
    const organization = await getOrganizationDetail(organizationId);
    if (!organization) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    return NextResponse.json({ organization });
  }

  const result = await listOrganizations({
    search: url.searchParams.get('q') || undefined,
    limit: Number(url.searchParams.get('limit') || 50),
    offset: Number(url.searchParams.get('offset') || 0),
  });
  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminApi(request, { permission: 'ADMIN_ORG_WRITE' });
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => ({})) as {
    organizationId?: string;
    action?: string;
    reason?: string;
    planId?: string;
    expiresAt?: string | null;
    cadence?: 'monthly' | 'yearly';
    stepUpScope?: 'org.destructive' | 'subscription.cancel';
  };

  const organizationId = String(body.organizationId || '');
  const action = String(body.action || '');
  const reason = String(body.reason || '').trim();
  if (!organizationId || !action || !reason) {
    return NextResponse.json({ error: 'organizationId, action, and reason are required' }, { status: 400 });
  }

  const needsStepUp = action === 'suspend' || action === 'cancel_subscription';
  if (needsStepUp) {
    const stepUpAuth = await requireAdminApi(request, {
      permission: action === 'cancel_subscription' ? 'ADMIN_BILLING_WRITE' : 'ADMIN_ORG_WRITE',
      stepUp: action === 'cancel_subscription' ? 'subscription.cancel' : 'org.destructive',
    });
    if ('error' in stepUpAuth) return stepUpAuth.error;
  }

  try {
    if (action === 'grant_access' || action === 'revoke_access') {
      const elevated = await requireAdminApi(request, { permission: 'ADMIN_BILLING_WRITE', stepUp: 'subscription.grant' });
      if ('error' in elevated) return elevated.error;
      await setComplimentaryAccess({ organizationId, revoke: action === 'revoke_access', planId: body.planId, expiresAt: body.expiresAt }, {
        action: '', actorAdminId: auth.context.session.adminId, sessionId: auth.context.session.id, ip: auth.context.ip, reason,
      });
      return NextResponse.json({ organizationId, updated: true });
    }
    if (action === 'suspend') {
      await setOrganizationStatus(organizationId, 'SUSPENDED');
      await writeAdminAuditLog({
        actorAdminId: auth.context.session.adminId,
        action: 'ORGANIZATION_SUSPENDED',
        targetType: 'organization',
        targetId: organizationId,
        ip: auth.context.ip,
        sessionId: auth.context.session.id,
        reason,
      });
      return NextResponse.json({ organizationId, status: 'SUSPENDED' });
    }

    if (action === 'activate') {
      await setOrganizationStatus(organizationId, 'ACTIVE');
      await writeAdminAuditLog({
        actorAdminId: auth.context.session.adminId,
        action: 'ORGANIZATION_ACTIVATED',
        targetType: 'organization',
        targetId: organizationId,
        ip: auth.context.ip,
        sessionId: auth.context.session.id,
        reason,
      });
      return NextResponse.json({ organizationId, status: 'ACTIVE' });
    }

    if (action === 'change_plan') {
      const elevated = await requireAdminApi(request, { permission: 'ADMIN_BILLING_WRITE', stepUp: 'subscription.grant' });
      if ('error' in elevated) return elevated.error;
      if (!body.planId) return NextResponse.json({ error: 'planId is required' }, { status: 400 });
      await updateOrganizationSubscription({
        organizationId,
        planId: body.planId,
        cadence: body.cadence,
      });
      await writeAdminAuditLog({
        actorAdminId: auth.context.session.adminId,
        action: 'SUBSCRIPTION_CHANGED',
        targetType: 'organization',
        targetId: organizationId,
        ip: auth.context.ip,
        sessionId: auth.context.session.id,
        reason,
        after: { planId: body.planId, cadence: body.cadence || null },
      });
      return NextResponse.json({ organizationId, planId: body.planId });
    }

    if (action === 'cancel_subscription') {
      await cancelOrganizationSubscription(organizationId);
      await writeAdminAuditLog({
        actorAdminId: auth.context.session.adminId,
        action: 'SUBSCRIPTION_CANCELLED',
        targetType: 'organization',
        targetId: organizationId,
        ip: auth.context.ip,
        sessionId: auth.context.session.id,
        reason,
      });
      return NextResponse.json({ organizationId, subscriptionStatus: 'cancelled' });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Organization action failed' },
      { status: 400 },
    );
  }
}

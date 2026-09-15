'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch, confirmStepUp } from '@/lib/admin-api';
import { BILLING_PLANS } from '@/lib/platform/credit-catalog';
import { formatDate } from '@/lib/utils';

type OrganizationDetail = {
  complimentary: { planId: string; expiresAt: string | null; active: boolean } | null;
  id: string;
  name: string;
  slug: string;
  status: string;
  ownerEmail: string | null;
  ownerUserId: string;
  memberCount: number;
  projectCount: number;
  createdAt: string;
  credits: {
    available: number;
    reserved: number;
    balance: number;
    status: string;
  } | null;
  subscription: {
    planId: string;
    planName: string | null;
    status: string;
    cadence: string | null;
    userEmail: string | null;
  } | null;
};

export default function OrganizationDetailPage() {
  const params = useParams<{ id: string }>();
  const [org, setOrg] = useState<OrganizationDetail | null>(null);
  const [reason, setReason] = useState('');
  const [credits, setCredits] = useState('10');
  const [planId, setPlanId] = useState('free');
  const [grantPlanId, setGrantPlanId] = useState('starter_20');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');
  const [loadError, setLoadError] = useState('');

  async function load() {
    const data = await adminFetch<{ organization: OrganizationDetail }>(`/api/admin/organizations?id=${params.id}`);
    setOrg(data.organization);
    setPlanId(data.organization.subscription?.planId || 'free');
    setGrantPlanId(data.organization.complimentary?.active ? data.organization.complimentary.planId : 'starter_20');
  }

  useEffect(() => {
    load().catch((error) => setLoadError(error instanceof Error ? error.message : 'Could not load organization'));
  }, [params.id]);

  async function runAction(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await action();
      await load();
      setMessage('Action completed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  async function postOrg(body: Record<string, unknown>, stepUp?: Parameters<typeof confirmStepUp>[0]) {
    if (!reason.trim()) throw new Error('Reason is required');
    if (stepUp) await confirmStepUp(stepUp);
    await adminFetch('/api/admin/organizations', {
      method: 'POST',
      body: JSON.stringify({ organizationId: params.id, reason, ...body }),
    });
  }

  async function postCredits(body: Record<string, unknown>) {
    if (!reason.trim()) throw new Error('Reason is required');
    await confirmStepUp('credits.adjust');
    await adminFetch('/api/admin/credits', {
      method: 'POST',
      body: JSON.stringify({ organizationId: params.id, reason, ...body }),
    });
  }

  if (!org) return <div role="status">{loadError || 'Loading organization...'}</div>;

  return (
    <div className="space-y-6">
      <Link href="/organizations" className="text-sm text-accent hover:underline">← Back to organizations</Link>
      <PageHeader title={org.name} description={`Organizations / ${org.slug}`} />

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-4 space-y-2">
          <h2 className="font-medium">Organization</h2>
          <p>Status: {org.status}</p>
          <p>Owner: {org.ownerEmail || org.ownerUserId}</p>
          <p>Members: {org.memberCount}</p>
          <p>Projects: {org.projectCount}</p>
          <p>Created: {formatDate(org.createdAt)}</p>
        </section>
        <section className="card p-4 space-y-2">
          <h2 className="font-medium">Credits</h2>
          {org.credits ? (
            <>
              <p>Available: {org.credits.available.toFixed(2)}</p>
              <p>Reserved: {org.credits.reserved.toFixed(2)}</p>
              <p>Balance: {org.credits.balance.toFixed(2)}</p>
              <p>Wallet status: {org.credits.status}</p>
            </>
          ) : (
            <p className="text-muted">No credit wallet found.</p>
          )}
        </section>
      </div>

      <section className="card p-4 space-y-2">
        <h2 className="font-medium">Subscription</h2>
        {org.subscription ? (
          <>
            <p>Plan: {org.subscription.planName || org.subscription.planId}</p>
            <p>Status: {org.subscription.status}</p>
            <p>Cadence: {org.subscription.cadence || '—'}</p>
            <p>Billing user: {org.subscription.userEmail || '—'}</p>
          </>
        ) : (
          <p className="text-muted">No subscription on file.</p>
        )}
      </section>

      <fieldset disabled={busy} className="card p-4 space-y-4">
        <h2 className="font-medium">Resource controls</h2>
        <input
          className="input"
          placeholder="Reason for this action (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted">Credits</h3>
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={credits}
              onChange={(e) => setCredits(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <button
                className="btn btn-outline"
                type="button"
                onClick={() => runAction(() => postCredits({ action: 'grant', credits: Number(credits) }))}
              >
                Grant credits
              </button>
              <button
                className="btn btn-outline"
                type="button"
                onClick={() => runAction(() => postCredits({ action: 'debit', credits: Number(credits) }))}
              >
                Debit credits
              </button>
              <button
                className="btn btn-outline"
                type="button"
                onClick={() => runAction(() => postCredits({ action: 'freeze' }))}
              >
                Freeze wallet
              </button>
              <button
                className="btn btn-outline"
                type="button"
                onClick={() => runAction(() => postCredits({ action: 'unfreeze' }))}
              >
                Unfreeze wallet
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted">Organization & subscription</h3>
            <div className="flex flex-wrap gap-2">
              {org.status === 'ACTIVE' ? (
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => runAction(() => postOrg({ action: 'suspend' }, 'org.destructive'))}
                >
                  Suspend organization
                </button>
              ) : (
                <button
                  className="btn btn-outline"
                  type="button"
                  onClick={() => runAction(() => postOrg({ action: 'activate' }))}
                >
                  Reactivate organization
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select className="input max-w-xs" value={planId} onChange={(e) => setPlanId(e.target.value)}>
                {BILLING_PLANS.map((plan) => (
                  <option key={plan.id} value={plan.id}>{plan.displayName}</option>
                ))}
              </select>
              <button
                className="btn btn-outline"
                type="button"
                onClick={() => runAction(() => postOrg({ action: 'change_plan', planId }, 'subscription.grant'))}
              >
                Change recorded billing plan
              </button>
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => runAction(() => postOrg({ action: 'cancel_subscription' }, 'subscription.cancel'))}
              >
                Set recorded subscription to Free
              </button>
            </div>
            <p className="text-sm text-muted">Recorded billing changes do not cancel charges at the payment provider. Use complimentary access below for free tier grants.</p>
          </div>
        </div>

        <div className="space-y-3 border-t pt-4">
          <h3 className="font-medium">Complimentary tier access</h3>
          <label className="block">Tier to grant
            <select className="input max-w-xs" value={grantPlanId} onChange={(e) => setGrantPlanId(e.target.value)}>
              {BILLING_PLANS.map((plan) => <option key={plan.id} value={plan.id}>{plan.displayName}</option>)}
            </select>
          </label>
          <p className="text-sm text-muted">Applies to all members of this organization. No payment is required. Usage still consumes credits; use Grant credits above to fund access. Existing paid billing is not cancelled.</p>
          <p>{org.complimentary?.active ? `Active: ${org.complimentary.planId}, expires ${org.complimentary.expiresAt ? formatDate(org.complimentary.expiresAt) : 'never'}` : 'No active complimentary access'}</p>
          <label className="block">Expiry (optional, your local time)
            <input className="input" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
          <p className="text-sm">Selected tier: {BILLING_PLANS.find((plan) => plan.id === grantPlanId)?.displayName}. Revocation or expiry restores the underlying subscription.</p>
          {!reason.trim() ? <p className="text-sm text-muted">Enter a reason at the top of Resource controls to enable the grant button.</p> : null}
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={!reason.trim()} onClick={() => runAction(() => postOrg({ action: 'grant_access', planId: grantPlanId, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null }, 'subscription.grant'))}>Grant selected tier without payment</button>
            <button className="btn btn-danger" disabled={!org.complimentary?.active || !reason.trim()} onClick={() => runAction(() => postOrg({ action: 'revoke_access' }, 'subscription.grant'))}>Revoke complimentary access</button>
          </div>
        </div>
        {message ? <p role="status" className="text-sm text-muted">{message}</p> : null}
      </fieldset>
    </div>
  );
}

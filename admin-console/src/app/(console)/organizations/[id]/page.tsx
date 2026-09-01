'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/PageHeader';
import { adminFetch, confirmStepUp } from '@/lib/admin-api';
import { BILLING_PLANS } from '@/lib/platform/credit-catalog';
import { formatDate } from '@/lib/utils';

type OrganizationDetail = {
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
  const [message, setMessage] = useState('');

  async function load() {
    const data = await adminFetch<{ organization: OrganizationDetail }>(`/api/admin/organizations?id=${params.id}`);
    setOrg(data.organization);
    setPlanId(data.organization.subscription?.planId || 'free');
  }

  useEffect(() => {
    load().catch(() => setOrg(null));
  }, [params.id]);

  async function runAction(action: () => Promise<void>) {
    setMessage('');
    try {
      await action();
      await load();
      setMessage('Action completed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Action failed');
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

  if (!org) return <div className="text-muted">Loading organization...</div>;

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

      <section className="card p-4 space-y-4">
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
                onClick={() => runAction(() => postOrg({ action: 'change_plan', planId }))}
              >
                Change plan
              </button>
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => runAction(() => postOrg({ action: 'cancel_subscription' }, 'subscription.cancel'))}
              >
                Cancel subscription
              </button>
            </div>
          </div>
        </div>

        {message ? <p className="text-sm text-muted">{message}</p> : null}
      </section>
    </div>
  );
}

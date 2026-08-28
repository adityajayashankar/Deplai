'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  Copy,
  CreditCard,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import IntegrationsApp from '@/features/dashboard/IntegrationsApp';
import { useRazorpayCheckout, type RazorpayCheckoutPayload } from '@/features/billing/useRazorpayCheckout';
import { LOGIN_HREF } from '@/lib/auth-providers';
import {
  MAX_CUSTOM_CREDIT_USD,
  MAX_EFFICIENT_POOL,
  MIN_CUSTOM_CREDIT_USD,
  ROUTING_MODES,
  creditTone,
  displaySocial,
  formatCreditUsd,
  initialsFromName,
  routingModeById,
  validateCustomCreditUsd,
  validateProfilePatch,
  validatePromoCode,
  type EfficientPoolEntry,
  type RoutingModeId,
} from '@/lib/profile/logic';
import {
  Dialog,
  Field,
  InlineError,
  PrimaryButton,
  ProfileCard,
  Segmented,
  Skeleton,
  ToastStack,
  Toggle,
  focusRing,
  inputClass,
  type ToastTone,
} from './ui';

type ProfilePayload = {
  profile: {
    displayName: string;
    email: string;
    avatarUrl: string;
    linkedinUrl: string;
    githubUrl: string;
    referralCode: string;
  };
  credits: {
    total: number;
    paid_remaining: number;
    bonus_remaining: number;
    bonus_unlocked: boolean;
    plan_id?: string;
    plan_name?: string;
  } | null;
  subscription: { planId: string; status: string; cadence: string } | null;
  routing: { mode: RoutingModeId; efficientPool: EfficientPoolEntry[] };
  autoTopup: {
    enabled: boolean;
    thresholdUsd: number;
    addUsd: number;
    paymentMethodLast4: string;
  };
  apiToken: { configured: boolean; masked: string; lastUsedAt: string | null; lastUsedClient: string | null };
};

type Plan = {
  id: string;
  displayName: string;
  description: string;
  priceCents: number;
  yearlyPriceCents: number;
  paidCreditAmount: number;
  bonusCreditPercent: number;
  isCustom: boolean;
  isRecommended: boolean;
  features: string[];
};

type CatalogModel = { id: string; displayName: string; providerId: string; variant: string; family: string };

function useToasts() {
  const [toasts, setToasts] = useState<Array<{ id: string; message: string; tone: ToastTone }>>([]);
  const push = useCallback((message: string, tone: ToastTone) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current.slice(-4), { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200);
  }, []);
  return { toasts, push, dismiss: (id: string) => setToasts((current) => current.filter((item) => item.id !== id)) };
}

export default function ProfileApp() {
  const router = useRouter();
  const { start } = useRazorpayCheckout();
  const toasts = useToasts();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [bundle, setBundle] = useState<ProfilePayload | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [salesEmail, setSalesEmail] = useState('founders@deplai.tech');
  const [razorpayConfigured, setRazorpayConfigured] = useState(false);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [yearly, setYearly] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState({ displayName: '', email: '', linkedinUrl: '', githubUrl: '' });
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [editSaving, setEditSaving] = useState(false);
  const [editBaseline, setEditBaseline] = useState('');

  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null);
  const [selectedCredit, setSelectedCredit] = useState<string>('20');
  const [customOpen, setCustomOpen] = useState(false);
  const [customAmount, setCustomAmount] = useState('25');
  const [customError, setCustomError] = useState('');

  const [topupOpen, setTopupOpen] = useState(false);
  const [topupDraft, setTopupDraft] = useState({ enabled: false, thresholdUsd: 5, addUsd: 20 });
  const [topupSaving, setTopupSaving] = useState(false);

  const [routingMode, setRoutingMode] = useState<RoutingModeId>('default');
  const [pool, setPool] = useState<EfficientPoolEntry[]>([]);
  const [routingSaving, setRoutingSaving] = useState(false);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [selectedVariant, setSelectedVariant] = useState('default');

  const [promo, setPromo] = useState('');
  const [promoError, setPromoError] = useState('');
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoSuccess, setPromoSuccess] = useState('');

  const [tokenVisible, setTokenVisible] = useState(false);
  const [tokenValue, setTokenValue] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    const [profileRes, plansRes, routingRes] = await Promise.all([
      fetch('/api/profile', { cache: 'no-store' }),
      fetch('/api/billing/plans', { cache: 'no-store' }),
      fetch('/api/profile/routing', { cache: 'no-store' }),
    ]);
    if (profileRes.status === 401) {
      router.push(LOGIN_HREF);
      return;
    }
    if (!profileRes.ok) throw new Error('Unable to load profile.');
    const profilePayload = await profileRes.json() as ProfilePayload;
    setBundle(profilePayload);
    setRoutingMode(profilePayload.routing.mode);
    setPool(profilePayload.routing.efficientPool);
    setTopupDraft({
      enabled: profilePayload.autoTopup.enabled,
      thresholdUsd: profilePayload.autoTopup.thresholdUsd,
      addUsd: profilePayload.autoTopup.addUsd,
    });
    setYearly(profilePayload.subscription?.cadence === 'yearly');
    if (plansRes.ok) {
      const payload = await plansRes.json() as { plans?: Plan[]; salesEmail?: string; razorpayConfigured?: boolean };
      setPlans(Array.isArray(payload.plans) ? payload.plans : []);
      if (payload.salesEmail) setSalesEmail(payload.salesEmail);
      setRazorpayConfigured(Boolean(payload.razorpayConfigured));
    }
    if (routingRes.ok) {
      const payload = await routingRes.json() as { models?: CatalogModel[] };
      setModels(Array.isArray(payload.models) ? payload.models : []);
    }
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      setLoading(true);
      try {
        await load();
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Unable to load profile.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const maxBonus = useMemo(
    () => Math.max(0, ...plans.map((plan) => plan.bonusCreditPercent || 0)),
    [plans],
  );
  const routingDirty = useMemo(() => {
    if (!bundle) return false;
    return routingMode !== bundle.routing.mode || JSON.stringify(pool) !== JSON.stringify(bundle.routing.efficientPool);
  }, [bundle, pool, routingMode]);
  const referralUrl = bundle ? `${typeof window === 'undefined' ? '' : window.location.origin}/auth/signup?ref=${bundle.profile.referralCode}` : '';
  const creditStatus = creditTone(bundle?.credits?.total ?? 0);

  const openEdit = () => {
    if (!bundle) return;
    const draft = {
      displayName: bundle.profile.displayName,
      email: bundle.profile.email,
      linkedinUrl: bundle.profile.linkedinUrl,
      githubUrl: bundle.profile.githubUrl,
    };
    setEditDraft(draft);
    setEditErrors({});
    setEditBaseline(JSON.stringify(draft));
    setEditOpen(true);
  };

  const editDirty = JSON.stringify(editDraft) !== editBaseline;
  const closeEdit = () => {
    if (editDirty && !window.confirm('Discard unsaved profile changes?')) return;
    setEditOpen(false);
  };

  const saveProfile = async () => {
    const validated = validateProfilePatch(editDraft);
    if (!validated.ok) {
      setEditErrors(validated.errors);
      return;
    }
    setEditSaving(true);
    try {
      const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validated.value),
      });
      const payload = await response.json() as { profile?: ProfilePayload['profile']; error?: string; details?: Record<string, string> };
      if (!response.ok) {
        setEditErrors(payload.details || { form: payload.error || 'Unable to save profile' });
        toasts.push('Unable to save profile', 'error');
        return;
      }
      if (payload.profile) {
        setBundle((current) => (current ? { ...current, profile: { ...current.profile, ...payload.profile } } : current));
      }
      setEditOpen(false);
      toasts.push('Profile updated', 'success');
    } finally {
      setEditSaving(false);
    }
  };

  const startCheckout = async (plan: Plan) => {
    if (plan.isCustom) {
      window.location.href = `mailto:${salesEmail}`;
      return;
    }
    if (plan.id === 'free') return;
    setCheckoutBusy(plan.id);
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: plan.id, cadence: yearly ? 'yearly' : 'monthly' }),
      });
      const payload = await response.json() as RazorpayCheckoutPayload & { error?: string };
      if (!response.ok) {
        toasts.push(payload.error || 'Payment failed', 'error');
        return;
      }
      const result = await start(payload);
      if (result.status === 'cancelled') return;
      if (result.status === 'failed') {
        toasts.push(result.message || 'Payment failed', 'error');
        return;
      }
      await load();
      toasts.push('Credits purchased', 'success');
    } finally {
      setCheckoutBusy(null);
    }
  };

  const buyCredits = async (usd: number) => {
    const parsed = validateCustomCreditUsd(usd);
    if (!parsed.ok) {
      setCustomError(parsed.error);
      toasts.push(parsed.error, 'error');
      return;
    }
    setCheckoutBusy(`credits-${usd}`);
    setCustomError('');
    try {
      const response = await fetch('/api/billing/credits/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_usd: parsed.amount }),
      });
      const payload = await response.json() as RazorpayCheckoutPayload & { error?: string };
      if (!response.ok) {
        toasts.push(payload.error || 'Payment failed', 'error');
        return;
      }
      const result = await start(payload);
      if (result.status === 'cancelled') return;
      if (result.status === 'failed') {
        toasts.push(result.message || 'Payment failed', 'error');
        return;
      }
      setCustomOpen(false);
      await load();
      toasts.push('Credits purchased', 'success');
    } finally {
      setCheckoutBusy(null);
    }
  };

  const saveTopup = async () => {
    setTopupSaving(true);
    try {
      const response = await fetch('/api/billing/auto-topup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(topupDraft),
      });
      const payload = await response.json() as { autoTopup?: ProfilePayload['autoTopup']; error?: string };
      if (!response.ok) {
        toasts.push(payload.error || 'Unable to save automatic top-up', 'error');
        return;
      }
      if (payload.autoTopup) {
        setBundle((current) => (current ? { ...current, autoTopup: payload.autoTopup! } : current));
      }
      setTopupOpen(false);
      toasts.push('Automatic top-up saved', 'success');
    } finally {
      setTopupSaving(false);
    }
  };

  const saveRouting = async () => {
    setRoutingSaving(true);
    try {
      const response = await fetch('/api/profile/routing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: routingMode, efficientPool: pool }),
      });
      const payload = await response.json() as { routing?: ProfilePayload['routing']; error?: string };
      if (!response.ok) {
        toasts.push(payload.error || 'Unable to save routing configuration', 'error');
        return;
      }
      if (payload.routing) {
        setBundle((current) => (current ? { ...current, routing: payload.routing! } : current));
        setPool(payload.routing.efficientPool);
        setRoutingMode(payload.routing.mode);
      }
      toasts.push('Auto routing saved', 'success');
    } finally {
      setRoutingSaving(false);
    }
  };

  const redeemPromo = async () => {
    const parsed = validatePromoCode(promo);
    if (!parsed.ok) {
      setPromoError(parsed.error);
      setPromoSuccess('');
      return;
    }
    setPromoBusy(true);
    setPromoError('');
    setPromoSuccess('');
    try {
      const response = await fetch('/api/billing/promo/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: parsed.code }),
      });
      const payload = await response.json() as { creditAmount?: number; error?: string; code?: string };
      if (!response.ok) {
        setPromoError(payload.error || 'Unable to redeem promotional code');
        toasts.push(payload.error || 'Unable to redeem promotional code', 'error');
        return;
      }
      setPromo('');
      setPromoSuccess(`Added ${payload.creditAmount} credits.`);
      await load();
      toasts.push('Promotional code redeemed', 'success');
    } finally {
      setPromoBusy(false);
    }
  };

  const copyToken = async () => {
    let value = tokenValue;
    if (!value) {
      const response = await fetch('/api/profile/api-token?reveal=1', { cache: 'no-store' });
      const payload = await response.json() as { token?: string; error?: string };
      if (!response.ok || !payload.token) {
        toasts.push(payload.error || 'Unable to copy API key', 'error');
        return;
      }
      value = payload.token;
      setTokenValue(value);
    }
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
    toasts.push('API key copied', 'success');
  };

  const showToken = async () => {
    if (tokenVisible) {
      setTokenVisible(false);
      return;
    }
    setTokenBusy(true);
    try {
      const response = await fetch('/api/profile/api-token?reveal=1', { cache: 'no-store' });
      const payload = await response.json() as { token?: string; error?: string };
      if (!response.ok || !payload.token) {
        toasts.push(payload.error || 'Issue an API token first.', 'error');
        return;
      }
      setTokenValue(payload.token);
      setTokenVisible(true);
      window.setTimeout(() => setTokenVisible(false), 12_000);
    } finally {
      setTokenBusy(false);
    }
  };

  const resetToken = async () => {
    setTokenBusy(true);
    try {
      const response = await fetch('/api/profile/api-token', { method: 'POST' });
      const payload = await response.json() as { token?: string; masked?: string; error?: string };
      if (!response.ok || !payload.token) {
        toasts.push(payload.error || 'Unable to reset API token', 'error');
        return;
      }
      setTokenValue(payload.token);
      setTokenVisible(true);
      setBundle((current) => (
        current
          ? { ...current, apiToken: { ...current.apiToken, configured: true, masked: payload.masked || current.apiToken.masked } }
          : current
      ));
      setResetOpen(false);
      toasts.push('API token reset', 'success');
    } finally {
      setTokenBusy(false);
    }
  };

  const deleteAccount = async () => {
    setDeleteBusy(true);
    try {
      const response = await fetch('/api/profile/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: deletePhrase }),
      });
      const payload = await response.json() as { error?: string; redirectTo?: string };
      if (!response.ok) {
        toasts.push(payload.error || 'Unable to delete account', 'error');
        return;
      }
      router.push(payload.redirectTo || LOGIN_HREF);
    } finally {
      setDeleteBusy(false);
    }
  };

  const copyReferral = async () => {
    if (!referralUrl) return;
    await navigator.clipboard.writeText(referralUrl);
    toasts.push('Referral link copied', 'success');
  };

  const filteredModels = models.filter((model) => {
    const haystack = `${model.displayName} ${model.id} ${model.family}`.toLowerCase();
    return !modelQuery.trim() || haystack.includes(modelQuery.trim().toLowerCase());
  });

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <style>{`
        .profile-shell { --font-sans: 'Instrument Sans', 'Noto Sans', sans-serif; --font-display: 'Space Grotesk', sans-serif; }
        .profile-shell h1, .profile-shell h2, .profile-shell .font-display { font-family: var(--font-display); }
      `}</style>
      <main className="profile-shell flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Profile" onExit={() => router.push('/')} />
        <div className="custom-scrollbar flex-1 overflow-y-auto px-4 py-6 sm:px-8">
          <div className="mx-auto max-w-5xl space-y-6 pb-16">
            <div>
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Account</p>
              <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-black">Profile</h1>
            </div>

            {loadError ? <InlineError message={loadError} onRetry={() => void load()} /> : null}

            {loading ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.8fr)]">
                <ProfileCard className="p-5"><Skeleton className="h-24" /></ProfileCard>
                <ProfileCard className="p-5"><Skeleton className="h-24" /></ProfileCard>
              </div>
            ) : bundle ? (
              <>
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.8fr)]">
                  <ProfileCard className="relative p-5">
                    <div className="flex items-start gap-4">
                      {bundle.profile.avatarUrl ? (
                        <img
                          src={bundle.profile.avatarUrl}
                          alt=""
                          className="h-16 w-16 rounded-full object-cover"
                          onError={(event) => {
                            event.currentTarget.style.display = 'none';
                          }}
                        />
                      ) : (
                        <div className="flex h-16 w-16 items-center justify-center rounded-none border-[3px] border-black bg-black text-lg font-semibold text-white">
                          {initialsFromName(bundle.profile.displayName)}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-lg font-semibold tracking-wide text-white">{bundle.profile.displayName}</p>
                        <p className="truncate text-[13px] text-zinc-400">{bundle.profile.email}</p>
                        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                          <div>
                            <dt className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">LinkedIn</dt>
                            <dd className="mt-1 truncate text-[13px] text-zinc-300">{displaySocial(bundle.profile.linkedinUrl)}</dd>
                          </div>
                          <div>
                            <dt className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">GitHub</dt>
                            <dd className="mt-1 truncate text-[13px] text-zinc-300">{displaySocial(bundle.profile.githubUrl)}</dd>
                          </div>
                        </dl>
                      </div>
                      <button
                        type="button"
                        onClick={openEdit}
                        title="Edit profile"
                        aria-label="Edit profile"
                        className={`border-[3px] border-black p-2 text-black hover:bg-black hover:text-white ${focusRing}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                    </div>
                  </ProfileCard>

                  <ProfileCard className="p-5">
                    <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Remaining credits</p>
                    {bundle.credits ? (
                      <>
                        <p className={`mt-3 font-display text-4xl font-semibold tracking-tight ${
                          creditStatus === 'negative' ? 'text-rose-400' : creditStatus === 'warning' ? 'text-amber-200' : 'text-white'
                        }`}>
                          {formatCreditUsd(bundle.credits.total)}
                        </p>
                        <p className="mt-2 text-[12px] text-zinc-500">
                          {bundle.credits.plan_name ? `${bundle.credits.plan_name} plan` : 'Current balance'}
                          {bundle.credits.bonus_unlocked ? ' · bonus unlocked' : ''}
                        </p>
                      </>
                    ) : (
                      <InlineError message="Unable to load billing information." onRetry={() => void load()} />
                    )}
                  </ProfileCard>
                </div>

                <ProfileCard className="overflow-hidden p-6">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Billing</p>
                      <h2 className="mt-2 flex items-center gap-2 font-display text-xl font-semibold text-white">
                        <CreditCard className="h-5 w-5 text-zinc-300" aria-hidden="true" />
                        Subscription
                      </h2>
                      <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-zinc-500">
                        Paid credits match your subscription dollars 1:1. Unlock up to {maxBonus || 40}% bonus credits after paid credits are used. Razorpay charges INR including GST.
                      </p>
                    </div>
                    <PrimaryButton variant="ghost" onClick={() => void copyReferral()}>
                      Refer & earn
                      <span className="ml-2 border-2 border-black px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-black">New</span>
                    </PrimaryButton>
                  </div>

                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    <Segmented
                      value={yearly ? 'yearly' : 'monthly'}
                      onChange={(next) => setYearly(next === 'yearly')}
                      options={[{ id: 'monthly', label: 'Monthly' }, { id: 'yearly', label: 'Yearly' }]}
                    />
                    {yearly ? (
                      <span className="border-2 border-black px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-black">
                        Save 20%
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    {plans.map((plan) => {
                      const monthly = yearly && plan.yearlyPriceCents > 0
                        ? Math.round(plan.yearlyPriceCents / 12)
                        : plan.priceCents;
                      const current = bundle.subscription?.planId === plan.id || bundle.credits?.plan_id === plan.id;
                      const cta = plan.isCustom
                        ? 'Contact sales'
                        : plan.id === 'free'
                          ? current
                            ? 'Current plan'
                            : 'Included'
                          : current
                            ? 'Current plan'
                            : razorpayConfigured
                              ? 'Upgrade'
                              : 'Checkout not configured';
                      return (
                        <div
                          key={plan.id}
                          className={`relative app-paper p-5 ${
                            plan.isRecommended ? '' : ''
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="font-display text-lg text-white">{plan.displayName}</h3>
                            {plan.isRecommended ? (
                              <span className="border-2 border-black bg-black px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-white">
                                Recommended
                              </span>
                            ) : null}
                          </div>
                          {plan.isCustom ? (
                            <p className="mt-3 font-display text-3xl text-white">Custom</p>
                          ) : (
                            <p className="mt-3 font-display text-3xl text-white">
                              ${Math.round(monthly / 100)}
                              <span className="ml-1 text-sm font-normal text-zinc-500">/ month</span>
                            </p>
                          )}
                          <p className="mt-2 text-[12px] text-zinc-500">{plan.description}</p>
                          <ul className="mt-4 space-y-2 text-[13px] text-zinc-400">
                            <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 text-white" /> ${plan.paidCreditAmount} paid credits</li>
                            <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 text-white" /> {plan.bonusCreditPercent > 0 ? `Up to ${plan.bonusCreditPercent}% bonus` : 'No bonus credits'}</li>
                          </ul>
                          <PrimaryButton
                            variant={plan.isRecommended && !current ? 'white' : 'default'}
                            className="mt-5 w-full"
                            disabled={Boolean(checkoutBusy) || current || plan.id === 'free'}
                            loading={checkoutBusy === plan.id}
                            onClick={() => void startCheckout(plan)}
                          >
                            {cta}
                          </PrimaryButton>
                        </div>
                      );
                    })}
                  </div>
                </ProfileCard>

                <ProfileCard className="p-6">
                  <h2 className="font-display text-lg font-semibold text-white">Buy Credits</h2>
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[20, 50, 100].map((amount) => (
                      <button
                        key={amount}
                        type="button"
                        onClick={() => {
                          setSelectedCredit(String(amount));
                          void buyCredits(amount);
                        }}
                        disabled={Boolean(checkoutBusy)}
                        className={`min-h-12 border-[3px] border-black px-4 py-3 text-[15px] font-bold transition duration-150 ${focusRing} ${
                          selectedCredit === String(amount) ? 'bg-black text-white shadow-[4px_4px_0_0_#000]' : 'bg-white text-black shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none'
                        }`}
                      >
                        {checkoutBusy === `credits-${amount}` ? 'Starting…' : `$${amount}`}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => { setSelectedCredit('custom'); setCustomOpen(true); }}
                      className={`min-h-12 border-[3px] border-black px-4 py-3 text-[15px] font-bold ${focusRing} ${
                        selectedCredit === 'custom' ? 'bg-black text-white shadow-[4px_4px_0_0_#000]' : 'bg-white text-black shadow-[4px_4px_0_0_#000] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none'
                      }`}
                    >
                      Custom
                    </button>
                  </div>
                </ProfileCard>

                <ProfileCard className="p-6">
                  <h2 className="font-display text-lg font-semibold text-white">Automatic Top Up</h2>
                  <p className="mt-2 text-[13px] text-zinc-400">
                    Automatically add credits when your balance falls below ${bundle.autoTopup.thresholdUsd}.
                  </p>
                  {bundle.autoTopup.enabled ? (
                    <p className="mt-3 text-[13px] text-emerald-300">
                      Enabled · add ${bundle.autoTopup.addUsd}
                      {bundle.autoTopup.paymentMethodLast4 ? ` · •••• ${bundle.autoTopup.paymentMethodLast4}` : ' · no payment method on file'}
                    </p>
                  ) : null}
                  <PrimaryButton className="mt-4" onClick={() => { setTopupDraft({ enabled: bundle.autoTopup.enabled, thresholdUsd: bundle.autoTopup.thresholdUsd, addUsd: bundle.autoTopup.addUsd }); setTopupOpen(true); }}>
                    Configure automatic top-up
                  </PrimaryButton>
                </ProfileCard>

                <ProfileCard className="p-6">
                  <h2 className="font-display text-lg font-semibold text-white">Auto routing</h2>
                  <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
                    Choose how Deplai ranks models for aliases like <span className="font-mono text-zinc-300">best_reasoning</span> and which models belong in the Efficient pool.
                  </p>
                  <div className="mt-5 max-w-md">
                    <Field label="Routing mode" htmlFor="routing-mode" hint={routingModeById(routingMode).description}>
                      <select
                        id="routing-mode"
                        value={routingMode}
                        onChange={(event) => setRoutingMode(event.target.value as RoutingModeId)}
                        disabled={routingSaving}
                        className={inputClass}
                      >
                        {ROUTING_MODES.map((mode) => (
                          <option key={mode.id} value={mode.id}>{mode.label}</option>
                        ))}
                      </select>
                    </Field>
                  </div>

                  <div className="mt-6">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <h3 className="text-[13px] font-medium text-white">Efficient model pool</h3>
                        <p className="mt-1 text-[12px] text-zinc-500">Up to {MAX_EFFICIENT_POOL} exact model and variant pairs. Leave empty to inherit.</p>
                      </div>
                      <PrimaryButton
                        variant="ghost"
                        disabled={pool.length >= MAX_EFFICIENT_POOL}
                        onClick={() => { setAddModelOpen(true); setModelQuery(''); setSelectedModelId(''); }}
                      >
                        <Plus className="h-4 w-4" /> Add model
                      </PrimaryButton>
                    </div>
                    {pool.length === 0 ? (
                      <p className="mt-4 border-[3px] border-dashed border-black px-4 py-6 text-[13px] text-neutral-600">
                        No custom pool. Efficient uses the platform model pool.
                      </p>
                    ) : (
                      <div className="mt-4 overflow-x-auto">
                        <table className="w-full text-left text-[13px]">
                          <thead className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                            <tr>
                              <th className="pb-2">Model</th>
                              <th className="pb-2">Variant</th>
                              <th className="pb-2 text-right">Remove</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pool.map((entry) => (
                              <tr key={`${entry.modelId}-${entry.variant}`} className="border-t-[3px] border-black">
                                <td className="py-2 text-black">{models.find((model) => model.id === entry.modelId)?.displayName || entry.modelId}</td>
                                <td className="py-2 text-zinc-400">{entry.variant}</td>
                                <td className="py-2 text-right">
                                  <button
                                    type="button"
                                    aria-label={`Remove ${entry.modelId}`}
                                    onClick={() => setPool((current) => current.filter((item) => item !== entry))}
                                    className={`p-1 text-neutral-500 hover:text-black ${focusRing}`}
                                  >
                                    <X className="h-4 w-4" />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  <PrimaryButton className="mt-5" disabled={!routingDirty || routingSaving} loading={routingSaving} onClick={() => void saveRouting()}>
                    Save auto routing
                  </PrimaryButton>
                </ProfileCard>

                <ProfileCard className="p-6">
                  <h2 className="font-display text-lg font-semibold text-white">Redeem Promotional Code</h2>
                  <p className="mt-2 text-[13px] text-zinc-400">Enter a promotional code to add credits to your account.</p>
                  <form
                    className="mt-4 flex flex-col gap-3 sm:flex-row"
                    onSubmit={(event) => { event.preventDefault(); void redeemPromo(); }}
                  >
                    <input
                      value={promo}
                      onChange={(event) => { setPromo(event.target.value); setPromoError(''); setPromoSuccess(''); }}
                      placeholder="Enter promo code"
                      aria-label="Promotional code"
                      aria-invalid={Boolean(promoError)}
                      className={`${inputClass} ${promoError ? 'border-rose-400/70' : promoSuccess ? 'border-emerald-400/50' : ''}`}
                    />
                    <PrimaryButton type="submit" loading={promoBusy} className="sm:w-auto">Redeem Code</PrimaryButton>
                  </form>
                  {promoError ? <p className="mt-2 text-[12px] text-rose-300" role="alert">{promoError}</p> : null}
                  {promoSuccess ? <p className="mt-2 text-[12px] text-emerald-300">{promoSuccess}</p> : null}
                </ProfileCard>

                <ProfileCard className="p-6">
                  <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Workspace</p>
                  <h2 className="mt-2 font-display text-lg font-semibold text-white">Integrations</h2>
                  <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-zinc-500">
                    Connect the Deplai GitHub App for repositories, scans, and deployments. GitLab, Slack, Linear, and Jira are on the way.
                  </p>
                  <div className="mt-5">
                    <IntegrationsApp embedded />
                  </div>
                </ProfileCard>

                <ProfileCard className="p-6">
                  <h2 className="font-display text-lg font-semibold text-white">API token</h2>
                  <p className="mt-2 text-[13px] text-zinc-500">
                    Authenticate Deplai API requests. The token is masked until you show or copy it.
                  </p>
                  {bundle.apiToken.configured ? (
                    <>
                      <p className="mt-3 font-mono text-sm tracking-widest text-zinc-300">
                        {tokenVisible && tokenValue ? tokenValue : bundle.apiToken.masked}
                      </p>
                      {bundle.apiToken.lastUsedAt ? (
                        <p className="mt-1 text-[12px] text-zinc-500">
                          Last used {new Date(bundle.apiToken.lastUsedAt).toLocaleString()}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <p className="mt-3 border-[3px] border-dashed border-black px-4 py-4 text-[13px] text-neutral-600">
                      No API token issued yet. Reset generates a new token.
                    </p>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <PrimaryButton variant="ghost" loading={tokenBusy} disabled={!bundle.apiToken.configured && !tokenValue} onClick={() => void showToken()}>
                      {tokenVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      {tokenVisible ? 'Hide' : 'Show'}
                    </PrimaryButton>
                    <PrimaryButton variant="ghost" disabled={!bundle.apiToken.configured && !tokenValue} onClick={() => void copyToken()}>
                      <Copy className="h-4 w-4" />
                      {copied ? 'Copied' : 'Copy'}
                    </PrimaryButton>
                    <PrimaryButton variant="danger" onClick={() => setResetOpen(true)}>Reset API token</PrimaryButton>
                  </div>
                </ProfileCard>

                <ProfileCard danger className="p-6">
                  <h2 className="font-display text-lg font-semibold text-rose-200">Danger Zone</h2>
                  <p className="mt-2 max-w-2xl text-[13px] text-rose-100/80">
                    Account deletion is permanent. Cancel active subscriptions before starting.
                    Your account data will be deleted and anonymized. You will be signed out after the deletion request starts.
                  </p>
                  <PrimaryButton variant="danger" className="mt-5" onClick={() => setDeleteOpen(true)}>
                    <Trash2 className="h-4 w-4" /> Delete account
                  </PrimaryButton>
                </ProfileCard>
              </>
            ) : null}
          </div>
        </div>
      </main>

      <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />

      <Dialog open={editOpen} title="Edit Profile" onClose={closeEdit}>
        <form
          className="space-y-4"
          onSubmit={(event) => { event.preventDefault(); void saveProfile(); }}
        >
          <Field label="Full name" htmlFor="profile-name" error={editErrors.displayName}>
            <input id="profile-name" className={inputClass} value={editDraft.displayName} onChange={(event) => setEditDraft((current) => ({ ...current, displayName: event.target.value }))} />
          </Field>
          <Field label="Email" htmlFor="profile-email" error={editErrors.email}>
            <input id="profile-email" type="email" className={inputClass} value={editDraft.email} onChange={(event) => setEditDraft((current) => ({ ...current, email: event.target.value }))} />
          </Field>
          <Field label="LinkedIn" htmlFor="profile-linkedin" error={editErrors.linkedinUrl} hint="Optional">
            <input id="profile-linkedin" className={inputClass} placeholder="linkedin.com/in/you" value={editDraft.linkedinUrl} onChange={(event) => setEditDraft((current) => ({ ...current, linkedinUrl: event.target.value }))} />
          </Field>
          <Field label="GitHub" htmlFor="profile-github" error={editErrors.githubUrl} hint="Optional">
            <input id="profile-github" className={inputClass} placeholder="github.com/you" value={editDraft.githubUrl} onChange={(event) => setEditDraft((current) => ({ ...current, githubUrl: event.target.value }))} />
          </Field>
          {editErrors.form ? <p className="text-[12px] text-rose-300">{editErrors.form}</p> : null}
          <div className="flex justify-end gap-2 pt-2">
            <PrimaryButton variant="ghost" onClick={closeEdit}>Cancel</PrimaryButton>
            <PrimaryButton type="submit" variant="white" disabled={!editDirty} loading={editSaving}>Save changes</PrimaryButton>
          </div>
        </form>
      </Dialog>

      <Dialog open={customOpen} title="Buy Custom Credits" onClose={() => setCustomOpen(false)}>
        <Field label="Amount" htmlFor="custom-credits" error={customError} hint={`Minimum: $${MIN_CUSTOM_CREDIT_USD}. Maximum: $${MAX_CUSTOM_CREDIT_USD}.`}>
          <input
            id="custom-credits"
            inputMode="numeric"
            className={inputClass}
            value={customAmount}
            onChange={(event) => { setCustomAmount(event.target.value); setCustomError(''); }}
          />
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <PrimaryButton variant="ghost" onClick={() => setCustomOpen(false)}>Cancel</PrimaryButton>
          <PrimaryButton
            variant="white"
            loading={Boolean(checkoutBusy)}
            onClick={() => {
              const parsed = validateCustomCreditUsd(customAmount);
              if (!parsed.ok) {
                setCustomError(parsed.error);
                return;
              }
              void buyCredits(parsed.amount);
            }}
          >
            Continue
          </PrimaryButton>
        </div>
      </Dialog>

      <Dialog open={topupOpen} title="Automatic Top Up" onClose={() => setTopupOpen(false)}>
        <div className="flex items-center justify-between gap-4">
          <p className="text-[13px] text-black">Enable automatic top-up</p>
          <Toggle checked={topupDraft.enabled} onChange={(enabled) => setTopupDraft((current) => ({ ...current, enabled }))} label="Enable automatic top-up" />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="When balance falls below" htmlFor="topup-threshold">
            <input id="topup-threshold" type="number" min={1} className={inputClass} value={topupDraft.thresholdUsd} onChange={(event) => setTopupDraft((current) => ({ ...current, thresholdUsd: Number(event.target.value) }))} />
          </Field>
          <Field label="Add" htmlFor="topup-add">
            <input id="topup-add" type="number" min={5} className={inputClass} value={topupDraft.addUsd} onChange={(event) => setTopupDraft((current) => ({ ...current, addUsd: Number(event.target.value) }))} />
          </Field>
        </div>
        <Field label="Payment method" hint={bundle?.autoTopup.paymentMethodLast4 ? undefined : 'No payment method on file yet. A method is stored after a successful checkout.'}>
          <div className={`${inputClass} flex items-center justify-between`}>
            <span>{bundle?.autoTopup.paymentMethodLast4 ? `•••• ${bundle.autoTopup.paymentMethodLast4}` : 'No payment method'}</span>
          </div>
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <PrimaryButton variant="ghost" onClick={() => setTopupOpen(false)}>Cancel</PrimaryButton>
          <PrimaryButton variant="white" loading={topupSaving} onClick={() => void saveTopup()}>Save</PrimaryButton>
        </div>
      </Dialog>

      <Dialog open={addModelOpen} title="Add model" onClose={() => setAddModelOpen(false)} wide>
        <Field label="Search models" htmlFor="model-search">
          <input id="model-search" className={inputClass} placeholder="Search models..." value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} />
        </Field>
        <div className="mt-3 max-h-48 overflow-y-auto border-[3px] border-black">
          {filteredModels.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-neutral-500">No models match that search.</p>
          ) : filteredModels.slice(0, 20).map((model) => (
            <label key={model.id} className="flex cursor-pointer items-center gap-3 border-b-2 border-black px-3 py-2 text-[13px] hover:bg-neutral-100">
              <input type="radio" name="add-model" checked={selectedModelId === model.id} onChange={() => { setSelectedModelId(model.id); setSelectedVariant(model.variant || 'default'); }} />
              <span className="text-black">{model.displayName}</span>
              <span className="ml-auto font-mono text-[11px] text-neutral-500">{model.providerId}</span>
            </label>
          ))}
        </div>
        <Field label="Variant" htmlFor="model-variant">
          <select id="model-variant" className={`${inputClass} mt-3`} value={selectedVariant} onChange={(event) => setSelectedVariant(event.target.value)}>
            <option value="default">Default</option>
            {selectedModelId ? <option value={models.find((model) => model.id === selectedModelId)?.variant || 'default'}>{models.find((model) => model.id === selectedModelId)?.variant || 'default'}</option> : null}
          </select>
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <PrimaryButton variant="ghost" onClick={() => setAddModelOpen(false)}>Cancel</PrimaryButton>
          <PrimaryButton
            variant="white"
            disabled={!selectedModelId || pool.length >= MAX_EFFICIENT_POOL}
            onClick={() => {
              if (!selectedModelId) return;
              setPool((current) => [...current, { modelId: selectedModelId, variant: selectedVariant || 'default' }]);
              setAddModelOpen(false);
            }}
          >
            Add model
          </PrimaryButton>
        </div>
      </Dialog>

      <Dialog open={resetOpen} title="Reset API Token?" onClose={() => setResetOpen(false)}>
        <p className="text-[13px] leading-relaxed text-zinc-400">
          Your current API token will stop working immediately. Applications using this token will need to be updated.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <PrimaryButton variant="ghost" onClick={() => setResetOpen(false)}>Cancel</PrimaryButton>
          <PrimaryButton variant="danger" loading={tokenBusy} onClick={() => void resetToken()}>Reset token</PrimaryButton>
        </div>
      </Dialog>

      <Dialog open={deleteOpen} title="Delete your account?" onClose={() => { if (!deleteBusy) setDeleteOpen(false); }}>
        <p className="text-[13px] leading-relaxed text-zinc-400">
          This action is permanent. Your account data will be deleted and anonymized. Active subscriptions must be cancelled first.
        </p>
        <Field label="Type DELETE to confirm" htmlFor="delete-confirm">
          <input
            id="delete-confirm"
            className={inputClass}
            value={deletePhrase}
            onChange={(event) => setDeletePhrase(event.target.value)}
            disabled={deleteBusy}
          />
        </Field>
        {deleteBusy ? <p className="mt-3 flex items-center gap-2 text-[13px] text-rose-200"><Loader2 className="h-4 w-4 animate-spin" /> Deleting account...</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <PrimaryButton variant="ghost" disabled={deleteBusy} onClick={() => setDeleteOpen(false)}>Cancel</PrimaryButton>
          <PrimaryButton variant="danger" disabled={deletePhrase !== 'DELETE'} loading={deleteBusy} onClick={() => void deleteAccount()}>
            Delete account
          </PrimaryButton>
        </div>
      </Dialog>
    </div>
  );
}

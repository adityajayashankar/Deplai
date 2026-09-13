'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  Copy,
  CreditCard,
  Eye,
  EyeOff,
  KeyRound,
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
import { buildReferralSignupUrl } from '@/lib/public-app-url';
import { formatCreditAmount } from '@/lib/billing/credit-format';
import {
  MAX_EFFICIENT_POOL,
  ROUTING_MODES,
  creditTone,
  displaySocial,
  formatCreditUsd,
  initialsFromName,
  routingModeById,
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
    organization_id?: string;
    never_expires?: boolean;
  } | null;
  organizationCredits: {
    total: number;
    paid_remaining: number;
    bonus_remaining: number;
    bonus_unlocked: boolean;
    plan_id?: string;
    plan_name?: string;
    organization_id?: string;
    never_expires?: boolean;
  } | null;
  subscription: { planId: string; planName?: string; status: string; cadence: string } | null;
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
  pricePaise: number;
  yearlyPricePaise: number;
  paidCreditAmount: number;
  annualCreditAmount: number;
  isCustom: boolean;
  isAvailable: boolean;
  availabilityMessage: string | null;
  isRecommended: boolean;
  features: string[];
};

function formatInr(paise: number): string {
  const rupees = paise / 100;
  return rupees.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function isPerCreditRateFeature(feature: string): boolean {
  return /(?:\d+\s*credit\s*=|per\s+credit|provider\s+(?:usage|value))/i.test(feature);
}

function isManagedCreditFeature(feature: string): boolean {
  return /managed[- ]?llm credits/i.test(feature);
}

type PaymentsInfo = {
  mode: 'test' | 'live';
  testAmountOverride: boolean;
  testAmountPaise: number | null;
};

type CreditPack = {
  id: string;
  name: string;
  creditAmount: number;
  pricePaise: number;
  paidTiersOnly: boolean;
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
  const [creditPacks, setCreditPacks] = useState<CreditPack[]>([]);
  const [razorpayConfigured, setRazorpayConfigured] = useState(false);
  const [payments, setPayments] = useState<PaymentsInfo | null>(null);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [yearly, setYearly] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState({ displayName: '', email: '', linkedinUrl: '', githubUrl: '' });
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [editSaving, setEditSaving] = useState(false);
  const [editBaseline, setEditBaseline] = useState('');

  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null);

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
  const [tokenFresh, setTokenFresh] = useState(false);
  const [curlCopied, setCurlCopied] = useState(false);
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
      const payload = await plansRes.json() as {
        plans?: Plan[];
        packs?: CreditPack[];
        razorpayConfigured?: boolean;
        payments?: PaymentsInfo;
      };
      setPlans(Array.isArray(payload.plans) ? payload.plans : []);
      setCreditPacks(Array.isArray(payload.packs) ? payload.packs : []);
      setRazorpayConfigured(Boolean(payload.razorpayConfigured));
      if (payload.payments) setPayments(payload.payments);
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

  const routingDirty = useMemo(() => {
    if (!bundle) return false;
    return routingMode !== bundle.routing.mode || JSON.stringify(pool) !== JSON.stringify(bundle.routing.efficientPool);
  }, [bundle, pool, routingMode]);
  const referralUrl = bundle
    ? buildReferralSignupUrl(bundle.profile.referralCode, typeof window === 'undefined' ? undefined : window.location.origin)
    : '';
  const activePlanName = bundle?.organizationCredits?.plan_name
    || bundle?.subscription?.planName
    || bundle?.credits?.plan_name
    || null;
  const hasPaidSubscription = Boolean(
    (bundle?.subscription?.status === 'active' || bundle?.subscription?.status === 'trialing')
    && bundle?.subscription?.planId
    && bundle.subscription.planId !== 'free',
  ) || Boolean(bundle?.organizationCredits?.plan_id && bundle.organizationCredits.plan_id !== 'free');
  const displayCredits = bundle?.organizationCredits?.total ?? bundle?.credits?.total ?? 0;
  const usesOrgCredits = Boolean(bundle?.organizationCredits);
  const creditStatus = creditTone(displayCredits);

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
    if (!plan.isAvailable) return toasts.push(plan.availabilityMessage || 'This plan is coming soon.', 'info');
    if (plan.id === 'free') return;
    setCheckoutBusy(plan.id);
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_id: plan.id,
          cadence: yearly ? 'yearly' : 'monthly',
          idempotency_key: `profile_plan_${crypto.randomUUID().replace(/-/g, '')}`,
        }),
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
      if (result.status === 'pending') {
        toasts.push(result.message, 'info');
        return;
      }
      await load();
      toasts.push('Subscription updated', 'success');
    } finally {
      setCheckoutBusy(null);
    }
  };

  const buyCreditPack = async (pack: CreditPack) => {
    setCheckoutBusy(pack.id);
    try {
      const response = await fetch('/api/billing/credits/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credit_pack_id: pack.id,
          idempotency_key: `profile_pack_${crypto.randomUUID().replace(/-/g, '')}`,
        }),
      });
      const payload = await response.json() as RazorpayCheckoutPayload & { error?: string };
      if (!response.ok) {
        toasts.push(payload.error || 'Could not start top-up checkout', 'error');
        return;
      }
      const result = await start(payload);
      if (result.status === 'cancelled') return;
      if (result.status === 'failed') {
        toasts.push(result.message || 'Payment failed', 'error');
        return;
      }
      if (result.status === 'pending') {
        toasts.push(result.message, 'info');
        return;
      }
      await load();
      toasts.push('Credit top-up purchased', 'success');
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
      setTokenFresh(false);
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
      setTokenFresh(true);
      setBundle((current) => (
        current
          ? {
            ...current,
            apiToken: {
              ...current.apiToken,
              configured: true,
              masked: payload.masked || current.apiToken.masked,
              lastUsedAt: null,
              lastUsedClient: null,
            },
          }
          : current
      ));
      setResetOpen(false);
      toasts.push('API token rotated', 'success');
    } finally {
      setTokenBusy(false);
    }
  };

  const issueApiToken = async () => {
    setTokenBusy(true);
    try {
      const response = await fetch('/api/profile/api-token', { method: 'POST' });
      const payload = await response.json() as { token?: string; masked?: string; error?: string };
      if (!response.ok || !payload.token) {
        toasts.push(payload.error || 'Unable to create API token', 'error');
        return;
      }
      setTokenValue(payload.token);
      setTokenVisible(true);
      setTokenFresh(true);
      setBundle((current) => (
        current
          ? {
            ...current,
            apiToken: {
              ...current.apiToken,
              configured: true,
              masked: payload.masked || current.apiToken.masked,
              lastUsedAt: null,
              lastUsedClient: null,
            },
          }
          : current
      ));
      toasts.push('API token created — copy it now', 'success');
    } finally {
      setTokenBusy(false);
    }
  };

  const apiOrigin = typeof window === 'undefined' ? 'https://app.deplai.tech' : window.location.origin;
  const curlExample = useMemo(() => (
    `curl -s "${apiOrigin}/api/billing/credits/balance" \\\n  -H "Authorization: Bearer ${tokenVisible && tokenValue ? tokenValue : 'YOUR_API_TOKEN'}"`
  ), [apiOrigin, tokenValue, tokenVisible]);

  const copyCurlExample = async () => {
    await navigator.clipboard.writeText(curlExample);
    setCurlCopied(true);
    window.setTimeout(() => setCurlCopied(false), 1600);
    toasts.push('Example copied', 'success');
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
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <h1 className="font-display text-2xl font-semibold tracking-tight text-black">Profile</h1>
                {hasPaidSubscription && activePlanName ? (
                  <span className="border-2 border-black bg-black px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-white">
                    Current plan: {activePlanName}
                  </span>
                ) : null}
              </div>
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
                        <p className="truncate text-[13px] text-zinc-400">{activePlanName || 'Free'}</p>
                        <dl className="mt-4">
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
                    <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">
                      {usesOrgCredits ? 'Organization credits' : 'Remaining credits'}
                    </p>
                    {bundle.credits ? (
                      <>
                        <p className={`mt-3 font-display text-4xl font-semibold tracking-tight ${
                          creditStatus === 'negative' ? 'text-rose-700' : creditStatus === 'warning' ? 'text-amber-700' : 'text-black'
                        }`}>
                          {usesOrgCredits
                            ? formatCreditAmount(displayCredits)
                            : formatCreditUsd(displayCredits)}
                        </p>
                        <p className="mt-2 text-[12px] text-zinc-500">
                          {activePlanName ? `${activePlanName} plan` : 'Current balance'}
                          {usesOrgCredits
                            ? ' · shared organization wallet'
                            : bundle.credits.bonus_unlocked ? ' · bonus unlocked' : ''}
                          {usesOrgCredits && bundle.credits.never_expires ? ' · never expire' : ''}
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
                      <h2 className="mt-2 flex items-center gap-2 font-display text-xl font-semibold text-black">
                        <CreditCard className="h-5 w-5 text-black" aria-hidden="true" />
                        Subscription
                      </h2>
                      <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-zinc-500">
                        Fixed INR prices include GST. Managed-LLM credits are shared by your organization and never expire.
                      </p>
                    </div>
                    <PrimaryButton variant="ghost" onClick={() => router.push('/dashboard/referrals')}>
                      Refer & earn
                      <span className="ml-2 border-2 border-black px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-black">New</span>
                    </PrimaryButton>
                  </div>

                  {payments?.testAmountOverride ? (
                    <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-[3px] border-black bg-white px-3 py-2 shadow-[3px_3px_0_0_#000]">
                      <span className="border-2 border-black bg-black px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-white">{payments.mode === 'live' ? 'Live checkout' : 'Test mode'}</span>
                      <strong className="text-[13px] text-black">₹1 test charge</strong>
                      <span className="text-[12px] text-neutral-600">Catalog prices are shown for reference; Razorpay charges ₹1 until testing is turned off.</span>
                    </div>
                  ) : null}

                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    <Segmented
                      value={yearly ? 'yearly' : 'monthly'}
                      onChange={(next) => setYearly(next === 'yearly')}
                      options={[{ id: 'monthly', label: 'Monthly' }, { id: 'yearly', label: 'Yearly' }]}
                    />
                    {yearly ? (
                      <span className="border-2 border-black px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-black">
                        Save ~10%
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    {plans.map((plan) => {
                      const totalPaise = yearly && plan.yearlyPricePaise > 0 ? plan.yearlyPricePaise : plan.pricePaise;
                      const credits = yearly ? plan.annualCreditAmount : plan.paidCreditAmount;
                      const current = bundle.subscription?.planId === plan.id || bundle.credits?.plan_id === plan.id;
                      const unavailable = !plan.isAvailable;
                      const cta = unavailable
                        ? 'Coming soon'
                        : plan.id === 'free'
                          ? current
                            ? 'Current plan'
                            : 'Included'
                          : current
                            ? 'Current plan'
                            : razorpayConfigured
                              ? payments?.testAmountOverride
                                ? 'Pay \u20B91'
                                : 'Upgrade'
                              : 'Checkout not configured';
                      return (
                        <div key={plan.id} className={`relative app-paper p-5 ${plan.isRecommended ? '' : ''}`}>
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="font-display text-lg text-black">{plan.displayName}</h3>
                            {plan.isRecommended ? (
                              <span className="border-2 border-black bg-black px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-white">Recommended</span>
                            ) : null}
                          </div>
                          {unavailable ? (
                            <p className="mt-3 font-display text-3xl text-black">Coming soon</p>
                          ) : plan.isCustom ? (
                            <p className="mt-3 font-display text-3xl text-black">Custom</p>
                          ) : (
                            <>
                              <p className="mt-3 font-display text-3xl text-black">{'\u20B9'}{formatInr(totalPaise)}</p>
                              <p className="mt-1 text-[12px] font-semibold text-zinc-500">GST-inclusive &middot; {yearly ? 'billed yearly' : 'billed monthly'}</p>
                            </>
                          )}
                          <p className="mt-2 text-[12px] text-zinc-500">{plan.description}</p>
                          <ul className="mt-4 space-y-2 text-[13px] text-neutral-700">
                            {unavailable ? (
                              <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 text-black" />{plan.availabilityMessage || 'This plan is coming soon.'}</li>
                            ) : (
                              <>
                                <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 text-black" />{credits} managed credits {yearly ? 'per year, released monthly' : 'per month'}</li>
                                <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 text-black" />Credits never expire</li>
                              </>
                            )}
                            {plan.features
                              .filter((feature) => !isPerCreditRateFeature(feature) && !isManagedCreditFeature(feature))
                              .map((feature) => (
                                <li key={feature} className="flex gap-2">
                                  <Check className="mt-0.5 h-4 w-4 text-black" />
                                  {feature}
                                </li>
                              ))}
                          </ul>
                          <PrimaryButton
                            variant={plan.isRecommended && !current ? 'white' : 'default'}
                            className="mt-5 w-full"
                            disabled={unavailable || Boolean(checkoutBusy) || current || plan.id === 'free'}
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
                  <h2 className="font-display text-lg font-semibold text-black">Buy Credits</h2>
                  <p className="mt-2 text-[13px] text-neutral-600">
                    Fixed GST-inclusive INR top-ups for paid organizations. Credits never expire.
                  </p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {creditPacks.map((pack) => {
                      const onFreePlan = !hasPaidSubscription;
                      const blocked = pack.paidTiersOnly && onFreePlan;
                      return (
                        <div key={pack.id} className="app-paper p-5">
                          <p className="font-display text-lg text-black">{pack.name}</p>
                          <p className="mt-2 text-sm text-neutral-600">₹{formatInr(pack.pricePaise)} incl. GST</p>
                          <p className="mt-1 font-mono text-[11px] text-neutral-500">{pack.creditAmount} credits</p>
                          <PrimaryButton
                            className="mt-4 w-full"
                            disabled={blocked || !razorpayConfigured || Boolean(checkoutBusy)}
                            loading={checkoutBusy === pack.id}
                            onClick={() => void buyCreditPack(pack)}
                          >
                            {blocked
                              ? 'Paid plans only'
                              : !razorpayConfigured
                                ? 'Checkout not configured'
                                : payments?.testAmountOverride
                                  ? 'Pay ₹1'
                                  : 'Buy top-up'}
                          </PrimaryButton>
                        </div>
                      );
                    })}
                  </div>
                  {!creditPacks.length ? (
                    <p className="mt-4 text-[13px] text-neutral-500">Credit packs are unavailable right now.</p>
                  ) : null}
                  <PrimaryButton variant="ghost" className="mt-4" onClick={() => router.push('/dashboard/billing?view=credits')}>
                    Open billing page
                  </PrimaryButton>
                </ProfileCard>

                <ProfileCard className="p-6">
                  <h2 className="font-display text-lg font-semibold text-black">Automatic Top Up</h2>
                  <p className="mt-2 text-[13px] text-neutral-600">
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
                  <p className="mt-2 text-[13px] text-zinc-400">
                    Enter a promotional code to add credits. Referral codes apply through a shared sign-up link for a new user’s first paid plan.
                  </p>
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
                  <div className="flex items-start gap-3">
                    <div className="border-[3px] border-black bg-black p-2 text-white">
                      <KeyRound className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Automation</p>
                      <h2 className="mt-1 font-display text-lg font-semibold text-black">API token</h2>
                      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-zinc-600">
                        Call DeplAI from scripts, CI, and internal tools. The token authenticates as you and inherits your
                        organization permissions.
                      </p>
                    </div>
                  </div>

                  <ul className="mt-5 grid gap-2 sm:grid-cols-3">
                    {[
                      'Check credit balance in monitoring',
                      'Trigger scans from GitHub Actions',
                      'Automate project and billing reads',
                    ].map((item) => (
                      <li key={item} className="border-2 border-black bg-white px-3 py-2 text-[12px] text-neutral-700">
                        {item}
                      </li>
                    ))}
                  </ul>

                  <div className="mt-5">
                    <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-neutral-500">Your token</p>
                    {bundle.apiToken.configured || tokenValue ? (
                      <div className="mt-2 border-[3px] border-black bg-neutral-950 px-4 py-3 font-mono text-[12px] leading-relaxed text-emerald-300 break-all">
                        {tokenVisible && tokenValue ? tokenValue : bundle.apiToken.masked || 'dpl_live_••••••••••••••••••••••••'}
                      </div>
                    ) : (
                      <div className="mt-2 border-[3px] border-dashed border-black bg-white px-4 py-5 text-[13px] text-neutral-600">
                        No token yet. Generate one to authenticate API requests from outside the dashboard.
                      </div>
                    )}
                    {tokenFresh && tokenVisible ? (
                      <p className="mt-2 border-2 border-amber-500 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                        Copy this token now. After you hide it, only the masked value is shown again.
                      </p>
                    ) : null}
                    {bundle.apiToken.configured && bundle.apiToken.lastUsedAt ? (
                      <p className="mt-2 text-[12px] text-zinc-500">
                        Last used {new Date(bundle.apiToken.lastUsedAt).toLocaleString()}
                        {bundle.apiToken.lastUsedClient ? ` · ${bundle.apiToken.lastUsedClient}` : ''}
                      </p>
                    ) : bundle.apiToken.configured ? (
                      <p className="mt-2 text-[12px] text-zinc-500">Not used yet — try the example request below.</p>
                    ) : null}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {bundle.apiToken.configured || tokenValue ? (
                      <>
                        <PrimaryButton variant="ghost" loading={tokenBusy} onClick={() => void showToken()}>
                          {tokenVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          {tokenVisible ? 'Hide' : 'Reveal'}
                        </PrimaryButton>
                        <PrimaryButton variant="ghost" disabled={!bundle.apiToken.configured && !tokenValue} onClick={() => void copyToken()}>
                          <Copy className="h-4 w-4" />
                          {copied ? 'Copied' : 'Copy token'}
                        </PrimaryButton>
                        <PrimaryButton variant="danger" onClick={() => setResetOpen(true)}>Rotate token</PrimaryButton>
                      </>
                    ) : (
                      <PrimaryButton loading={tokenBusy} onClick={() => void issueApiToken()}>
                        <KeyRound className="h-4 w-4" />
                        Generate API token
                      </PrimaryButton>
                    )}
                  </div>

                  <div className="mt-6 border-t-2 border-neutral-200 pt-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-neutral-500">Example request</p>
                      <PrimaryButton variant="ghost" className="!px-2 !py-1 text-[11px]" onClick={() => void copyCurlExample()}>
                        <Copy className="h-3.5 w-3.5" />
                        {curlCopied ? 'Copied' : 'Copy curl'}
                      </PrimaryButton>
                    </div>
                    <pre className="mt-2 overflow-x-auto border-[3px] border-black bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-emerald-300 whitespace-pre-wrap">
                      {curlExample}
                    </pre>
                    <p className="mt-3 text-[12px] leading-relaxed text-zinc-500">
                      Send the token in an <code className="font-mono text-[11px]">Authorization: Bearer</code> header or as
                      {' '}<code className="font-mono text-[11px]">X-Api-Key</code>. Store it in a secrets manager or CI variable — never commit it to git.
                    </p>
                  </div>
                </ProfileCard>

                <ProfileCard danger className="p-6">
                  <h2 className="font-display text-lg font-semibold text-rose-900">Danger Zone</h2>
                  <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-neutral-700">
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

      <Dialog open={resetOpen} title="Rotate API token?" onClose={() => setResetOpen(false)}>
        <p className="text-[13px] leading-relaxed text-zinc-600">
          Your current token stops working immediately. Update any scripts, CI jobs, or integrations that use it.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <PrimaryButton variant="ghost" onClick={() => setResetOpen(false)}>Cancel</PrimaryButton>
          <PrimaryButton variant="danger" loading={tokenBusy} onClick={() => void resetToken()}>Rotate token</PrimaryButton>
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
        {deleteBusy ? <p className="mt-3 flex items-center gap-2 text-[13px] text-rose-800"><Loader2 className="h-4 w-4 animate-spin" /> Deleting account...</p> : null}
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

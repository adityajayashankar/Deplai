'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Gift, Mail, MessageCircle, MessageSquare, Send } from 'lucide-react';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import {
  emailShareUrl,
  openShareUrl,
  smsShareUrl,
  telegramShareUrl,
  whatsAppShareUrl,
} from '@/features/referrals/share';

type ReferralProgram = {
  enabled: boolean;
  refereeDiscountPercent: number;
  referrerRewardPercent: number;
  attributionWindowDays: number;
  maxReferralsPerReferrer: number;
  headline: string;
  refereeBenefit: string;
  referrerBenefit: string;
};

type ReferralRow = {
  maskedEmail: string;
  status: 'pending' | 'converted' | 'expired' | 'ineligible';
  attributedAt: string;
  convertedAt: string | null;
  rewardCredits: number | null;
};

type ReferralMe = {
  referralCode: string;
  referralUrl: string;
  shareMessage: string;
  stats: { pending: number; converted: number; creditsEarned: number };
  slots: { used: number; max: number; remaining: number; canShareMore: boolean };
  referrals: ReferralRow[];
  claim: {
    hasClaimed: boolean;
    canClaimMore: boolean;
    status: string | null;
    message: string | null;
  };
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function statusLabel(status: ReferralRow['status']): string {
  switch (status) {
    case 'pending': return 'Pending purchase';
    case 'converted': return 'Converted';
    case 'expired': return 'Expired';
    case 'ineligible': return 'Ineligible';
    default: return status;
  }
}

export default function ReferralsApp() {
  const router = useRouter();
  const [program, setProgram] = useState<ReferralProgram | null>(null);
  const [me, setMe] = useState<ReferralMe | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sessionRes = await fetch('/api/auth/session', { cache: 'no-store' });
        const session = await sessionRes.json().catch(() => null) as { isLoggedIn?: boolean } | null;
        const isLoggedIn = Boolean(session?.isLoggedIn);
        if (cancelled) return;
        setSignedIn(isLoggedIn);

        const [programRes, meRes] = await Promise.all([
          fetch('/api/referrals/program', { cache: 'no-store' }),
          isLoggedIn ? fetch('/api/referrals/me', { cache: 'no-store' }) : Promise.resolve(null),
        ]);
        const programPayload = await programRes.json();
        if (cancelled) return;
        setProgram(programPayload as ReferralProgram);

        if (meRes?.ok) {
          const mePayload = await meRes.json();
          if (!cancelled) setMe(mePayload as ReferralMe);
        } else if (isLoggedIn && !cancelled) {
          setNotice('Could not load your referral details. Refresh the page or sign in again.');
        }
      } catch {
        if (!cancelled) setNotice('Unable to load referral program.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const shareMessage = useMemo(() => {
    if (me?.shareMessage) return me.shareMessage;
    if (!me?.referralCode || !me.referralUrl || !program) return '';
    return [
      `Join me on DeplAI and get ${program.refereeDiscountPercent}% off your first paid plan.`,
      `Use referral code: ${me.referralCode}`,
      `Sign up: ${me.referralUrl}`,
    ].join('\n');
  }, [me, program]);

  const copyText = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(`${label} copied to clipboard.`);
  };

  const shareDisabled = !me?.slots.canShareMore;

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Refer & Earn" onExit={() => router.push('/dashboard')} />
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-5xl space-y-8">
            {loading ? (
              <p className="text-sm text-neutral-500">Loading referral program…</p>
            ) : (
              <>
                <div className="app-paper p-8">
                  <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex min-w-0 flex-1 items-start gap-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center border-[3px] border-black bg-amber-300 shadow-[3px_3px_0_0_#000]">
                        <Gift className="h-6 w-6 text-black" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-500">Refer & earn</p>
                        <h1 className="mt-1 font-display text-3xl font-semibold text-black">{program?.headline || 'Refer friends, earn credits'}</h1>
                        <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-neutral-600">
                          Share your link. Friends get <strong>{program?.refereeBenefit || 'a first-plan discount'}</strong>.
                          You earn <strong>{program?.referrerBenefit || 'credits when they subscribe'}</strong>.
                          Rewards apply only after their first paid plan purchase.
                        </p>
                        {program ? (
                          <p className="mt-3 text-[12px] text-neutral-500">
                            Each account can refer up to <strong>{program.maxReferralsPerReferrer}</strong> friends.
                            Each friend can use only <strong>one</strong> referral code, before their first paid plan.
                          </p>
                        ) : null}
                      </div>
                    </div>

                    {me ? (
                      <div className="w-full shrink-0 lg:w-[280px]">
                        <div className="border-[3px] border-black bg-white p-5 shadow-[6px_6px_0_0_#000]">
                          <p className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">Your referral code</p>
                          <div className="mt-3 flex items-center justify-between gap-3 border-[3px] border-black bg-amber-50 px-4 py-3">
                            <code className="font-mono text-xl font-bold tracking-wide text-black">{me.referralCode}</code>
                            <button
                              type="button"
                              onClick={() => void copyText(me.referralCode, 'Referral code')}
                              className="app-btn-paper px-2 py-2"
                              aria-label="Copy referral code"
                            >
                              <Copy className="h-4 w-4" />
                            </button>
                          </div>
                          <p className="mt-3 text-[12px] text-neutral-600">
                            {me.slots.used}/{me.slots.max} referral slots used
                            {me.slots.canShareMore ? ` · ${me.slots.remaining} remaining` : ' · limit reached'}
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {me ? (
                    <div className="mt-8 space-y-4">
                      <div>
                        <p className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">Share instantly</p>
                        <div className="mt-3 flex flex-wrap gap-3">
                          <button
                            type="button"
                            disabled={shareDisabled}
                            onClick={() => openShareUrl(whatsAppShareUrl(shareMessage))}
                            className="app-btn-ink inline-flex items-center gap-2 disabled:opacity-50"
                          >
                            <MessageCircle className="h-4 w-4" />
                            WhatsApp
                          </button>
                          <button
                            type="button"
                            disabled={shareDisabled}
                            onClick={() => { window.location.href = smsShareUrl(shareMessage); }}
                            className="app-btn-paper inline-flex items-center gap-2 disabled:opacity-50"
                          >
                            <MessageSquare className="h-4 w-4" />
                            SMS
                          </button>
                          <button
                            type="button"
                            disabled={shareDisabled}
                            onClick={() => { window.location.href = emailShareUrl('Join DeplAI with my referral', shareMessage); }}
                            className="app-btn-paper inline-flex items-center gap-2 disabled:opacity-50"
                          >
                            <Mail className="h-4 w-4" />
                            Email
                          </button>
                          <button
                            type="button"
                            disabled={shareDisabled}
                            onClick={() => openShareUrl(telegramShareUrl(shareMessage))}
                            className="app-btn-paper inline-flex items-center gap-2 disabled:opacity-50"
                          >
                            <Send className="h-4 w-4" />
                            Telegram
                          </button>
                          <button
                            type="button"
                            disabled={shareDisabled}
                            onClick={() => void copyText(me.referralUrl, 'Referral link')}
                            className="app-btn-paper inline-flex items-center gap-2 disabled:opacity-50"
                          >
                            <Copy className="h-4 w-4" />
                            Copy link
                          </button>
                          <button
                            type="button"
                            disabled={shareDisabled}
                            onClick={() => void copyText(shareMessage, 'Share message')}
                            className="app-btn-paper inline-flex items-center gap-2 disabled:opacity-50"
                          >
                            <Copy className="h-4 w-4" />
                            Copy message
                          </button>
                        </div>
                        {shareDisabled ? (
                          <p className="mt-2 text-[12px] text-amber-800">
                            You have used all {me.slots.max} referral slots. Existing referrals can still convert.
                          </p>
                        ) : null}
                      </div>

                      <div className="border-[3px] border-dashed border-neutral-300 bg-neutral-50 px-4 py-3 text-[12px] leading-relaxed text-neutral-700 whitespace-pre-wrap">
                        {shareMessage}
                      </div>
                    </div>
                  ) : signedIn === false ? (
                    <p className="mt-6 text-sm text-neutral-600">
                      <button type="button" className="underline" onClick={() => router.push('/api/auth/login')}>
                        Sign in
                      </button>
                      {' '}to view your referral code and earnings.
                    </p>
                  ) : signedIn && !me ? (
                    <p className="mt-6 text-sm text-neutral-600">Loading your referral code…</p>
                  ) : null}

                  {notice ? (
                    <p className="mt-4 border-2 border-black bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">{notice}</p>
                  ) : null}
                </div>

                {me ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-3">
                      {[
                        { label: 'Pending', value: me.stats.pending },
                        { label: 'Converted', value: me.stats.converted },
                        { label: 'Credits earned', value: me.stats.creditsEarned },
                      ].map((stat) => (
                        <div key={stat.label} className="app-paper p-5">
                          <p className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">{stat.label}</p>
                          <p className="mt-2 font-display text-3xl text-black">{stat.value}</p>
                        </div>
                      ))}
                    </div>

                    <div className="app-paper overflow-hidden">
                      <div className="border-b-[3px] border-black px-6 py-4">
                        <h2 className="font-display text-xl text-black">Your referrals</h2>
                        <p className="mt-1 text-[13px] text-neutral-600">
                          Attribution window: {program?.attributionWindowDays || 30} days from signup.
                          {' '}Maximum {program?.maxReferralsPerReferrer || 3} referrals per account.
                        </p>
                      </div>
                      {me.referrals.length === 0 ? (
                        <p className="px-6 py-10 text-center text-sm text-neutral-500">No referrals yet. Share your code to get started.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="min-w-full text-left text-[13px]">
                            <thead className="bg-neutral-50 font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                              <tr>
                                <th className="px-6 py-3">User</th>
                                <th className="px-6 py-3">Status</th>
                                <th className="px-6 py-3">Attributed</th>
                                <th className="px-6 py-3">Converted</th>
                                <th className="px-6 py-3">Reward</th>
                              </tr>
                            </thead>
                            <tbody>
                              {me.referrals.map((row, index) => (
                                <tr key={`${row.maskedEmail}-${index}`} className="border-t border-neutral-200">
                                  <td className="px-6 py-3 font-medium text-black">{row.maskedEmail}</td>
                                  <td className="px-6 py-3">{statusLabel(row.status)}</td>
                                  <td className="px-6 py-3">{formatDate(row.attributedAt)}</td>
                                  <td className="px-6 py-3">{formatDate(row.convertedAt)}</td>
                                  <td className="px-6 py-3">{row.rewardCredits ?? '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

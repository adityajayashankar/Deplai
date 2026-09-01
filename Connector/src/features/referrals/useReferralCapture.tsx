'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

export function useReferralCapture() {
  const searchParams = useSearchParams();
  const [referralBanner, setReferralBanner] = useState<{
    referrerName: string;
    discountPercent: number;
  } | null>(null);

  useEffect(() => {
    const ref = searchParams.get('ref');
    if (!ref) return;
    let cancelled = false;
    void fetch('/api/referrals/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ref }),
    }).then(async (response) => {
      if (!response.ok || cancelled) return;
      const payload = await response.json() as {
        referrerName?: string;
        discountPercent?: number;
      };
      if (cancelled) return;
      if (payload.referrerName && payload.discountPercent) {
        setReferralBanner({
          referrerName: payload.referrerName,
          discountPercent: payload.discountPercent,
        });
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [searchParams]);

  return referralBanner;
}

export function ReferralSignupBanner({
  banner,
}: {
  banner: { referrerName: string; discountPercent: number } | null;
}) {
  if (!banner) return null;
  return (
    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-100">
      Referred by <strong>{banner.referrerName}</strong>. You&apos;ll get{' '}
      <strong>{banner.discountPercent}% off</strong> your first paid plan.
    </div>
  );
}

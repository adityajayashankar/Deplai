import { cookies } from 'next/headers';
import { REFERRAL_COOKIE_MAX_AGE_SECONDS, REFERRAL_COOKIE_NAME } from './config';
import { normalizeReferralCode } from './logic';

export async function readReferralCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(REFERRAL_COOKIE_NAME)?.value || '';
  return normalizeReferralCode(raw);
}

export function referralCookieOptions(code: string) {
  const normalized = normalizeReferralCode(code);
  if (!normalized) return null;
  return {
    name: REFERRAL_COOKIE_NAME,
    value: normalized,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: REFERRAL_COOKIE_MAX_AGE_SECONDS,
  };
}

export async function clearReferralCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(REFERRAL_COOKIE_NAME);
}

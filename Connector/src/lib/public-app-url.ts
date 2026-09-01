import { isInternalHttpOrigin } from '@/lib/agentic-websocket';

/** Canonical production origin for user-facing share links (referrals, invites, etc.). */
export const CANONICAL_APP_ORIGIN = 'https://deplai.in';

/**
 * Returns the public origin to embed in shareable links.
 * Never returns localhost — local dev still uses deplai.in for referral URLs.
 */
export function getShareableAppOrigin(candidate?: string | null): string {
  const canonical = (process.env.NEXT_PUBLIC_CANONICAL_APP_URL || CANONICAL_APP_ORIGIN).replace(/\/$/, '');
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
  if (configured && !isInternalHttpOrigin(configured)) return configured;
  const fromCandidate = candidate?.replace(/\/$/, '');
  if (fromCandidate && !isInternalHttpOrigin(fromCandidate)) return fromCandidate;
  return canonical;
}

export function buildReferralSignupUrl(referralCode: string, origin?: string | null): string {
  return `${getShareableAppOrigin(origin)}/auth/signup?ref=${encodeURIComponent(referralCode)}`;
}

import { createHmac, randomBytes } from 'node:crypto';
import { query } from '@/lib/db';
import { ensureProfileSchema } from '@/lib/profile/schema';

export const REFERRAL_CODE_MAX_LENGTH = 24;
export const REFERRAL_SUFFIX_LENGTH = 6;
export const REFERRAL_TAG_MIN_LENGTH = 3;
export const REFERRAL_TAG_MAX_LENGTH = 10;

const LEGACY_CODE_RE = /^DPL[A-Z0-9]{8}$/;
const MODERN_CODE_RE = /^[A-Z][A-Z0-9]{2,9}-[A-Z0-9]{6}$/;

export type ReferralIdentity = {
  userId: string;
  login?: string;
  displayName?: string;
  email?: string;
};

function referralCodeSecret(): string {
  return process.env.REFERRAL_CODE_SECRET?.trim()
    || process.env.SESSION_SECRET?.trim()
    || 'deplai-referral-dev-only-change-in-production';
}

export function referralTagFromIdentity(input: {
  login?: string;
  displayName?: string;
  email?: string;
}): string {
  const login = String(input.login || '').trim();
  const display = String(input.displayName || '').trim().split(/\s+/).filter(Boolean)[0] || '';
  const emailLocal = String(input.email || '').split('@')[0] || '';
  const raw = login || display || emailLocal || 'USER';
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (cleaned.length >= REFERRAL_TAG_MIN_LENGTH) {
    return cleaned.slice(0, REFERRAL_TAG_MAX_LENGTH);
  }
  return `${cleaned}USR`.slice(0, REFERRAL_TAG_MIN_LENGTH).padEnd(REFERRAL_TAG_MIN_LENGTH, 'X');
}

export function referralSuffixForUser(userId: string, attempt = 0): string {
  const digest = createHmac('sha256', referralCodeSecret())
    .update(`referral:v2:${userId}:${attempt}`)
    .digest('base64url')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase();
  return (digest + '0000000000').slice(0, REFERRAL_SUFFIX_LENGTH);
}

export function generateReferralCode(input: ReferralIdentity & { attempt?: number }): string {
  const tag = referralTagFromIdentity(input);
  const suffix = referralSuffixForUser(input.userId, input.attempt ?? 0);
  return `${tag}-${suffix}`;
}

export function isLegacyReferralCode(code: string): boolean {
  return LEGACY_CODE_RE.test(code);
}

export function isModernReferralCode(code: string): boolean {
  return MODERN_CODE_RE.test(code);
}

export function isRecognizedReferralCode(code: string): boolean {
  return isLegacyReferralCode(code) || isModernReferralCode(code);
}

export function referralCodeNeedsUpgrade(code: string | null | undefined): boolean {
  if (!code) return true;
  return isLegacyReferralCode(code) || !isModernReferralCode(code);
}

export function verifyReferralCodeMatchesUser(code: string, userId: string): boolean {
  if (!isModernReferralCode(code)) return false;
  const suffix = code.split('-')[1] || '';
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (referralSuffixForUser(userId, attempt) === suffix) return true;
  }
  return false;
}

async function referralCodeTaken(code: string, excludeUserId?: string): Promise<boolean> {
  const rows = await query<Array<{ user_id: string }>>(
    `SELECT user_id FROM user_profiles WHERE referral_code = ? LIMIT 1`,
    [code],
  );
  const row = rows[0];
  if (!row) return false;
  if (excludeUserId && row.user_id === excludeUserId) return false;
  return true;
}

export async function allocateUniqueReferralCode(input: ReferralIdentity): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = generateReferralCode({ ...input, attempt });
    if (!(await referralCodeTaken(code))) return code;
  }
  const tag = referralTagFromIdentity(input);
  const entropy = randomBytes(4).toString('hex').toUpperCase();
  const fallback = `${tag}-${entropy}`.slice(0, REFERRAL_CODE_MAX_LENGTH);
  if (!(await referralCodeTaken(fallback))) return fallback;
  throw new Error('Unable to allocate a unique referral code');
}

export async function ensureUserReferralCode(input: ReferralIdentity): Promise<string> {
  await ensureProfileSchema();
  const rows = await query<Array<{ referral_code: string }>>(
    `SELECT referral_code FROM user_profiles WHERE user_id = ? LIMIT 1`,
    [input.userId],
  );
  const existing = rows[0]?.referral_code || '';
  if (existing && isModernReferralCode(existing) && verifyReferralCodeMatchesUser(existing, input.userId)) {
    return existing;
  }
  const code = await allocateUniqueReferralCode(input);
  await query(
    `UPDATE user_profiles SET referral_code = ? WHERE user_id = ?`,
    [code, input.userId],
  );
  return code;
}

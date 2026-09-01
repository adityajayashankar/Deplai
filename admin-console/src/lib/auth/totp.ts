import { Secret, TOTP } from 'otpauth';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { getAdminConfig } from '@/lib/config';

/** Base32 secret compatible with Google Authenticator manual entry and QR scanning. */
export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function buildTotpUri(email: string, secret: string): string {
  const config = getAdminConfig();
  const totp = new TOTP({
    issuer: config.webauthnRpName,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: totpSecretKey(secret),
  });
  return totp.toString();
}

function totpSecretKey(secret: string): Secret | string {
  const normalized = secret.replace(/\s/g, '');
  // Standard authenticator apps expect Base32 (A-Z, 2-7).
  if (/^[A-Za-z2-7]+=*$/.test(normalized) && !normalized.includes('_') && !normalized.includes('-')) {
    return Secret.fromBase32(normalized.toUpperCase());
  }
  // Legacy bootstrap secrets used base64url before Base32 migration.
  return normalized;
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const totp = new TOTP({
    secret: totpSecretKey(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  const delta = totp.validate({ token: normalized, window: 1 });
  return delta !== null;
}

export function encryptTotpSecret(secret: string): string {
  return encryptSecret(secret, getAdminConfig().mfaEncryptionKey);
}

export function decryptTotpSecret(encrypted: string): string {
  return decryptSecret(encrypted, getAdminConfig().mfaEncryptionKey);
}

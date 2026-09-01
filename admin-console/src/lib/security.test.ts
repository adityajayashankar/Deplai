import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, validatePasswordStrength, verifyPassword } from '@/lib/auth/password';
import { hashRecoveryCode, hashToken, randomToken } from '@/lib/crypto';
import { ownerHasPermission, requiresStepUp } from '@/lib/authorization/permissions';
import { generateTotpSecret } from '@/lib/auth/totp';
import { TOTP } from 'otpauth';

function verifyTotpCode(secret: string, code: string): boolean {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const totp = new TOTP({ secret, algorithm: 'SHA1', digits: 6, period: 30 });
  return totp.validate({ token: normalized, window: 1 }) !== null;
}

test('password hashing uses Argon2id and verifies', async () => {
  const hash = await hashPassword('StrongPass!123456');
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await verifyPassword('StrongPass!123456', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
});

test('password strength validation rejects weak passwords', () => {
  assert.equal(validatePasswordStrength('short'), 'Password must be at least 16 characters');
  assert.equal(validatePasswordStrength('longpasswordonly1!'), 'Password must include an uppercase letter');
  assert.equal(validatePasswordStrength('StrongPass!123456'), null);
});

test('token hashing is deterministic', () => {
  assert.equal(hashToken('abc'), hashToken('abc'));
  assert.notEqual(hashToken('abc'), hashToken('def'));
  assert.equal(randomToken().length > 20, true);
});

test('recovery code hashing normalizes case', () => {
  assert.equal(hashRecoveryCode('abcd'), hashRecoveryCode('ABCD'));
});

test('generated totp secrets are base32 and long enough for google authenticator', () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.ok(secret.length >= 16);
});

test('totp verification accepts valid codes from secret', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const totp = new TOTP({ secret, algorithm: 'SHA1', digits: 6, period: 30 });
  const token = totp.generate();
  assert.equal(verifyTotpCode(secret, token), true);
  assert.equal(verifyTotpCode(secret, '000000'), false);
});

test('owner has all admin permissions and refund requires step-up', () => {
  assert.equal(ownerHasPermission('ADMIN_REFUND_CREATE'), true);
  assert.equal(requiresStepUp('refund.create'), true);
});

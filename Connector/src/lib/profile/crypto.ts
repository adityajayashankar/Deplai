import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

function secretMaterial(): string {
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (sessionSecret) return sessionSecret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Missing required environment variable: SESSION_SECRET');
  }
  return 'deplai-local-dev-session-secret-2026-fallback';
}

function tokenKey(): Buffer {
  return createHash('sha256').update(`${secretMaterial()}:user-api-token`).digest();
}

export function generateApiToken(): string {
  return `dpl_live_${randomBytes(24).toString('hex')}`;
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function encryptApiToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptApiToken(payload: string): string {
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length < 29) throw new Error('Invalid token payload');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', tokenKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function tokenDigestEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type InvitationStateInput = {
  token: string;
  tokenHash: string;
  invitedEmail: string;
  acceptingEmail: string;
  expiresAt: Date | string;
  acceptedAt?: Date | string | null;
  revokedAt?: Date | string | null;
  now?: Date;
};

export type InvitationDecision =
  | 'VALID'
  | 'TAMPERED'
  | 'WRONG_EMAIL'
  | 'EXPIRED'
  | 'ACCEPTED'
  | 'REVOKED';

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
}

function constantTimeHashEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function evaluateInvitation(input: InvitationStateInput): InvitationDecision {
  if (input.revokedAt) return 'REVOKED';
  if (input.acceptedAt) return 'ACCEPTED';
  if (new Date(input.expiresAt).getTime() <= (input.now || new Date()).getTime()) return 'EXPIRED';
  const presentedHash = hashInvitationToken(String(input.token || ''));
  if (!constantTimeHashEquals(presentedHash, String(input.tokenHash || ''))) return 'TAMPERED';
  if (input.invitedEmail.trim().toLowerCase() !== input.acceptingEmail.trim().toLowerCase()) return 'WRONG_EMAIL';
  return 'VALID';
}

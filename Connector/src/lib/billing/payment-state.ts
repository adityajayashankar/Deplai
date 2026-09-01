export type PaymentState =
  | 'created'
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'refund_pending'
  | 'partially_refunded'
  | 'refunded';

const TRANSITIONS: Record<PaymentState, ReadonlySet<PaymentState>> = {
  created: new Set(['pending', 'authorized', 'captured', 'failed']),
  pending: new Set(['authorized', 'captured', 'failed']),
  authorized: new Set(['captured', 'failed']),
  // An order may receive a failed attempt followed by a different successful
  // attempt. A captured intent can only move forward into refund states.
  failed: new Set(['pending', 'authorized', 'captured']),
  captured: new Set(['refund_pending', 'partially_refunded', 'refunded']),
  refund_pending: new Set(['captured', 'partially_refunded', 'refunded']),
  partially_refunded: new Set(['refund_pending', 'refunded']),
  refunded: new Set(),
};

export function normalizePaymentState(value: string | null | undefined): PaymentState {
  const state = String(value || '').trim().toLowerCase();
  if (state === 'paid') return 'captured';
  if (state in TRANSITIONS) return state as PaymentState;
  return 'created';
}

export function canTransitionPaymentState(current: string, next: PaymentState): boolean {
  const normalized = normalizePaymentState(current);
  return normalized === next || TRANSITIONS[normalized].has(next);
}

export function isConfirmedPaymentState(value: string | null | undefined): boolean {
  const state = normalizePaymentState(value);
  return state === 'captured' || state === 'refund_pending' || state === 'partially_refunded' || state === 'refunded';
}

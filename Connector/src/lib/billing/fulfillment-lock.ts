import { withNamedLock } from '@/lib/db';

export const FULFILL_LOCK_TIMEOUT_SEC = Math.max(
  5,
  Number(process.env.BILLING_FULFILL_LOCK_TIMEOUT_SEC || 15) || 15,
);

export function fulfillLockName(paymentId: string): string {
  return `fulfill:${paymentId}`.slice(0, 64);
}

export async function withPaymentLock<T>(paymentId: string, work: () => Promise<T>): Promise<T> {
  return withNamedLock(fulfillLockName(paymentId), FULFILL_LOCK_TIMEOUT_SEC, work);
}

export function createInMemoryPaymentLock(): {
  withPaymentLock: <T>(paymentId: string, work: () => Promise<T>) => Promise<T>;
} {
  const tails = new Map<string, Promise<void>>();
  return {
    async withPaymentLock<T>(paymentId: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(paymentId) || Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(paymentId, previous.then(() => gate));
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

'use client';

export type RazorpayCheckoutPayload = {
  key_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { name?: string; email?: string };
  notes?: Record<string, string>;
  order_id: string;
  payment_id: string;
  intent_id: string;
  mode: 'test' | 'live';
  test_charge: boolean;
};

export type VerifiedPayment = {
  invoice_id: string;
  invoice_number: string;
};

export type CheckoutPhase = 'checkout' | 'verifying' | 'pending' | 'confirmed' | 'failed' | 'cancelled';

type RazorpayHandlerResponse = {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  razorpay_signature: string;
};

type RazorpayCheckoutInstance = {
  open: () => void;
  on: (event: 'payment.failed', handler: (response: { error?: { description?: string; reason?: string } }) => void) => void;
};

type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayCheckoutInstance;

function razorpayCtor(): RazorpayConstructor | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { Razorpay?: RazorpayConstructor }).Razorpay || null;
}

function loadCheckoutScript(): Promise<RazorpayConstructor> {
  const existing = razorpayCtor();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const src = 'https://checkout.razorpay.com/v1/checkout.js';
    const found = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    const script = found || document.createElement('script');
    script.src = src;
    script.async = true;
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.onload = () => {
      const ctor = razorpayCtor();
      if (ctor) resolve(ctor);
      else reject(new Error('Secure checkout did not initialize'));
    };
    script.onerror = () => reject(new Error('Secure checkout could not be loaded'));
    if (!found) document.body.appendChild(script);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function pollCanonicalStatus(paymentId: string): Promise<
  | { status: 'paid'; invoice: VerifiedPayment }
  | { status: 'failed'; message: string }
  | { status: 'pending'; message: string }
> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) await wait(1_500);
    const response = await fetch(`/api/billing/payments/${encodeURIComponent(paymentId)}/status`, {
      cache: 'no-store',
    }).catch(() => null);
    if (!response) continue;
    const payload = await response.json().catch(() => ({})) as {
      status?: string;
      confirmed?: boolean;
      invoice?: VerifiedPayment | null;
      error?: string;
    };
    if (response.ok && payload.confirmed && payload.invoice) {
      return { status: 'paid', invoice: payload.invoice };
    }
    if (payload.status === 'failed') {
      return { status: 'failed', message: 'Payment failed. No access was activated.' };
    }
  }
  return {
    status: 'pending',
    message: 'Payment is still being confirmed. No access has been activated yet.',
  };
}

export function useRazorpayCheckout() {
  const start = async (
    session: RazorpayCheckoutPayload,
    onPhase?: (phase: CheckoutPhase) => void,
  ): Promise<
    | { status: 'paid'; invoice: VerifiedPayment }
    | { status: 'cancelled' }
    | { status: 'pending'; message: string }
    | { status: 'failed'; message: string }
  > => {
    let Razorpay: RazorpayConstructor;
    try {
      Razorpay = await loadCheckoutScript();
    } catch (error) {
      onPhase?.('failed');
      return { status: 'failed', message: error instanceof Error ? error.message : 'Secure checkout could not be loaded' };
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Awaited<ReturnType<typeof start>>) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const options: Record<string, unknown> = {
        key: session.key_id,
        order_id: session.order_id,
        amount: session.amount,
        currency: session.currency,
        name: session.name,
        description: session.description,
        prefill: session.prefill,
        notes: session.notes,
        theme: { color: '#111111' },
        handler: async (response: RazorpayHandlerResponse) => {
          onPhase?.('verifying');
          try {
            const verify = await fetch('/api/verify-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                payment_id: session.payment_id,
                razorpay_order_id: response.razorpay_order_id || session.order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });
            const payload = await verify.json().catch(() => ({})) as {
              pending?: boolean;
              invoice_id?: string;
              invoice_number?: string;
              error?: string;
            };
            if (verify.ok && payload.invoice_id && payload.invoice_number) {
              onPhase?.('confirmed');
              finish({
                status: 'paid',
                invoice: { invoice_id: payload.invoice_id, invoice_number: payload.invoice_number },
              });
              return;
            }
            if (verify.status === 202 || payload.pending) {
              onPhase?.('pending');
              const result = await pollCanonicalStatus(session.payment_id);
              onPhase?.(result.status === 'paid' ? 'confirmed' : result.status);
              finish(result);
              return;
            }
            onPhase?.('failed');
            finish({
              status: 'failed',
              message: payload.error || 'We could not confirm the payment. No access has been activated yet.',
            });
          } catch {
            onPhase?.('pending');
            const result = await pollCanonicalStatus(session.payment_id);
            onPhase?.(result.status === 'paid' ? 'confirmed' : result.status);
            finish(result);
          }
        },
        modal: {
          ondismiss: () => {
            onPhase?.('cancelled');
            finish({ status: 'cancelled' });
          },
        },
      };

      const checkout = new Razorpay(options);
      checkout.on('payment.failed', (response) => {
        onPhase?.('failed');
        finish({
          status: 'failed',
          message: response.error?.description || response.error?.reason || 'Payment failed',
        });
      });
      onPhase?.('checkout');
      checkout.open();
    });
  };

  return { start };
}

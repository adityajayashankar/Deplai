'use client';

export type RazorpayCheckoutPayload = {
  key_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { name?: string; email?: string };
  notes?: Record<string, string>;
  order_id?: string;
  subscription_id?: string;
};

export type VerifiedPayment = {
  invoice_id: string;
  invoice_number: string;
};

type RazorpayHandlerResponse = {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
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
    script.onload = () => {
      const ctor = razorpayCtor();
      if (ctor) resolve(ctor);
      else reject(new Error('Razorpay checkout did not initialize'));
    };
    script.onerror = () => reject(new Error('Failed to load Razorpay checkout'));
    if (!found) document.body.appendChild(script);
  });
}

export function useRazorpayCheckout() {
  const start = async (session: RazorpayCheckoutPayload): Promise<
    | { status: 'paid'; invoice: VerifiedPayment }
    | { status: 'cancelled' }
    | { status: 'failed'; message: string }
  > => {
    const Razorpay = await loadCheckoutScript();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Awaited<ReturnType<typeof start>>) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const options: Record<string, unknown> = {
        key: session.key_id,
        amount: session.amount,
        currency: session.currency,
        name: session.name,
        description: session.description,
        prefill: session.prefill,
        notes: session.notes,
        theme: { color: '#3b82f6' },
        handler: async (response: RazorpayHandlerResponse) => {
          try {
            const verify = await fetch('/api/verify-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id || session.order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_subscription_id: response.razorpay_subscription_id || session.subscription_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });
            const payload = await verify.json() as { invoice_id?: string; invoice_number?: string; error?: string };
            if (!verify.ok || !payload.invoice_id || !payload.invoice_number) {
              finish({ status: 'failed', message: payload.error || 'Payment verification failed' });
              return;
            }
            finish({
              status: 'paid',
              invoice: { invoice_id: payload.invoice_id, invoice_number: payload.invoice_number },
            });
          } catch (error) {
            finish({
              status: 'failed',
              message: error instanceof Error ? error.message : 'Payment verification failed',
            });
          }
        },
        modal: {
          ondismiss: () => finish({ status: 'cancelled' }),
        },
      };
      if (session.order_id) options.order_id = session.order_id;
      if (session.subscription_id) options.subscription_id = session.subscription_id;

      const checkout = new Razorpay(options);

      checkout.on('payment.failed', (response) => {
        finish({
          status: 'failed',
          message: response.error?.description || response.error?.reason || 'Payment failed',
        });
      });
      checkout.open();
    });
  };

  return { start };
}

import { Suspense } from 'react';
import PaymentApp from '@/features/billing/PaymentApp';

export default function DashboardBillingPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-neutral-600">Loading billing…</div>}>
      <PaymentApp />
    </Suspense>
  );
}

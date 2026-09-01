'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { adminFetch } from '@/lib/admin-api';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    adminFetch<{ authenticated: boolean; mfaVerified?: boolean }>('/api/auth/step-up')
      .then((data) => {
        if (!data.authenticated || !data.mfaVerified) {
          router.replace('/login');
          return;
        }
        setReady(true);
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted">
        Verifying owner session...
      </div>
    );
  }

  return <>{children}</>;
}

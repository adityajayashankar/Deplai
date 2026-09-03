'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { adminFetch } from '@/lib/admin-api';

let cachedVerifiedAt = 0;
const AUTH_CACHE_TTL_MS = 60_000;

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(() => Date.now() - cachedVerifiedAt < AUTH_CACHE_TTL_MS);

  useEffect(() => {
    adminFetch<{ authenticated: boolean; mfaVerified?: boolean }>('/api/auth/step-up')
      .then((data) => {
        if (!data.authenticated || !data.mfaVerified) {
          cachedVerifiedAt = 0;
          router.replace('/login');
          return;
        }
        cachedVerifiedAt = Date.now();
        setReady(true);
      })
      .catch(() => {
        cachedVerifiedAt = 0;
        router.replace('/login');
      });
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

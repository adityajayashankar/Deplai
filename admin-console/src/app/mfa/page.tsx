import { Suspense } from 'react';
import MfaPage from './MfaPage';

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-muted">Loading...</div>}>
      <MfaPage />
    </Suspense>
  );
}

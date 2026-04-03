'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/deplai-gitapp-aj/installations/new';

export default function DashboardProjectsRedirectPage() {
  const router = useRouter();
  const [popupBlocked, setPopupBlocked] = useState(false);

  useEffect(() => {
    const opened = window.open(GITHUB_APP_INSTALL_URL, '_blank', 'noopener,noreferrer');
    if (opened) {
      router.replace('/dashboard');
      return;
    }
    setPopupBlocked(true);
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#050505] px-6 text-zinc-100">
      <div className="w-full max-w-md rounded-xl border border-[#1A1A1A] bg-[#0A0A0A] p-6">
        <h1 className="text-lg font-semibold">Open GitHub Installation Settings</h1>
        <p className="mt-2 text-sm text-zinc-400">
          {popupBlocked
            ? 'Your browser blocked opening GitHub in a new tab. Use the button below, then return to Dashboard.'
            : 'Opening GitHub in a new tab...'}
        </p>
        <div className="mt-5 flex gap-3">
          <a
            href={GITHUB_APP_INSTALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-[#262626] bg-[#111111] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1A1A1A]"
          >
            Open GitHub
          </a>
          <button
            onClick={() => router.push('/dashboard')}
            className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-semibold text-black hover:bg-white"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    </main>
  );
}

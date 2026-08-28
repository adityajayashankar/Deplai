'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot } from 'lucide-react';
import { SELECTED_PROJECT_STORAGE_KEY } from '@/features/deployment/state';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { appBtnInk, appBtnPaper, appPaper } from '@/features/workspace/theme';

export default function CodeReviewerComingSoonApp() {
  const router = useRouter();
  const [securityHref, setSecurityHref] = useState('/dashboard');

  useEffect(() => {
    const projectId = window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY) || '';
    setSecurityHref(projectId ? `/dashboard/security-analysis/${encodeURIComponent(projectId)}` : '/dashboard');
  }, []);

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Code Reviewer" onExit={() => router.push('/dashboard')} />
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-2xl">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Services</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-black">Code Reviewer</h2>
              <span className="border-[3px] border-black bg-black px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white">
                Coming soon
              </span>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
              Pull-request review is not available in this build. You cannot start a Code Reviewer run yet.
            </p>

            <section className={`${appPaper} mt-8 space-y-4 p-6`}>
              <Bot className="h-5 w-5" />
              <h3 className="font-display text-lg text-black">What this agent will do</h3>
              <p className="text-[13px] leading-relaxed text-neutral-600">
                When it ships, Code Reviewer will comment on diffs for the selected project. Those runs will show up in Sessions, same as Security Agent, UI/UX, and Deploy.
              </p>
              <p className="text-[13px] leading-relaxed text-neutral-600">
                Until then, use Security Agent for SAST/SCA findings and proposed fixes, and GitHub’s own review on pull requests from GitHub &amp; verify.
              </p>
              <div className="flex flex-wrap gap-3 pt-2">
                <button type="button" onClick={() => router.push(securityHref)} className={appBtnInk}>
                  Open Security Agent
                </button>
                <button type="button" onClick={() => router.push('/dashboard/sessions')} className={appBtnPaper}>
                  Open Sessions
                </button>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

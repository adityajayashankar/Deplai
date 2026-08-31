'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Building2 } from 'lucide-react';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { appBtnInk, appBtnPaper, appPaper } from '@/features/workspace/theme';

export default function OrganizationsComingSoonApp() {
  const router = useRouter();

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Organizations" onExit={() => router.push('/dashboard')} />
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-2xl">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Dashboard</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-black">Organizations</h2>
              <span className="border-[3px] border-black bg-black px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white">
                Coming soon
              </span>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
              Team workspaces, shared projects, and org-level billing are not available in this build yet.
            </p>

            <section className={`${appPaper} mt-8 space-y-4 p-6`}>
              <Building2 className="h-5 w-5" />
              <h3 className="font-display text-lg text-black">What&apos;s planned</h3>
              <p className="text-[13px] leading-relaxed text-neutral-600">
                Organizations will let you invite teammates, share deployment workspaces, and manage access across projects from one place.
              </p>
              <p className="text-[13px] leading-relaxed text-neutral-600">
                Until then, use your personal workspace and GitHub organization installs under Integrations to connect repos owned by a GitHub org.
              </p>
              <div className="flex flex-wrap gap-3 pt-2">
                <button type="button" onClick={() => router.push('/dashboard/integrations')} className={appBtnInk}>
                  Open Integrations
                </button>
                <button type="button" onClick={() => router.push('/dashboard/projects')} className={appBtnPaper}>
                  Manage projects
                </button>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

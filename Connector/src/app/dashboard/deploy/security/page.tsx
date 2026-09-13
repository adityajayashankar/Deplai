'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { appBtnInk, appBtnPaper, appPaper } from '@/features/workspace/theme';

export default function PostDeploymentSecurityPage() {
  const router = useRouter();
  const [projectId, setProjectId] = useState('');
  useEffect(() => {
    setProjectId(new URLSearchParams(window.location.search).get('projectId') || '');
  }, []);
  const query = new URLSearchParams({ projectId, source: 'post-deployment' }).toString();
  return (
    <main className="flex h-full flex-col">
      <WorkspaceCommandHeader section="Post-deployment security" onExit={() => router.push(`/dashboard/deploy?projectId=${encodeURIComponent(projectId)}`)} />
      <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-3xl space-y-6">
          <h1 className="font-display text-3xl font-semibold">Check your deployed application</h1>
          <p>Review the live application and its AWS configuration. These checks cover runtime DAST and cloud posture only.</p>
          <section className={`${appPaper} space-y-4 p-6`}>
            <h2 className="text-xl font-semibold">Application security · OWASP ZAP</h2>
            <p>Select and verify the deployed host, then review the testing scope before starting.</p>
            <button disabled={!projectId} className={appBtnInk} onClick={() => router.push(`/dashboard/dast?${query}`)}>Configure runtime scan</button>
          </section>
          <section className={`${appPaper} space-y-4 p-6`}>
            <h2 className="text-xl font-semibold">AWS security · Prowler</h2>
            <p>Check the deployed account and region using authorized AWS credentials.</p>
            <button disabled={!projectId} className={appBtnInk} onClick={() => router.push(`/dashboard/cloud?${query}`)}>Configure AWS posture scan</button>
          </section>
          {!projectId && <p>Select a deployment to continue.</p>}
          <button className={appBtnPaper} onClick={() => router.push(`/dashboard/deploy?projectId=${encodeURIComponent(projectId)}`)}>Return to endpoints and deployment management</button>
        </div>
      </div>
    </main>
  );
}

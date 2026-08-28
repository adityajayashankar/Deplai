'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CloudCog } from 'lucide-react';
import {
  DEFAULT_AWS_REGION,
  SELECTED_PROJECT_STORAGE_KEY,
  projectHasSuccessfulDeploy,
  readSavedAws,
  writeSavedAws,
} from '@/features/deployment/state';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { appBtnInk, appBtnPaper, appInput, appPaper } from '@/features/workspace/theme';

export default function DashboardCloudPage() {
  const router = useRouter();
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [region, setRegion] = useState(DEFAULT_AWS_REGION);

  useEffect(() => {
    const stored = window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY) || '';
    setProjectId(stored);
    const saved = readSavedAws();
    if (saved.aws_access_key_id) setAccessKey(saved.aws_access_key_id);
    if (saved.aws_secret_access_key) setSecretKey(saved.aws_secret_access_key);
    if (saved.aws_session_token) setSessionToken(saved.aws_session_token);
    if (saved.aws_region) setRegion(saved.aws_region);
    void fetch('/api/projects', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        const rows = Array.isArray(data?.projects) ? data.projects : [];
        setProjects(rows.map((item: { id: string; name?: string }) => ({ id: item.id, name: item.name || item.id })));
      })
      .catch(() => setProjects([]));
  }, []);

  const deployed = useMemo(() => (projectId ? projectHasSuccessfulDeploy(projectId) : false), [projectId]);
  const canStart = Boolean(projectId && deployed && accessKey.trim() && secretKey.trim());

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Cloud Security" onExit={() => router.push('/dashboard')} />
        <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-2xl">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">Security Pipeline</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-black">Cloud</h2>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
              Live AWS account scanning runs after IaC is configured and deployed for the selected project. This uses the same operator credentials as Deploy and does not invent findings.
            </p>

            <section className={`${appPaper} mt-8 space-y-4 p-6`}>
              <CloudCog className="h-5 w-5" />
              <h3 className="font-display text-lg text-black">Authorized AWS account</h3>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                Project
                <select
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                  className={`mt-2 ${appInput}`}
                >
                  <option value="">Select a project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </label>
              {!deployed && projectId ? (
                <p className="text-sm text-neutral-600">
                  Deploy this project first. Cloud scanning needs a completed IaC apply so it can inspect the live account in that region.
                </p>
              ) : null}
              <label className="block text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                Access key
                <input value={accessKey} onChange={(event) => setAccessKey(event.target.value)} className={`mt-2 ${appInput}`} autoComplete="off" />
              </label>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                Secret key
                <input type="password" value={secretKey} onChange={(event) => setSecretKey(event.target.value)} className={`mt-2 ${appInput}`} autoComplete="off" />
              </label>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                Session token
                <input value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} placeholder="Required for ASIA keys" className={`mt-2 ${appInput}`} autoComplete="off" />
              </label>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                Region
                <input value={region} onChange={(event) => setRegion(event.target.value)} className={`mt-2 ${appInput}`} />
              </label>
              <div className="flex flex-wrap gap-3">
                {!deployed && projectId ? (
                  <button
                    type="button"
                    onClick={() => router.push(`/dashboard/deploy?projectId=${encodeURIComponent(projectId)}`)}
                    className={appBtnPaper}
                  >
                    Open Deploy
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={!canStart}
                  onClick={() => {
                    writeSavedAws({
                      aws_access_key_id: accessKey.trim(),
                      aws_secret_access_key: secretKey.trim(),
                      aws_session_token: sessionToken.trim(),
                      aws_region: region.trim() || DEFAULT_AWS_REGION,
                    });
                    const query = new URLSearchParams({
                      surface: 'cloud',
                      run: 'cloud',
                    });
                    router.push(`/dashboard/security-analysis/${encodeURIComponent(projectId)}?${query.toString()}`);
                  }}
                  className={appBtnInk}
                >
                  Run cloud scan
                </button>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

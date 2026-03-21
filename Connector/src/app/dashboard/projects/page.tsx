'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import Projects from '../dashboardpages/projects';
import { PopupProvider, usePopup } from '@/components/popup';
import { useScan } from '@/lib/scan-context';

interface SessionUser {
  login: string;
  name: string;
  avatarUrl: string;
}

interface ProjectItem {
  id: string;
  name?: string;
  repo?: string;
  owner?: string;
  installationId?: string;
  type: 'local' | 'github';
}

interface ProjectsStats {
  localCount: number;
  githubCount: number;
  totalCount: number;
}

interface InstallationsResponse {
  installations?: unknown[];
  error?: string;
}

interface ProjectsResponse {
  projects?: ProjectItem[];
  stats?: ProjectsStats;
  error?: string;
}

function DeplaiMark() {
  return (
    <svg viewBox="0 0 28 28" className="w-5 h-5" fill="none" aria-hidden="true">
      <polygon points="14,2 25,8 25,20 14,26 3,20 3,8" stroke="currentColor" strokeWidth="1.5" className="text-cyan-300" />
      <circle cx="14" cy="14" r="3" fill="currentColor" className="text-cyan-300" />
    </svg>
  );
}

export default function ProjectsPage() {
  return (
    <PopupProvider>
      <ProjectsPageContent />
    </PopupProvider>
  );
}

function ProjectsPageContent() {
  const router = useRouter();
  const { showPopup } = usePopup();
  const { startScan, activeScanIds, activeRemediationIds } = useScan();

  const [user, setUser] = useState<SessionUser | null>(null);
  const [installations, setInstallations] = useState<unknown[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [stats, setStats] = useState<ProjectsStats>({ localCount: 0, githubCount: 0, totalCount: 0 });
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshProjects = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    try {
      const [installRes, projectsRes] = await Promise.all([
        fetch('/api/installations'),
        fetch('/api/projects'),
      ]);

      const installData = await installRes.json() as InstallationsResponse;
      const projectData = await projectsRes.json() as ProjectsResponse;

      if (!installRes.ok) throw new Error(installData.error || 'Failed to load installations');
      if (!projectsRes.ok) throw new Error(projectData.error || 'Failed to load projects');

      setInstallations(Array.isArray(installData.installations) ? installData.installations : []);
      setProjects(Array.isArray(projectData.projects) ? projectData.projects : []);
      setStats(projectData.stats || { localCount: 0, githubCount: 0, totalCount: 0 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load projects';
      showPopup({ type: 'error', message });
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [showPopup]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const sessionRes = await fetch('/api/auth/session');
        const session = await sessionRes.json();
        if (!session?.isLoggedIn) {
          router.push('/');
          return;
        }

        if (!cancelled && session.user) {
          setUser({
            login: session.user.login,
            name: session.user.name,
            avatarUrl: session.user.avatarUrl,
          });
        }
      } catch {
        router.push('/');
        return;
      }

      if (!cancelled) {
        await refreshProjects(true);
      }
    }

    bootstrap();
    return () => { cancelled = true; };
  }, [refreshProjects, router]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.zip')) {
      showPopup({ type: 'error', message: 'Please upload a .zip file.' });
      return;
    }

    const projectName = window.prompt('Enter project name');
    if (!projectName?.trim()) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', projectName.trim());

      const response = await fetch('/api/projects/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json() as { error?: string };

      if (!response.ok) throw new Error(data.error || 'Upload failed');
      showPopup({ type: 'success', message: `Uploaded "${projectName.trim()}"` });
      await refreshProjects(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed';
      showPopup({ type: 'error', message });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteProject = async (projectId: string, projectName: string, projectType?: string) => {
    const label = projectType === 'github'
      ? `Remove "${projectName}" from DeplAI?`
      : `Delete local project "${projectName}"?`;
    if (!window.confirm(label)) return;

    try {
      const endpoint = projectType === 'github'
        ? `/api/repositories/${encodeURIComponent(projectId)}`
        : `/api/projects/${encodeURIComponent(projectId)}`;

      const response = await fetch(endpoint, { method: 'DELETE' });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Delete failed');

      showPopup({ type: 'success', message: `"${projectName}" removed` });
      await refreshProjects(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Delete failed';
      showPopup({ type: 'error', message });
    }
  };

  const handleProjectClick = (project: ProjectItem) => {
    if (project.type === 'local') {
      router.push(`/dashboard/codeview?project_id=${encodeURIComponent(project.id)}&type=local`);
      return;
    }

    if (!project.owner || !project.repo) {
      showPopup({ type: 'warning', message: 'Repository metadata is incomplete. Sync and try again.' });
      return;
    }

    router.push(
      `/dashboard/codeview?owner=${encodeURIComponent(project.owner)}&repo=${encodeURIComponent(project.repo)}&type=github`,
    );
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="h-14 border-b border-white/5 bg-zinc-950/80 backdrop-blur-md px-5 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-4">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-cyan-300">
            <DeplaiMark />
          </div>
          <span className="font-bold tracking-wide text-lg">DeplAI</span>
          <div className="flex items-center gap-1">
            <Link
              href="/dashboard/pipeline"
              className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-zinc-900 border border-white/10 text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              Pipeline
            </Link>
            <Link
              href="/dashboard/projects"
              className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-cyan-500/15 border border-cyan-400/30 text-cyan-200"
            >
              Projects
            </Link>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="https://github.com/apps/deplai-gitapp-aj/installations/new"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline-flex items-center text-zinc-100 bg-cyan-500/15 hover:bg-cyan-500/25 px-3 py-1.5 rounded-md border border-cyan-400/30 text-xs font-semibold tracking-wide transition-colors shadow-sm"
          >
            Install GitHub App
          </a>
          {user && (
            <a
              href={`https://github.com/${user.login}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-full pl-1 pr-3 py-1 hover:bg-white/10 hover:border-white/20 transition-colors"
            >
              {user.avatarUrl ? (
                <Image
                  src={user.avatarUrl}
                  alt={user.name || user.login}
                  width={24}
                  height={24}
                  className="w-6 h-6 rounded-full ring-1 ring-white/20"
                />
              ) : (
                <div className="w-6 h-6 rounded-full bg-cyan-500/25 flex items-center justify-center text-xs font-bold text-cyan-200">
                  {(user.name || user.login || '?')[0]?.toUpperCase()}
                </div>
              )}
              <span className="text-xs font-medium text-zinc-200">{user.name || user.login}</span>
            </a>
          )}
        </div>
      </header>

      <Projects
        user={user}
        installations={installations}
        projects={projects}
        stats={stats}
        loading={loading}
        uploading={uploading}
        fileInputRef={fileInputRef}
        handleFileUpload={handleFileUpload}
        handleDeleteProject={handleDeleteProject}
        handleProjectClick={handleProjectClick}
        startScan={startScan}
        activeScanIds={activeScanIds}
        activeRemediationIds={activeRemediationIds}
      />
    </div>
  );
}

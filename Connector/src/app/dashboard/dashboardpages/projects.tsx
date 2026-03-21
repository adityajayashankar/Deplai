'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import LoadingSpinner from '@/components/loading-spinner';
import ScanModal from '@/components/scan-card';
import GradientText from '@/components/GradientText';
import { usePopup } from '@/components/popup';
import {
  FiRefreshCw, FiTrash2, FiSearch, FiGithub, FiFolder,
  FiUpload, FiShield, FiChevronLeft, FiChevronRight,
  FiDatabase, FiExternalLink, FiPackage,
} from 'react-icons/fi';

interface ProjectsProps {
  user: any;
  installations: any[];
  projects: any[];
  stats: { localCount: number; githubCount: number; totalCount: number };
  loading: boolean;
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleFileUpload: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handleDeleteProject: (projectId: string, projectName: string, projectType?: string) => void;
  handleProjectClick: (project: any) => void;
  startScan: (projectId: string, projectName: string) => void;
  activeScanIds: string[];
  activeRemediationIds: string[];
}

interface ScanResult {
  projectId: string;
  projectName: string;
}

const PROJECTS_PER_PAGE = 7;

export default function Projects({
  user,
  installations,
  projects,
  stats,
  loading,
  uploading,
  fileInputRef,
  handleFileUpload,
  handleDeleteProject,
  handleProjectClick,
  startScan,
  activeScanIds,
  activeRemediationIds,
}: ProjectsProps) {
  const { showPopup } = usePopup();
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [filter, setFilter] = useState<'none' | 'github' | 'local'>('none');
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<any>(null);
  const [refreshingIds, setRefreshingIds] = useState<string[]>([]);

  const handleRefresh = async (e: React.MouseEvent, project: any) => {
    e.stopPropagation();
    if (refreshingIds.includes(project.id)) return;
    setRefreshingIds((prev) => [...prev, project.id]);
    try {
      const res = await fetch('/api/repositories/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: project.owner, repo: project.repo }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Refresh failed');
      showPopup({ type: 'success', message: `"${project.repo}" synced successfully.` });
    } catch (err: any) {
      showPopup({ type: 'error', message: err?.message || 'Failed to sync repository.' });
    } finally {
      setRefreshingIds((prev) => prev.filter((id) => id !== project.id));
    }
  };

  // Handle opening scan modal
  const handleScanClick = (project: any) => {
    setSelectedProject(project);
    setScanModalOpen(true);
  };

  const handleScanComplete = (result: ScanResult) => {
    showPopup({
      type: 'success',
      message: `Scan initiated for "${result.projectName}".`,
    });
    startScan(result.projectId, result.projectName);
  };

  // Filter projects based on search query and filter type, active scans first
  const filteredProjects = useMemo(() => {
    let result = projects;

    // Apply type filter
    if (filter === 'github') {
      result = result.filter((project) => project.type === 'github');
    } else if (filter === 'local') {
      result = result.filter((project) => project.type === 'local');
    }

    // Apply search filter (case-insensitive)
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((project) => {
        const name = project.type === 'local' ? project.name : project.repo;
        return name?.toLowerCase().includes(query);
      });
    }

    return result;
  }, [projects, searchQuery, filter]);

  // Calculate pagination
  const totalPages = Math.ceil(filteredProjects.length / PROJECTS_PER_PAGE);
  const startIndex = (currentPage - 1) * PROJECTS_PER_PAGE;
  const paginatedProjects = filteredProjects.slice(startIndex, startIndex + PROJECTS_PER_PAGE);

  // Reset to page 1 when search query changes
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setCurrentPage(1);
  };

  // Handle filter change
  const handleFilterChange = (newFilter: 'none' | 'github' | 'local') => {
    setFilter(newFilter);
    setCurrentPage(1);
    setShowFilterDropdown(false);
  };

  const handlePrevPage = () => {
    setCurrentPage((prev) => Math.max(prev - 1, 1));
  };

  const handleNextPage = () => {
    setCurrentPage((prev) => Math.min(prev + 1, totalPages));
  };

  // No installations — show centered install prompt only
  if (installations.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-full max-w-sm border border-border rounded-xl bg-surface p-8 text-center">
          <div className="w-14 h-14 rounded-full bg-surface-hover border border-border flex items-center justify-center mx-auto mb-5">
            <FiGithub className="w-6 h-6 text-muted" />
          </div>
          <h3 className="text-sm font-semibold text-foreground mb-1">No GitHub installations</h3>
          <p className="text-xs text-muted mb-5 leading-relaxed">Install the DeplAI GitHub App to connect your repositories and start scanning.</p>
          <a
            href="https://github.com/apps/deplai-gitapp-aj/installations/new"
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition"
          >
            <FiGithub className="w-4 h-4" />
            Install GitHub App
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 space-y-6">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        onChange={handleFileUpload}
        className="hidden"
        disabled={uploading}
      />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Active Projects</h2>
          <p className="text-sm text-zinc-400 mt-1">Manage and scan your connected repositories and local uploads.</p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/apps/deplai-gitapp-aj/installations/new"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/30 text-cyan-100 px-4 py-2 rounded-xl text-sm font-medium transition-all"
            title="Install the DeplAI GitHub App and connect repositories"
          >
            <FiGithub className="w-4 h-4" />
            <span>Connect GitHub</span>
          </a>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 text-white px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50"
          >
            {uploading ? <LoadingSpinner size="sm" /> : <FiUpload className="w-4 h-4" />}
            <span>{uploading ? 'Uploading...' : 'Upload .zip'}</span>
          </button>
        </div>
      </div>

      {/* Search + Filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-50">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            placeholder="Search repositories…"
            value={searchQuery}
            onChange={handleSearchChange}
            className="w-full pl-9 pr-4 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition"
          />
        </div>
        <div className="flex gap-1">
          {(['none', 'github', 'local'] as const).map((f) => {
            const labels = { none: 'All', github: 'GitHub', local: 'Local' };
            const counts = { none: stats.totalCount, github: stats.githubCount, local: stats.localCount };
            return (
              <button
                key={f}
                onClick={() => handleFilterChange(f)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  filter === f
                    ? 'bg-indigo-600 text-white'
                    : 'text-zinc-400 hover:text-white hover:bg-white/5 border border-white/10'
                }`}
              >
                {labels[f]}
                <span className={filter === f ? 'text-indigo-200' : 'text-zinc-500'}>{counts[f]}</span>
              </button>
            );
          })}
        </div>
        <span className="text-xs text-zinc-500 tabular-nums">
          {filteredProjects.length} result{filteredProjects.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Project Cards */}
      {loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner size="lg" /></div>
      ) : projects.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-white/10 rounded-2xl bg-white/2">
          <div className="w-12 h-12 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
            <FiFolder className="w-6 h-6 text-zinc-500" />
          </div>
          <h3 className="text-sm font-medium text-white">No projects deployed</h3>
          <p className="text-sm text-zinc-400 mt-1 max-w-sm mx-auto">Get started by uploading a local project or connecting a GitHub repository.</p>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-white/10 rounded-2xl bg-white/2">
          <FiSearch className="w-8 h-8 text-zinc-500 mx-auto mb-3" />
          <p className="text-sm font-medium text-white">No results for &ldquo;{searchQuery}&rdquo;</p>
          <p className="text-xs text-zinc-400 mt-1">Try a different search term or clear the filter.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {paginatedProjects.map((project) => {
              const name = project.type === 'local' ? project.name : project.repo;
              const isScanning = activeScanIds.includes(project.id);
              const isRemediating = activeRemediationIds.includes(project.id);
              const isActive = isScanning || isRemediating;
              const anyActive = activeScanIds.length > 0 || activeRemediationIds.length > 0;

              return (
                <div
                  key={project.id}
                  className="group relative flex flex-col justify-between rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:border-indigo-500/40 hover:shadow-[0_8px_30px_-4px_rgba(99,102,241,0.1)] overflow-hidden cursor-pointer"
                  onClick={() => handleProjectClick(project)}
                >
                  <div className="absolute inset-0 bg-linear-to-br from-indigo-500/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

                  {/* Card Header */}
                  <div className="relative z-10 flex items-start gap-3 mb-4">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center border shadow-inner transition shrink-0 ${
                      isActive ? 'bg-indigo-500/20 border-indigo-500/40' : 'bg-black/40 border-white/10'
                    }`}>
                      {project.type === 'github' ? (
                        <FiGithub className="w-5 h-5 text-white" />
                      ) : (
                        <FiFolder className="w-5 h-5 text-white" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold text-white tracking-tight truncate">{name}</h3>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80 shadow-[0_0_8px_rgba(52,211,153,0.8)] shrink-0"></span>
                        <span className="text-xs text-zinc-400 capitalize">{project.type}</span>
                        {project.type === 'local' ? (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">Local</span>
                        ) : project.access === 'Private' ? (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">Private</span>
                        ) : (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">Public</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Languages */}
                  {project.type === 'github' && project.languages && Object.keys(project.languages).length > 0 && (
                    <div className="relative z-10 flex flex-wrap gap-1 mb-4">
                      {Object.keys(project.languages).slice(0, 3).map((lang) => (
                        <span key={lang} className="text-[10px] text-zinc-500 px-1.5 py-0.5 rounded bg-white/5 border border-white/10">{lang}</span>
                      ))}
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="relative z-10 flex items-center gap-2 pt-4 border-t border-white/10" onClick={(e) => e.stopPropagation()}>
                    {/* Scan / status */}
                    {isRemediating ? (
                      <div className="flex-1">
                        <GradientText colors={['#5227FF', '#FF9FFC', '#B19EEF']} animationSpeed={8} showBorder={false} className="text-xs font-medium px-2.5 py-2 cursor-default">
                          Remediating
                        </GradientText>
                      </div>
                    ) : isScanning ? (
                      <div className="flex-1">
                        <GradientText colors={['#5227FF', '#FF9FFC', '#B19EEF']} animationSpeed={8} showBorder={false} className="text-xs font-medium px-2.5 py-2 cursor-default">
                          Scanning
                        </GradientText>
                      </div>
                    ) : (
                      <button
                        disabled={anyActive}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-sm font-medium transition border ${
                          anyActive
                            ? 'text-zinc-500 border-white/5 bg-white/5 cursor-not-allowed opacity-50'
                            : 'bg-white/10 hover:bg-white/20 text-white border-white/5'
                        }`}
                        onClick={() => handleScanClick(project)}
                      >
                        <FiShield className="w-4 h-4" />
                        Scan
                      </button>
                    )}

                    {/* Results */}
                    <Link
                      href={`/dashboard/security-analysis/${project.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-sm font-medium bg-indigo-500 hover:bg-indigo-600 text-white shadow-[0_0_15px_-3px_rgba(99,102,241,0.4)] transition"
                    >
                      <FiShield className="w-4 h-4" />
                      Results
                    </Link>

                    {/* Sync (GitHub only) */}
                    {project.type === 'github' && (
                      <button
                        title="Sync from GitHub"
                        disabled={refreshingIds.includes(project.id)}
                        className="p-2 text-zinc-400 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition border border-transparent hover:border-blue-500/20 disabled:opacity-40"
                        onClick={(e) => handleRefresh(e, project)}
                      >
                        <FiRefreshCw className={`w-4 h-4 ${refreshingIds.includes(project.id) ? 'animate-spin' : ''}`} />
                      </button>
                    )}

                    {/* Delete */}
                    {project.canDelete && (
                      <button
                        title="Delete project"
                        className="p-2 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition border border-transparent hover:border-red-500/20"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteProject(project.id, project.name, project.type);
                        }}
                      >
                        <FiTrash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {filteredProjects.length > PROJECTS_PER_PAGE && (
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-zinc-500 tabular-nums">
                {startIndex + 1}–{Math.min(startIndex + PROJECTS_PER_PAGE, filteredProjects.length)} of {filteredProjects.length}
              </p>
              <div className="flex items-center gap-1">
                <button onClick={handlePrevPage} disabled={currentPage === 1} className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition">
                  <FiChevronLeft className="w-4 h-4" />
                </button>
                <span className="px-2 text-xs text-zinc-500 tabular-nums">{currentPage} / {totalPages}</span>
                <button onClick={handleNextPage} disabled={currentPage === totalPages} className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition">
                  <FiChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Scan Modal */}
      <ScanModal
        isOpen={scanModalOpen}
        onClose={() => { setScanModalOpen(false); setSelectedProject(null); }}
        project={selectedProject}
        onScanComplete={handleScanComplete}
      />
    </div>
  );
}


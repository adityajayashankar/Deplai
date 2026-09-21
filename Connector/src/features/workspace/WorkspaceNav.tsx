'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  BarChart3,
  Blocks,
  Bot,
  Boxes,
  Building2,
  ChevronDown,
  ChevronRight,
  CloudCog,
  Coins,
  Folder,
  Home,
  KeyRound,
  List,
  Lock,
  Menu,
  PanelLeftClose,
  Receipt,
  Rocket,
  Scale,
  Search,
  Settings,
  ShieldCheck,
  Palette,
  Server,
  Globe,
  User,
  BookOpen,
  Wallet,
  Gift,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SELECTED_PROJECT_STORAGE_KEY } from '@/features/deployment/state';
import { appFocusRing, applyUserChrome, readUserChrome, setProductTelemetryEnabled } from '@/features/workspace/theme';
import { WorkspaceCreditsBadge, WorkspaceCreditsSlot } from '@/features/workspace/WorkspaceCreditsBadge';
import { buildPlanFeatureMap, navFeatureForItem, type PlanFeature } from '@/lib/billing/plan-features';
import { buildCustomizationHref } from '@/features/customization/utils';
import { DeplaiLogo } from '@/components/deplai-logo';

export type WorkspaceNavId =
  | 'overview'
  | 'deplai-agent'
  | 'customization'
  | 'instances'
  | 'profile'
  | 'organization'
  | 'usage'
  | 'deployment'
  | 'code-reviewer'
  | 'dast'
  | 'cloud'
  | 'security'
  | 'sessions'
  | 'billing'
  | 'invoices'
  | 'byok'
  | 'ai-keys'
  | 'ai-catalog'
  | 'ai-compare'
  | 'ai-usage'
  | 'credits'
  | 'referrals'
  | 'integrations'
  | 'documentation'
  | 'settings';

type NavItem = {
  id: WorkspaceNavId;
  label: string;
  icon: LucideIcon;
  href: string;
  tag?: string;
  placeholder?: boolean;
  newTab?: boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

type ProjectOption = { id: string; name: string };

type WorkspaceUser = {
  login?: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
};

const NAV_COLLAPSED_KEY = 'deplai.workspace.navCollapsed';
const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0f14]';

export function resolveWorkspaceNavId(pathname: string): WorkspaceNavId {
  if (pathname === '/dashboard/agents' || pathname.startsWith('/dashboard/agents/')) return 'deplai-agent';
  if (pathname === '/dashboard' || pathname === '/dashboard/') return 'overview';
  if (pathname === '/profile' || pathname.startsWith('/profile/') || pathname.startsWith('/dashboard/profile')) return 'profile';
  if (pathname.startsWith('/dashboard/customization')) return 'customization';
  if (pathname.startsWith('/dashboard/security-analysis')) return 'security';
  if (pathname.startsWith('/dashboard/deploy') || pathname.startsWith('/dashboard/pipeline')) return 'deployment';
  if (pathname.startsWith('/dashboard/instances')) return 'instances';
  if (pathname.startsWith('/dashboard/dast')) return 'dast';
  if (pathname.startsWith('/dashboard/cloud')) return 'cloud';
  if (pathname.startsWith('/dashboard/settings')) return 'settings';
  if (pathname.startsWith('/dashboard/organization')) return 'organization';
  if (pathname.startsWith('/dashboard/usage')) return 'usage';
  if (pathname.startsWith('/dashboard/documentation')) return 'documentation';
  if (pathname.startsWith('/dashboard/code-reviewer')) return 'code-reviewer';
  if (pathname.startsWith('/dashboard/sessions')) return 'sessions';
  if (pathname.startsWith('/dashboard/billing')
    || pathname.startsWith('/dashboard/payment')
    || pathname.startsWith('/dashboard/subscription')) return 'billing';
  if (pathname.startsWith('/dashboard/invoices')) return 'invoices';
  if (pathname.startsWith('/dashboard/ai/catalog') || pathname.startsWith('/dashboard/ai/models') || pathname.startsWith('/dashboard/ai/providers')) return 'ai-catalog';
  if (pathname.startsWith('/dashboard/ai/compare') || pathname.startsWith('/dashboard/ai/playground')) return 'ai-compare';
  if (pathname.startsWith('/dashboard/ai/usage') || pathname.startsWith('/dashboard/ai/costs')) return 'ai-usage';
  if (pathname.startsWith('/dashboard/ai') || pathname.startsWith('/dashboard/byok')) return 'ai-keys';
  if (pathname.startsWith('/dashboard/credits')) return 'credits';
  if (pathname.startsWith('/dashboard/referrals')) return 'referrals';
  if (pathname.startsWith('/dashboard/integrations')) return 'integrations';
  return 'overview';
}

export function buildWorkspaceNavItems(projectId?: string | null, projectName?: string | null): NavItem[] {
  return buildWorkspaceNavGroups(projectId, projectName).flatMap((group) => group.items);
}

export function buildWorkspaceNavGroups(projectId?: string | null, projectName?: string | null): NavGroup[] {
  const securityHref = projectId
    ? `/dashboard/security-analysis/${encodeURIComponent(projectId)}`
    : '/dashboard';
  const deploymentHref = projectId
    ? `/dashboard/deploy?projectId=${encodeURIComponent(projectId)}`
    : '/dashboard/deploy';
  const instancesHref = projectId
    ? `/dashboard/instances?projectId=${encodeURIComponent(projectId)}`
    : '/dashboard/instances';
  const customizationHref = buildCustomizationHref(projectId, projectName);

  return [
    {
      label: 'Dashboard',
      items: [
        { id: 'overview', label: 'Home', icon: Home, href: '/dashboard' },
        { id: 'profile', label: 'Your Profile', icon: User, href: '/profile' },
        { id: 'organization', label: 'Organizations', icon: Building2, href: '/dashboard/organization' },
        { id: 'usage', label: 'Usage', icon: BarChart3, href: '/dashboard/usage' },
        { id: 'documentation', label: 'Documentation', icon: BookOpen, href: '/dashboard/documentation' },
      ],
    },
    {
      label: 'Services',
      items: [
        { id: 'deplai-agent', label: 'DeplAI Agent', icon: Bot, href: '/dashboard/agents', tag: 'Preview', newTab: true },
        { id: 'customization', label: 'UI/UX customizer', icon: Palette, href: customizationHref },
        { id: 'security', label: 'Security Agent', icon: ShieldCheck, href: securityHref },
        { id: 'dast', label: 'DAST', icon: Globe, href: '/dashboard/dast' },
        { id: 'cloud', label: 'Cloud', icon: CloudCog, href: '/dashboard/cloud' },
        { id: 'deployment', label: 'Deploy', icon: Rocket, href: deploymentHref },
        { id: 'instances', label: 'Instance Management', icon: Server, href: instancesHref },
        { id: 'code-reviewer', label: 'Code Reviewer', icon: Bot, href: '/dashboard/code-reviewer', tag: 'Soon' },
        { id: 'sessions', label: 'Sessions', icon: List, href: '/dashboard/sessions' },
      ],
    },
    {
      label: 'BYOK',
      items: [
        { id: 'ai-keys', label: 'Keys', icon: KeyRound, href: '/dashboard/ai' },
        { id: 'ai-catalog', label: 'Catalog', icon: Boxes, href: '/dashboard/ai/catalog' },
        { id: 'ai-compare', label: 'Compare', icon: Scale, href: '/dashboard/ai/compare' },
        { id: 'ai-usage', label: 'Usage', icon: BarChart3, href: '/dashboard/ai/usage' },
      ],
    },
    {
      label: 'Account',
      items: [
        { id: 'billing', label: 'Billing', icon: Wallet, href: '/dashboard/billing' },
        { id: 'invoices', label: 'Invoices', icon: Receipt, href: '/dashboard/invoices' },
        { id: 'credits', label: 'Credits', icon: Coins, href: '/dashboard/credits' },
        { id: 'referrals', label: 'Refer & Earn', icon: Gift, href: '/dashboard/referrals', tag: 'NEW' },
        { id: 'integrations', label: 'Integrations', icon: Blocks, href: '/dashboard/integrations' },
      ],
    },
  ];
}

function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase() || 'DE';
}

export function WorkspaceNav({
  active,
  workspaceName,
  projectId,
  onNavigate,
  projects = [],
  onSelectProject,
  user,
  planName,
  features = null,
  collapsed = false,
  onToggleCollapsed,
}: {
  active: WorkspaceNavId;
  workspaceName: string;
  projectId?: string | null;
  onNavigate: (href: string) => void;
  projects?: ProjectOption[];
  onSelectProject?: (projectId: string) => void;
  user?: WorkspaceUser | null;
  planName?: string | null;
  features?: Partial<Record<PlanFeature, boolean>> | null;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const displayName = user?.name || user?.login || workspaceName || 'Workspace';
  const displayPlanName = planName || 'Free';
  const selectedProject = projects.find((project) => project.id === projectId) || null;
  const groups = buildWorkspaceNavGroups(projectId, selectedProject?.name);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [projectOpen, setProjectOpen] = useState(false);
  const searchRef = React.useRef<HTMLInputElement | null>(null);

  const searchHits = useMemo(() => {
    const term = query.trim().toLowerCase();
    const pages = groups.flatMap((group) => group.items).concat({
      id: 'settings' as WorkspaceNavId,
      label: 'Settings',
      icon: Settings,
      href: '/dashboard/settings',
    });
    const pageHits = pages.filter((item) => !term || item.label.toLowerCase().includes(term));
    const projectHits = projects.filter((project) => !term || project.name.toLowerCase().includes(term));
    return { pageHits, projectHits };
  }, [groups, projects, query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (event.key === 'Escape') {
        setSearchOpen(false);
        setProjectOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const renderItem = (item: NavItem, options?: { compact?: boolean }) => {
    const isActive = active === item.id;
    const Icon = item.icon;
    const feature = navFeatureForItem(item.id);
    const locked = Boolean(feature && features && features[feature] === false);
    const targetHref = locked ? '/dashboard/billing' : item.href;

    const classNames = `group relative flex w-full items-center gap-2.5 text-left text-[13px] transition ${focusRing} ${
      collapsed || options?.compact ? 'h-9 justify-center px-0' : 'h-9 px-2.5'
    } ${
      isActive
        ? 'border-2 border-black bg-white font-bold text-black shadow-[3px_3px_0_0_#fff]'
        : locked
          ? 'border-2 border-transparent text-white/35 hover:bg-white/[0.04] hover:text-white/55'
          : 'border-2 border-transparent text-white/65 hover:bg-white/[0.06] hover:text-white'
    }`;

    const content = (
      <>
        <Icon
          className={`h-4 w-4 shrink-0 ${isActive ? 'text-black' : locked ? 'text-white/25' : 'text-white/45 group-hover:text-white'}`}
          strokeWidth={1.7}
        />
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {locked ? (
              <Lock className="h-3.5 w-3.5 shrink-0 text-white/35" strokeWidth={2.2} />
            ) : item.tag ? (
              <span
                className={`border-2 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] ${
                  isActive ? 'border-black bg-black text-white' : 'border-white/40 text-white/70'
                }`}
              >
                {item.tag}
              </span>
            ) : null}
          </>
        )}
      </>
    );

    if (item.placeholder) {
      return (
        <button
          key={item.id}
          type="button"
          disabled
          title={item.label}
          className={`${classNames} cursor-not-allowed opacity-50`}
        >
          {content}
        </button>
      );
    }

    return (
      <Link
        key={item.id}
        href={targetHref}
        target={item.newTab && !locked ? '_blank' : undefined}
        rel={item.newTab ? 'noopener noreferrer' : undefined}
        prefetch={true}
        title={locked ? `${item.label} requires a plan upgrade` : `${item.label}${item.newTab ? ' (opens in a new tab)' : ''}`}
        onClick={() => {
          if (!item.newTab || locked) onNavigate?.(targetHref);
        }}
        className={classNames}
      >
        {content}
      </Link>
    );
  };

  return (
    <aside
      className={`workspace-nav relative flex h-full shrink-0 flex-col border-r border-white/10 bg-[var(--app-canvas,#05060a)] text-[var(--app-fg,#ededf0)] transition-[width] duration-200 ${
        collapsed ? 'w-[68px]' : 'w-[248px]'
      }`}
    >
      <div className={`flex items-center gap-2 border-b border-white/10 ${collapsed ? 'justify-center px-2 py-3' : 'px-3 py-3'}`}>
        {collapsed ? (
          <button type="button" onClick={onToggleCollapsed} className={`flex h-9 w-9 items-center justify-center hover:bg-white/[0.05] ${focusRing}`} aria-label="Expand sidebar">
            <DeplaiLogo showWordmark={false} size={28} />
          </button>
        ) : (
          <>
            <Link
              href="/dashboard"
              prefetch={true}
              className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 hover:bg-white/[0.05] ${focusRing}`}
              onClick={() => onNavigate?.('/dashboard')}
            >
              <DeplaiLogo
                size={22}
                wordmarkClassName="font-display text-[15px] font-semibold tracking-tight text-white"
              />
              <ChevronDown className="h-3.5 w-3.5 text-white/40" />
            </Link>
            <button
              type="button"
              onClick={onToggleCollapsed}
              className={`flex h-8 w-8 items-center justify-center text-white/45 hover:bg-white/[0.05] hover:text-white ${focusRing}`}
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      {collapsed ? null : (
        <div className="relative border-b border-white/10 px-3 py-3">
          <p className="mb-1.5 px-1 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-white/35">Application</p>
          <button
            type="button"
            onClick={() => setProjectOpen((open) => !open)}
            className={`flex h-9 w-full items-center gap-2 border-2 border-white/20 bg-transparent px-2.5 text-left text-[13px] hover:border-white ${focusRing}`}
          >
            <Folder className="h-3.5 w-3.5 shrink-0 text-white/45" />
            <span className="min-w-0 flex-1 truncate text-white">
              {selectedProject?.name || 'All projects'}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-white/45" />
          </button>
          {projectOpen && projects.length > 0 ? (
            <div className="absolute left-3 right-3 z-30 mt-1 max-h-64 overflow-y-auto border-[3px] border-black bg-white py-1 text-black shadow-[6px_6px_0_0_#000]">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => {
                    onSelectProject?.(project.id);
                    setProjectOpen(false);
                  }}
                  className={`flex w-full items-center px-3 py-2 text-left text-[13px] hover:bg-black hover:text-white ${
                    project.id === projectId ? 'font-bold' : ''
                  }`}
                >
                  {project.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {collapsed ? (
        <div className="px-2 py-3">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className={`flex h-9 w-full items-center justify-center text-white/45 hover:bg-white/[0.05] hover:text-white ${focusRing}`}
            aria-label="Search"
          >
            <Search className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="px-3 pt-3">
          <button
            type="button"
            onClick={() => {
              setSearchOpen(true);
              window.setTimeout(() => searchRef.current?.focus(), 0);
            }}
            className={`flex h-9 w-full items-center gap-2 border-2 border-white/20 bg-transparent px-2.5 text-[13px] text-white/45 hover:border-white hover:text-white ${focusRing}`}
          >
            <Search className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">Search</span>
            <kbd className="border-2 border-white/20 px-1.5 py-0.5 font-mono text-[10px] text-white/45">
              Ctrl K
            </kbd>
          </button>
        </div>
      )}

      <nav aria-label="Workspace navigation" className={`flex-1 overflow-y-auto ${collapsed ? 'px-2 py-3' : 'px-3 py-4'}`}>
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.label}>
              {collapsed ? null : (
                <p className="mb-1.5 px-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-white/35">
                  {group.label}
                </p>
              )}
              <div className="space-y-0.5">{group.items.map((item) => renderItem(item))}</div>
            </div>
          ))}
        </div>
      </nav>

      <div className={`border-t border-white/10 ${collapsed ? 'px-2 py-3' : 'px-3 py-3'}`}>
        {renderItem(
          { id: 'settings', label: 'Settings', icon: Settings, href: '/dashboard/settings' },
          { compact: collapsed },
        )}
        <Link
          href="/profile"
          prefetch={true}
          onClick={() => onNavigate?.('/profile')}
          aria-label="Your Profile"
          title="Your Profile"
          className={`mt-2 flex w-full items-center gap-2.5 text-left transition ${focusRing} ${
            collapsed ? 'justify-center px-0 py-1' : 'px-1.5 py-1.5'
          } ${active === 'profile' ? 'border-2 border-black bg-white text-black shadow-[3px_3px_0_0_#fff]' : 'border-2 border-transparent hover:bg-white/[0.05]'}`}
        >
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-8 w-8 shrink-0 border-2 border-black object-cover" />
          ) : (
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center border-2 border-black text-[11px] font-bold ${active === 'profile' ? 'bg-black text-white' : 'bg-white text-black'}`}>
              {initialsFrom(displayName)}
            </div>
          )}
          {collapsed ? null : (
            <div className="min-w-0">
              <p className={`truncate text-[13px] font-medium ${active === 'profile' ? 'text-black' : 'text-white'}`}>{displayName}</p>
              <p className={`truncate text-[11px] ${active === 'profile' ? 'text-black/60' : 'text-white/45'}`}>{displayPlanName}</p>
            </div>
          )}
        </Link>
      </div>

      {searchOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[18vh]" onClick={() => setSearchOpen(false)}>
          <div
            className="w-full max-w-lg overflow-hidden border-[3px] border-black bg-white text-black shadow-[8px_8px_0_0_#000]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b-[3px] border-black px-3">
              <Search className="h-4 w-4 text-black" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search pages and projects"
                className="h-12 flex-1 bg-transparent text-[14px] text-black outline-none placeholder:text-neutral-500"
              />
              <kbd className="border-2 border-black px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd>
            </div>
            <div className="max-h-80 overflow-y-auto py-2">
              <p className="px-3 pb-1 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-neutral-500">Pages</p>
              {searchHits.pageHits.map((item) => {
                if (item.placeholder) {
                  return (
                    <div
                      key={item.id}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-neutral-400 cursor-not-allowed"
                    >
                      <item.icon className="h-4 w-4" />
                      <span className="flex-1">{item.label}</span>
                    </div>
                  );
                }
                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    target={item.newTab ? '_blank' : undefined}
                    rel={item.newTab ? 'noopener noreferrer' : undefined}
                    title={item.newTab ? `${item.label} (opens in a new tab)` : item.label}
                    prefetch={true}
                    onClick={() => {
                      if (!item.newTab) onNavigate?.(item.href);
                      setSearchOpen(false);
                      setQuery('');
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-black hover:text-white"
                  >
                    <item.icon className="h-4 w-4" />
                    <span className="flex-1">{item.label}</span>
                    {item.tag ? (
                      <span className="border-2 border-black px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em]">
                        {item.tag}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
              {searchHits.projectHits.length > 0 ? (
                <>
                  <p className="mt-2 px-3 pb-1 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-neutral-500">Projects</p>
                  {searchHits.projectHits.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => {
                        onSelectProject?.(project.id);
                        setSearchOpen(false);
                        setQuery('');
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-black hover:text-white"
                    >
                      <Folder className="h-4 w-4" />
                      {project.name}
                    </button>
                  ))}
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

export function WorkspaceCommandHeader({
  section,
  onExit,
}: {
  section: string;
  onExit: () => void;
}) {
  return (
    <header className="workspace-command-header flex h-12 shrink-0 items-center justify-between border-b border-white/10 bg-[var(--app-canvas,#05060a)] px-5 sm:px-6 md:pr-20">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-mono uppercase tracking-[0.16em] text-white/40">deplai</span>
        <ChevronRight className="h-3.5 w-3.5 text-white/30" />
        <span className="font-display font-semibold text-white">{section}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onExit}
          className={`border-2 border-white/20 px-2.5 py-1 text-[12px] font-bold text-white/80 transition hover:border-white hover:bg-white hover:text-black ${focusRing}`}
        >
          Exit
        </button>
      </div>
    </header>
  );
}

export function WorkspaceShell({
  active,
  section,
  workspaceName,
  projectId,
  onNavigate,
  onExit,
  children,
  stageRail,
  embedded = false,
}: {
  active: WorkspaceNavId;
  section: string;
  workspaceName: string;
  projectId?: string | null;
  onNavigate: (href: string) => void;
  onExit: () => void;
  children: React.ReactNode;
  stageRail?: React.ReactNode;
  embedded?: boolean;
}) {
  const inner = (
    <>
      <WorkspaceCommandHeader section={section} onExit={onExit} />
      {stageRail}
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">{children}</div>
    </>
  );

  if (embedded) {
    return <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-white text-black">{inner}</div>;
  }

  return (
    <div className="deplai-app flex h-screen overflow-hidden">
      <WorkspaceNav
        active={active}
        workspaceName={workspaceName}
        projectId={projectId}
        onNavigate={onNavigate}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{inner}</div>
    </div>
  );
}

function DashboardWorkspaceFrameInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || '/dashboard';
  const searchParams = useSearchParams();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [user, setUser] = useState<WorkspaceUser | null>(null);
  const [planName, setPlanName] = useState<string | null>(null);
  const [planFeatures, setPlanFeatures] = useState<Partial<Record<PlanFeature, boolean>> | null>(null);
  const [storedProjectId, setStoredProjectId] = useState<string | null>(null);

  const pathProjectId = pathname.match(/\/dashboard\/security-analysis\/([^/]+)/)?.[1] || null;
  const queryProjectId = searchParams.get('projectId');
  const projectId = queryProjectId || pathProjectId || storedProjectId;
  const workspaceName = projects.find((project) => project.id === projectId)?.name || user?.login || 'DeplAI';
  const active = resolveWorkspaceNavId(pathname);
  const hideFrame = pathname.startsWith('/dashboard/pipeline');

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(NAV_COLLAPSED_KEY) === '1');
      setStoredProjectId(window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY));
      applyUserChrome(readUserChrome());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [sessionRes, projectsRes, settingsRes, planAccessRes] = await Promise.all([
        fetch('/api/auth/session', { cache: 'no-store' }).catch(() => null),
        fetch('/api/projects', { cache: 'no-store' }).catch(() => null),
        fetch('/api/settings', { cache: 'no-store' }).catch(() => null),
        fetch('/api/billing/plan-access', { cache: 'no-store' }).catch(() => null),
      ]);
      if (cancelled) return;
      if (sessionRes?.ok) {
        const session = await sessionRes.json() as { user?: WorkspaceUser };
        setUser(session.user || null);
      }
      if (planAccessRes?.ok) {
        const payload = await planAccessRes.json() as {
          plan_name?: string;
          features?: Partial<Record<PlanFeature, boolean>>;
        };
        setPlanName(typeof payload.plan_name === 'string' ? payload.plan_name : null);
        setPlanFeatures(payload.features || null);
      }
      if (projectsRes?.ok) {
        const payload = await projectsRes.json() as { projects?: ProjectOption[] };
        setProjects(Array.isArray(payload.projects) ? payload.projects.map((project) => ({ id: project.id, name: project.name })) : []);
      }
      if (settingsRes?.ok) {
        const payload = await settingsRes.json() as {
          settings?: {
            user?: {
              preferences?: {
                density?: 'comfortable' | 'default' | 'compact';
                fontSize?: 'small' | 'default' | 'large';
                reducedMotion?: boolean;
                highContrast?: boolean;
              };
              privacy?: { usageTelemetry?: boolean };
            };
          };
        };
        const prefs = payload.settings?.user?.preferences;
        if (prefs) {
          applyUserChrome({
            density: prefs.density,
            fontSize: prefs.fontSize,
            reducedMotion: prefs.reducedMotion,
            highContrast: prefs.highContrast,
          });
        }
        if (typeof payload.settings?.user?.privacy?.usageTelemetry === 'boolean') {
          setProductTelemetryEnabled(payload.settings.user.privacy.usageTelemetry);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistProject = useCallback((nextProjectId: string) => {
    try {
      window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, nextProjectId);
    } catch {
      /* ignore */
    }
    setStoredProjectId(nextProjectId);
  }, []);

  const onSelectProject = useCallback((nextProjectId: string) => {
    persistProject(nextProjectId);
    if (pathname.startsWith('/dashboard/security-analysis')) {
      router.push(`/dashboard/security-analysis/${encodeURIComponent(nextProjectId)}`);
      return;
    }
    if (pathname.startsWith('/dashboard/customization')) {
      const project = projects.find((item) => item.id === nextProjectId);
      router.push(buildCustomizationHref(nextProjectId, project?.name || null));
      return;
    }
    if (pathname.startsWith('/dashboard/deploy') || pathname.startsWith('/dashboard/instances')) {
      const params = new URLSearchParams(searchParams.toString());
      params.set('projectId', nextProjectId);
      router.push(`${pathname}?${params.toString()}`);
    }
  }, [pathname, persistProject, projects, router, searchParams]);

  const onToggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  if (hideFrame) {
    return (
      <>
        <div className="fixed right-4 top-3 z-[80]">
          <WorkspaceCreditsBadge />
        </div>
        {children}
      </>
    );
  }

  const navigate = (_href?: string) => {
    setMobileNavOpen(false);
  };

  return (
    <div className="deplai-app flex h-screen flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-3 md:hidden">
        <button
          type="button"
          className={`flex h-9 w-9 items-center justify-center hover:bg-white/[0.05] ${focusRing}`}
          aria-label="Open navigation"
          onClick={() => setMobileNavOpen(true)}
        >
          <Menu className="h-4 w-4 text-white" />
        </button>
        <span className="min-w-0">
          <DeplaiLogo
            size={22}
            wordmarkClassName="font-display text-[15px] font-semibold tracking-tight text-white"
          />
        </span>
        <div className="ml-auto">
          <WorkspaceCreditsBadge compact />
        </div>
      </div>
      {mobileNavOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={`${
            mobileNavOpen ? 'fixed inset-y-0 left-0 z-50 flex md:relative md:z-0' : 'hidden md:flex'
          }`}
        >
          <WorkspaceNav
            active={active}
            workspaceName={workspaceName}
            projectId={projectId}
            projects={projects}
            user={user}
            planName={planName}
            features={planFeatures}
            collapsed={collapsed}
            onToggleCollapsed={onToggleCollapsed}
            onSelectProject={onSelectProject}
            onNavigate={navigate}
          />
        </div>
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white text-black">
          <WorkspaceCreditsSlot />
          <div key={pathname} className="page-enter h-full">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DashboardWorkspaceFrame({ children }: { children: React.ReactNode }) {
  return (
      <Suspense fallback={<div className="deplai-app h-screen" />}>
      <DashboardWorkspaceFrameInner>{children}</DashboardWorkspaceFrameInner>
    </Suspense>
  );
}

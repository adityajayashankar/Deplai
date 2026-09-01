'use client';

import {
  Activity,
  Bot,
  Building2,
  ChevronRight,
  Cloud,
  Copy,
  CreditCard,
  FolderKanban,
  Github,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Users,
  UserRoundPlus,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreditBalanceWidget } from '@/features/billing/CreditBalanceWidget';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { appBtnInk, appBtnPaper, appInput, appPaper } from '@/features/workspace/theme';

type Organization = {
  id: string;
  name: string;
  slug: string;
  status: string;
  roleKey: string;
  roleName: string;
  isOwner: boolean;
};

type Overview = {
  organization: Organization;
  metrics: {
    member_count: number;
    team_count: number;
    project_count: number;
    deployment_count: number;
    scan_count: number;
    finding_count: number;
    cloud_account_count: number;
    ai_provider_count: number;
    plan_name: string | null;
    subscription_status: string | null;
  };
  recentActivity: AuditEvent[];
};

type Member = {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  status: string;
  role: { key: string; name: string };
  teamCount: number;
  lastActiveAt: string | null;
};

type Invitation = {
  id: string;
  email: string;
  role: { key: string; name: string };
  invitedBy: string | null;
  status: string;
  expiresAt: string;
};

type Team = {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  projectCount: number;
};

type Role = {
  id: string;
  key: string;
  name: string;
  description: string;
  permissions: string[];
};

type PermissionGroup = { name: string; permissions: Array<{ key: string; description: string }> };
type Project = { id: string; name: string; type: string; source?: string; access?: string; createdAt?: string };
type AuditEvent = {
  id: string;
  actor: { name: string | null; email: string | null };
  action: string;
  resourceType: string;
  result: string;
  createdAt: string;
};
type Policy = {
  enabled: boolean;
  staged: boolean;
  configuration: {
    blockCritical: boolean;
    blockExposedSecrets: boolean;
    requireSast: boolean;
    requireSca: boolean;
    requireContainerScan: boolean;
    requireDast: boolean;
    criticalThreshold: number;
    highThreshold: number;
    productionApprovals: number;
  };
};

type TabId = 'overview' | 'members' | 'teams' | 'roles' | 'projects' | 'security' | 'integrations' | 'billing' | 'audit' | 'settings';

const TABS: Array<{ id: TabId; label: string; group: string; icon: typeof Building2 }> = [
  { id: 'overview', label: 'Overview', group: 'Organization', icon: Building2 },
  { id: 'members', label: 'Members & invites', group: 'People', icon: Users },
  { id: 'teams', label: 'Teams', group: 'People', icon: Users },
  { id: 'roles', label: 'Roles & permissions', group: 'Access', icon: KeyRound },
  { id: 'projects', label: 'Projects', group: 'Resources', icon: FolderKanban },
  { id: 'security', label: 'Security policy', group: 'Governance', icon: ShieldCheck },
  { id: 'integrations', label: 'Cloud & AI', group: 'Infrastructure', icon: Cloud },
  { id: 'billing', label: 'Billing & usage', group: 'Usage', icon: CreditCard },
  { id: 'audit', label: 'Audit log', group: 'Governance', icon: Activity },
  { id: 'settings', label: 'Organization settings', group: 'Settings', icon: Settings },
];

const ASSIGNABLE_ROLES = ['ADMIN', 'DEVOPS', 'DEVELOPER', 'SECURITY', 'BILLING_ADMIN', 'VIEWER'];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error || 'Organization request failed');
  return payload;
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function roleLabel(value: string) {
  return value.toLowerCase().split('_').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

function Badge({ children, tone = 'paper' }: { children: React.ReactNode; tone?: 'paper' | 'ink' | 'warning' }) {
  const color = tone === 'ink' ? 'bg-black text-white' : tone === 'warning' ? 'bg-amber-100 text-amber-900' : 'bg-white text-black';
  return <span className={`inline-flex border-2 border-black px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] ${color}`}>{children}</span>;
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className={`${appPaper} p-8 text-center`}>
      <p className="font-display text-lg text-black">{title}</p>
      <p className="mx-auto mt-2 max-w-lg text-[13px] leading-relaxed text-neutral-600">{body}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

export default function OrganizationsApp() {
  const router = useRouter();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeOrganizationId, setActiveOrganizationId] = useState('');
  const [tab, setTab] = useState<TabId>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissionGroups, setPermissionGroups] = useState<PermissionGroup[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [selectedRole, setSelectedRole] = useState('DEVELOPER');
  const [loading, setLoading] = useState(true);
  const [panel, setPanel] = useState<'create' | 'invite' | 'team' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [createdInvitePath, setCreatedInvitePath] = useState('');
  const [createForm, setCreateForm] = useState({ name: '', slug: '' });
  const [inviteForm, setInviteForm] = useState({ email: '', roleKey: 'DEVELOPER' });
  const [teamForm, setTeamForm] = useState({ name: '', description: '' });
  const [settingsForm, setSettingsForm] = useState({ name: '', slug: '' });

  const activeOrganization = organizations.find((organization) => organization.id === activeOrganizationId) || null;

  const showNotice = useCallback((tone: 'ok' | 'error', text: string) => {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice(null), 5000);
  }, []);

  const loadOrganizations = useCallback(async () => {
    const payload = await api<{ organizations: Organization[]; activeOrganizationId: string }>('/api/v1/organizations');
    setOrganizations(payload.organizations);
    setActiveOrganizationId(payload.activeOrganizationId);
  }, []);

  const loadOverview = useCallback(async (organizationId: string) => {
    const payload = await api<Overview>(`/api/v1/organizations/${encodeURIComponent(organizationId)}`);
    setOverview(payload);
    setSettingsForm({ name: payload.organization.name, slug: payload.organization.slug });
  }, []);

  useEffect(() => {
    void loadOrganizations()
      .catch((error) => showNotice('error', error instanceof Error ? error.message : 'Could not load organizations'))
      .finally(() => setLoading(false));
  }, [loadOrganizations, showNotice]);

  useEffect(() => {
    if (!activeOrganizationId) return;
    setLoading(true);
    void loadOverview(activeOrganizationId)
      .catch((error) => showNotice('error', error instanceof Error ? error.message : 'Could not load organization overview'))
      .finally(() => setLoading(false));
  }, [activeOrganizationId, loadOverview, showNotice]);

  useEffect(() => {
    if (!activeOrganizationId || tab === 'overview') return;
    setLoading(true);
    const loadTab = async () => {
      if (tab === 'members') {
        const [memberPayload, invitePayload] = await Promise.all([
          api<{ members: Member[] }>(`/api/v1/organizations/${activeOrganizationId}/members`),
          api<{ invitations: Invitation[] }>(`/api/v1/organizations/${activeOrganizationId}/invitations`),
        ]);
        setMembers(memberPayload.members);
        setInvitations(invitePayload.invitations);
      } else if (tab === 'teams') {
        setTeams((await api<{ teams: Team[] }>(`/api/v1/organizations/${activeOrganizationId}/teams`)).teams);
      } else if (tab === 'roles') {
        const payload = await api<{ roles: Role[]; permissionGroups: PermissionGroup[] }>(`/api/v1/organizations/${activeOrganizationId}/roles`);
        setRoles(payload.roles);
        setPermissionGroups(payload.permissionGroups);
      } else if (tab === 'projects') {
        setProjects((await api<{ projects: Project[] }>('/api/projects')).projects || []);
      } else if (tab === 'security') {
        setPolicy((await api<{ policy: Policy }>(`/api/v1/organizations/${activeOrganizationId}/security-policies`)).policy);
      } else if (tab === 'audit') {
        setAudit((await api<{ events: AuditEvent[] }>(`/api/v1/organizations/${activeOrganizationId}/audit-events`)).events);
      }
    };
    void loadTab()
      .catch((error) => showNotice('error', error instanceof Error ? error.message : 'Could not load organization data'))
      .finally(() => setLoading(false));
  }, [activeOrganizationId, showNotice, tab]);

  const switchOrganization = async (organizationId: string) => {
    setBusy(true);
    try {
      await api('/api/v1/organizations/active', { method: 'POST', body: JSON.stringify({ organizationId }) });
      setActiveOrganizationId(organizationId);
      setTab('overview');
      setOverview(null);
      router.refresh();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not switch organization');
    } finally {
      setBusy(false);
    }
  };

  const createOrganization = async () => {
    setBusy(true);
    try {
      const payload = await api<{ organization: Organization }>('/api/v1/organizations', {
        method: 'POST',
        body: JSON.stringify(createForm),
      });
      setOrganizations((current) => [...current, payload.organization]);
      setActiveOrganizationId(payload.organization.id);
      setPanel(null);
      setCreateForm({ name: '', slug: '' });
      showNotice('ok', 'Organization created');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not create organization');
    } finally {
      setBusy(false);
    }
  };

  const inviteMember = async () => {
    if (!activeOrganizationId) return;
    setBusy(true);
    try {
      const payload = await api<{ invitation: { acceptPath: string } }>(`/api/v1/organizations/${activeOrganizationId}/invitations`, {
        method: 'POST',
        body: JSON.stringify(inviteForm),
      });
      setCreatedInvitePath(payload.invitation.acceptPath);
      const invitationsPayload = await api<{ invitations: Invitation[] }>(`/api/v1/organizations/${activeOrganizationId}/invitations`);
      setInvitations(invitationsPayload.invitations);
      showNotice('ok', 'Secure invitation created');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not invite member');
    } finally {
      setBusy(false);
    }
  };

  const createTeam = async () => {
    if (!activeOrganizationId) {
      showNotice('error', 'No active organization is selected. Refresh the page or create an organization first.');
      return;
    }
    const teamName = teamForm.name.trim();
    if (teamName.length < 2) {
      showNotice('error', 'Team name must be at least 2 characters.');
      return;
    }
    if (!['OWNER', 'ADMIN'].includes(activeOrganization?.roleKey || '')) {
      showNotice('error', 'Only organization owners and admins can create teams.');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/v1/organizations/${activeOrganizationId}/teams`, {
        method: 'POST',
        body: JSON.stringify({ name: teamName, description: teamForm.description.trim() }),
      });
      setTeams((await api<{ teams: Team[] }>(`/api/v1/organizations/${activeOrganizationId}/teams`)).teams);
      setTeamForm({ name: '', description: '' });
      setPanel(null);
      showNotice('ok', 'Team created');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not create team');
    } finally {
      setBusy(false);
    }
  };

  const changeMemberRole = async (member: Member, roleKey: string) => {
    if (!activeOrganizationId) return;
    try {
      await api(`/api/v1/organizations/${activeOrganizationId}/members/${member.id}`, {
        method: 'PATCH', body: JSON.stringify({ roleKey }),
      });
      setMembers((current) => current.map((item) => item.id === member.id
        ? { ...item, role: { key: roleKey, name: roleLabel(roleKey) } }
        : item));
      showNotice('ok', `${member.name || member.email} is now ${roleLabel(roleKey)}`);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not update role');
    }
  };

  const savePolicy = async () => {
    if (!activeOrganizationId || !policy) return;
    setBusy(true);
    try {
      const payload = await api<{ policy: Policy }>(`/api/v1/organizations/${activeOrganizationId}/security-policies`, {
        method: 'PUT', body: JSON.stringify(policy),
      });
      setPolicy({ ...payload.policy, staged: false });
      showNotice('ok', 'Security policy saved');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not save security policy');
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async () => {
    if (!activeOrganizationId) return;
    setBusy(true);
    try {
      await api(`/api/v1/organizations/${activeOrganizationId}`, { method: 'PATCH', body: JSON.stringify(settingsForm) });
      await loadOrganizations();
      showNotice('ok', 'Organization settings saved');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Could not save settings');
    } finally {
      setBusy(false);
    }
  };

  const selectedRoleRecord = roles.find((role) => role.key === selectedRole) || roles[0];
  const filteredMembers = useMemo(() => {
    const term = search.trim().toLowerCase();
    return members.filter((member) => !term || `${member.name || ''} ${member.email} ${member.role.name}`.toLowerCase().includes(term));
  }, [members, search]);

  const renderOverview = () => {
    const metrics = overview?.metrics;
    const cards = [
      ['Members', metrics?.member_count || 0, Users],
      ['Projects', metrics?.project_count || 0, FolderKanban],
      ['Deployments', metrics?.deployment_count || 0, Cloud],
      ['Security scans', metrics?.scan_count || 0, ShieldCheck],
      ['Cloud accounts', metrics?.cloud_account_count || 0, Cloud],
      ['AI providers', metrics?.ai_provider_count || 0, Bot],
    ] as const;
    return (
      <div className="space-y-6">
        <section className={`${appPaper} p-6`}>
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-display text-2xl font-semibold text-black">{activeOrganization?.name}</h2>
                <Badge tone="ink">{activeOrganization?.roleName}</Badge>
                <Badge>{metrics?.plan_name || 'Free'}</Badge>
              </div>
              <p className="mt-2 text-[13px] text-neutral-600">
                {metrics?.member_count || 0} members · {metrics?.project_count || 0} projects · {metrics?.team_count || 0} teams
              </p>
            </div>
            <button type="button" className={appBtnPaper} onClick={() => setTab('settings')}><Settings className="h-4 w-4" /> Settings</button>
          </div>
        </section>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map(([label, value, Icon]) => (
            <div key={label} className={`${appPaper} p-5`}>
              <div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">{label}</p><Icon className="h-4 w-4" /></div>
              <p className="mt-5 font-display text-3xl font-semibold text-black">{value}</p>
            </div>
          ))}
        </div>
        <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <section className={`${appPaper} p-6`}>
            <div className="flex items-center justify-between"><h3 className="font-display text-lg">Recent activity</h3><button className="text-[12px] font-bold underline" onClick={() => setTab('audit')}>Open audit log</button></div>
            <div className="mt-4 divide-y-2 divide-black border-y-2 border-black">
              {(overview?.recentActivity || []).map((event) => (
                <div key={event.id} className="grid gap-1 py-3 sm:grid-cols-[1fr_auto]">
                  <div><p className="text-[13px] font-bold">{event.action}</p><p className="text-[11px] text-neutral-500">{event.actor.name || event.actor.email || 'System'} · {event.resourceType}</p></div>
                  <p className="font-mono text-[10px] text-neutral-500">{formatDate(event.createdAt)}</p>
                </div>
              ))}
              {!overview?.recentActivity?.length ? <p className="py-6 text-center text-[12px] text-neutral-500">No organization activity yet.</p> : null}
            </div>
          </section>
          <section className={`${appPaper} p-6`}>
            <h3 className="font-display text-lg">Governance snapshot</h3>
            <div className="mt-4 space-y-3 text-[13px]">
              <button className="flex w-full items-center justify-between border-2 border-black p-3 text-left font-bold" onClick={() => setTab('security')}><span>Security policy</span><ChevronRight className="h-4 w-4" /></button>
              <button className="flex w-full items-center justify-between border-2 border-black p-3 text-left font-bold" onClick={() => setTab('roles')}><span>Role matrix</span><ChevronRight className="h-4 w-4" /></button>
              <button className="flex w-full items-center justify-between border-2 border-black p-3 text-left font-bold" onClick={() => setTab('billing')}><span>Billing boundary</span><ChevronRight className="h-4 w-4" /></button>
            </div>
          </section>
        </div>
      </div>
    );
  };

  const renderMembers = () => (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-[260px] flex-1 max-w-md"><Search className="absolute left-3 top-3 h-4 w-4" /><input className={`${appInput} pl-9`} placeholder="Search members" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <button className={appBtnInk} onClick={() => { setCreatedInvitePath(''); setPanel('invite'); }}><UserRoundPlus className="h-4 w-4" /> Invite member</button>
      </div>
      <section className={`${appPaper} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-[12px]">
            <thead className="bg-black text-white"><tr>{['Member', 'Role', 'Teams', 'Status', 'Last active'].map((label) => <th key={label} className="px-4 py-3 font-mono text-[10px] uppercase tracking-[0.14em]">{label}</th>)}</tr></thead>
            <tbody className="divide-y-2 divide-black">
              {filteredMembers.map((member) => (
                <tr key={member.id}>
                  <td className="px-4 py-3"><p className="font-bold">{member.name || 'Unnamed member'}</p><p className="text-neutral-500">{member.email}</p></td>
                  <td className="px-4 py-3">{member.role.key === 'OWNER' ? <Badge tone="ink">Owner</Badge> : <select className="border-2 border-black bg-white px-2 py-1.5 font-bold" value={member.role.key} onChange={(event) => void changeMemberRole(member, event.target.value)}>{ASSIGNABLE_ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select>}</td>
                  <td className="px-4 py-3">{member.teamCount}</td><td className="px-4 py-3"><Badge tone={member.status === 'ACTIVE' ? 'paper' : 'warning'}>{member.status}</Badge></td><td className="px-4 py-3 text-neutral-500">{formatDate(member.lastActiveAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className={`${appPaper} p-6`}>
        <h3 className="font-display text-lg">Invitations</h3>
        <div className="mt-4 divide-y-2 divide-black border-y-2 border-black">
          {invitations.map((invitation) => <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-[13px] font-bold">{invitation.email}</p><p className="text-[11px] text-neutral-500">{invitation.role.name} · expires {formatDate(invitation.expiresAt)}</p></div><Badge tone={invitation.status === 'PENDING' ? 'warning' : 'paper'}>{invitation.status}</Badge></div>)}
          {!invitations.length ? <p className="py-5 text-[12px] text-neutral-500">No invitations have been created.</p> : null}
        </div>
      </section>
    </div>
  );

  const renderTeams = () => (
    <div className="space-y-6"><div className="flex justify-end"><button className={appBtnInk} onClick={() => setPanel('team')}><Plus className="h-4 w-4" /> Create team</button></div>{teams.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{teams.map((team) => <article key={team.id} className={`${appPaper} p-5`}><div className="flex items-start justify-between"><div className="flex h-10 w-10 items-center justify-center border-[3px] border-black bg-black text-white"><Users className="h-4 w-4" /></div><Badge>{team.memberCount} members</Badge></div><h3 className="mt-5 font-display text-lg">{team.name}</h3><p className="mt-2 min-h-10 text-[12px] leading-relaxed text-neutral-600">{team.description || 'No description yet.'}</p><p className="mt-4 border-t-2 border-black pt-3 font-mono text-[10px] uppercase tracking-[0.14em]">{team.projectCount} project scopes</p></article>)}</div> : <EmptyState title="No teams yet" body="Group members into durable access units such as Frontend, Platform, Security, or Finance." action={<button className={appBtnInk} onClick={() => setPanel('team')}>Create first team</button>} />}</div>
  );

  const renderRoles = () => (
    <div className="grid gap-6 xl:grid-cols-[280px_1fr]">
      <section className={`${appPaper} p-4`}><p className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">Built-in roles</p>{roles.map((role) => <button key={role.id} onClick={() => setSelectedRole(role.key)} className={`mb-2 w-full border-2 border-black px-3 py-3 text-left ${selectedRole === role.key ? 'bg-black text-white' : 'bg-white text-black'}`}><p className="text-[13px] font-bold">{role.name}</p><p className={`mt-1 text-[10px] ${selectedRole === role.key ? 'text-neutral-300' : 'text-neutral-500'}`}>{role.permissions.length} permissions</p></button>)}</section>
      <section className={`${appPaper} p-6`}><h3 className="font-display text-xl">{selectedRoleRecord?.name || 'Role permissions'}</h3><p className="mt-1 text-[12px] text-neutral-600">{selectedRoleRecord?.description}</p><div className="mt-6 space-y-5">{permissionGroups.map((group) => <div key={group.name}><p className="mb-2 border-b-2 border-black pb-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em]">{group.name}</p><div className="grid gap-2 md:grid-cols-2">{group.permissions.map((permission) => { const allowed = selectedRoleRecord?.permissions.includes(permission.key); return <div key={permission.key} className={`border-2 border-black p-3 ${allowed ? 'bg-white' : 'bg-neutral-100 text-neutral-400'}`}><div className="flex items-center justify-between gap-2"><code className="text-[10px] font-bold">{permission.key}</code><span aria-label={allowed ? 'Allowed' : 'Denied'} className={`h-3 w-3 border-2 border-black ${allowed ? 'bg-emerald-500' : 'bg-white'}`} /></div><p className="mt-1 text-[10px]">{permission.description}</p></div>; })}</div></div>)}</div></section>
    </div>
  );

  const renderProjects = () => projects.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{projects.map((project) => <article key={project.id} className={`${appPaper} p-5`}><div className="flex items-center justify-between"><FolderKanban className="h-5 w-5" /><Badge>{project.type}</Badge></div><h3 className="mt-5 font-display text-lg">{project.name}</h3><p className="mt-2 text-[12px] text-neutral-500">{project.source || 'DeplAI'} · {project.access || 'Organization access'}</p><button className={`${appBtnPaper} mt-5`} onClick={() => router.push(`/dashboard?project=${encodeURIComponent(project.id)}`)}>Open project</button></article>)}</div> : <EmptyState title="No projects in this organization" body="Projects created or connected while this organization is active will be isolated here." action={<button className={appBtnInk} onClick={() => router.push('/dashboard')}>Add a project</button>} />;

  const renderSecurity = () => policy ? <div className="space-y-6"><section className={`${appPaper} p-6`}><div className="flex flex-wrap items-center justify-between gap-4"><div><h3 className="font-display text-xl">Deployment gate</h3><p className="mt-1 text-[12px] text-neutral-600">Organization defaults for security evidence and production approval.</p></div><label className="flex items-center gap-2 text-[12px] font-bold"><input type="checkbox" checked={policy.enabled} onChange={(event) => setPolicy({ ...policy, enabled: event.target.checked })} /> Policy enabled</label></div><div className="mt-6 grid gap-3 md:grid-cols-2">{([['blockCritical', 'Block critical vulnerabilities'], ['blockExposedSecrets', 'Block exposed secrets'], ['requireSast', 'Require SAST'], ['requireSca', 'Require SCA'], ['requireContainerScan', 'Require container scan'], ['requireDast', 'Require DAST']] as const).map(([key, label]) => <label key={key} className="flex items-center gap-3 border-2 border-black p-3 text-[12px] font-bold"><input type="checkbox" checked={policy.configuration[key]} onChange={(event) => setPolicy({ ...policy, configuration: { ...policy.configuration, [key]: event.target.checked } })} />{label}</label>)}</div><div className="mt-5 grid gap-4 md:grid-cols-3">{([['criticalThreshold', 'Critical threshold'], ['highThreshold', 'High threshold'], ['productionApprovals', 'Production approvals']] as const).map(([key, label]) => <label key={key} className="text-[11px] font-bold uppercase tracking-[0.1em]">{label}<input type="number" min={0} max={key === 'productionApprovals' ? 10 : 1000} className={`${appInput} mt-2`} value={policy.configuration[key]} onChange={(event) => setPolicy({ ...policy, configuration: { ...policy.configuration, [key]: Number(event.target.value) } })} /></label>)}</div><button className={`${appBtnInk} mt-6`} disabled={busy} onClick={() => void savePolicy()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Save policy</button></section><div className="border-[3px] border-black bg-amber-50 p-4 text-[12px]"><strong>Rollout status:</strong> policy storage and evaluation are live. Blocking the existing executor is staged until approval requests are enabled, preventing an accidental production outage during migration.</div></div> : null;

  const renderIntegrations = () => <div className="grid gap-5 md:grid-cols-2"><section className={`${appPaper} p-6`}><Cloud className="h-5 w-5" /><h3 className="mt-4 font-display text-xl">AWS accounts</h3><p className="mt-2 text-[12px] text-neutral-600">{overview?.metrics.cloud_account_count || 0} organization cloud accounts. Credential values remain outside normal frontend responses.</p><button className={`${appBtnPaper} mt-5`} onClick={() => router.push('/dashboard/deploy')}>Open deployment setup</button></section><section className={`${appPaper} p-6`}><Bot className="h-5 w-5" /><h3 className="mt-4 font-display text-xl">AI providers</h3><p className="mt-2 text-[12px] text-neutral-600">{overview?.metrics.ai_provider_count || 0} organization provider configurations. Members can use approved providers without reading keys.</p><button className={`${appBtnPaper} mt-5`} onClick={() => router.push('/dashboard/settings')}>Open provider settings</button></section><section className={`${appPaper} p-6`}><Github className="h-5 w-5" /><h3 className="mt-4 font-display text-xl">GitHub</h3><p className="mt-2 text-[12px] text-neutral-600">Repository visibility now follows the active organization and its project access boundary.</p><button className={`${appBtnPaper} mt-5`} onClick={() => router.push('/dashboard/integrations')}>Manage integrations</button></section><section className={`${appPaper} p-6`}><KeyRound className="h-5 w-5" /><h3 className="mt-4 font-display text-xl">Secrets</h3><p className="mt-2 text-[12px] text-neutral-600">Organization roles distinguish secret metadata from secret values. Values remain write-only in deployment flows.</p><button className={`${appBtnPaper} mt-5`} onClick={() => router.push('/dashboard/deploy')}>Manage deployment secrets</button></section></div>;

  const renderBilling = () => <div className="grid gap-5 lg:grid-cols-3"><section className={`${appPaper} p-6 lg:col-span-2`}><CreditCard className="h-5 w-5" /><h3 className="mt-4 font-display text-xl">Organization billing</h3><div className="mt-5 grid gap-3 sm:grid-cols-2"><div className="border-2 border-black p-4"><p className="font-mono text-[9px] uppercase tracking-[0.15em] text-neutral-500">Plan</p><p className="mt-2 text-lg font-bold">{overview?.metrics.plan_name || 'Free'}</p></div><div className="border-2 border-black p-4"><p className="font-mono text-[9px] uppercase tracking-[0.15em] text-neutral-500">Subscription</p><p className="mt-2 text-lg font-bold">{overview?.metrics.subscription_status || 'Active'}</p></div></div><p className="mt-4 text-[12px] text-neutral-600">Managed credits are shared across authorized members. BYOK usage does not debit the wallet.</p><div className="mt-5 flex flex-wrap gap-3"><button className={appBtnInk} onClick={() => router.push('/dashboard/billing')}>Manage billing</button><button className={appBtnPaper} onClick={() => router.push('/dashboard/invoices')}>Invoices</button><button className={appBtnPaper} onClick={() => router.push('/dashboard/credits')}>Credits & usage</button></div></section><aside><CreditBalanceWidget compact /><div className={`${appPaper} mt-5 p-5`}><h3 className="font-display text-lg">Billing access</h3><p className="mt-3 text-[12px] leading-relaxed text-neutral-600">Owner, Admin, and Billing Admin can purchase or request refunds. AI-authorized members may consume the shared balance.</p></div></aside></div>;

  const renderAudit = () => <section className={`${appPaper} overflow-hidden`}><div className="border-b-[3px] border-black p-5"><h3 className="font-display text-xl">Organization audit log</h3><p className="mt-1 text-[12px] text-neutral-600">Sanitized, tenant-scoped governance events.</p></div><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-[12px]"><thead className="bg-black text-white"><tr>{['Timestamp', 'Actor', 'Action', 'Resource', 'Result'].map((label) => <th key={label} className="px-4 py-3 font-mono text-[10px] uppercase tracking-[0.14em]">{label}</th>)}</tr></thead><tbody className="divide-y-2 divide-black">{audit.map((event) => <tr key={event.id}><td className="px-4 py-3 font-mono text-[10px]">{formatDate(event.createdAt)}</td><td className="px-4 py-3">{event.actor.name || event.actor.email || 'System'}</td><td className="px-4 py-3 font-bold">{event.action}</td><td className="px-4 py-3">{event.resourceType}</td><td className="px-4 py-3"><Badge>{event.result}</Badge></td></tr>)}</tbody></table>{!audit.length ? <p className="p-8 text-center text-[12px] text-neutral-500">No visible audit events.</p> : null}</div></section>;

  const renderSettings = () => <div className="space-y-6"><section className={`${appPaper} p-6`}><h3 className="font-display text-xl">General</h3><div className="mt-5 grid gap-4 md:grid-cols-2"><label className="text-[11px] font-bold uppercase tracking-[0.1em]">Organization name<input className={`${appInput} mt-2`} value={settingsForm.name} onChange={(event) => setSettingsForm({ ...settingsForm, name: event.target.value })} /></label><label className="text-[11px] font-bold uppercase tracking-[0.1em]">Slug<input className={`${appInput} mt-2`} value={settingsForm.slug} onChange={(event) => setSettingsForm({ ...settingsForm, slug: event.target.value })} /></label></div><button className={`${appBtnInk} mt-5`} disabled={busy} onClick={() => void saveSettings()}>Save changes</button></section><section className="border-[3px] border-black bg-red-50 p-6 shadow-[6px_6px_0_0_#000]"><h3 className="font-display text-xl">Danger zone</h3><p className="mt-2 text-[12px] text-neutral-700">Organization deletion is soft and recoverable for 30 days. Ownership transfer must happen before the owner can leave.</p><button className="mt-5 border-[3px] border-black bg-red-600 px-4 py-2 text-[12px] font-bold text-white disabled:opacity-40" disabled={!activeOrganization?.isOwner}>Schedule deletion</button></section></div>;

  const renderContent = () => {
    if (loading && !overview) return <div className="flex min-h-72 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
    if (tab === 'overview') return renderOverview();
    if (tab === 'members') return renderMembers();
    if (tab === 'teams') return renderTeams();
    if (tab === 'roles') return renderRoles();
    if (tab === 'projects') return renderProjects();
    if (tab === 'security') return renderSecurity();
    if (tab === 'integrations') return renderIntegrations();
    if (tab === 'billing') return renderBilling();
    if (tab === 'audit') return renderAudit();
    return renderSettings();
  };

  return (
    <div className="relative flex h-full overflow-hidden bg-transparent font-sans">
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <WorkspaceCommandHeader section="Organizations" onExit={() => router.push('/dashboard')} />
        {notice ? <div className={`mx-5 mt-4 border-[3px] border-black px-4 py-3 text-[12px] font-bold ${notice.tone === 'error' ? 'bg-red-100 text-red-900' : 'bg-emerald-100 text-emerald-950'}`}>{notice.text}</div> : null}
        <div className="custom-scrollbar flex-1 overflow-y-auto p-5 md:p-7">
          <div className="mx-auto grid max-w-[1500px] gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="space-y-4 xl:sticky xl:top-0 xl:self-start">
              <section className={`${appPaper} p-4`}>
                <div className="flex items-center justify-between gap-2"><p className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-neutral-500">Active organization</p><button className="border-2 border-black p-1" aria-label="Refresh organizations" onClick={() => void loadOrganizations()}><RefreshCw className="h-3 w-3" /></button></div>
                <select className={`${appInput} mt-3 font-bold`} value={activeOrganizationId} disabled={busy || !organizations.length} onChange={(event) => void switchOrganization(event.target.value)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select>
                <div className="mt-3 flex items-center justify-between"><Badge tone="ink">{activeOrganization?.roleName || 'Loading'}</Badge><button className="text-[11px] font-bold underline" onClick={() => setPanel('create')}>New org</button></div>
              </section>
              <nav className={`${appPaper} p-3`}>
                {Array.from(new Set(TABS.map((item) => item.group))).map((group) => <div key={group} className="mb-4 last:mb-0"><p className="px-2 pb-1 font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-neutral-400">{group}</p>{TABS.filter((item) => item.group === group).map((item) => { const Icon = item.icon; return <button key={item.id} onClick={() => setTab(item.id)} className={`mt-1 flex w-full items-center gap-2 border-2 px-2.5 py-2 text-left text-[11px] font-bold ${tab === item.id ? 'border-black bg-black text-white' : 'border-transparent text-neutral-700 hover:border-black'}`}><Icon className="h-3.5 w-3.5" />{item.label}</button>; })}</div>)}
              </nav>
            </aside>
            <div className="min-w-0">
              <div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-neutral-500">{TABS.find((item) => item.id === tab)?.group}</p><h1 className="mt-1 font-display text-2xl font-semibold text-black">{TABS.find((item) => item.id === tab)?.label}</h1></div>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}</div>
              {renderContent()}
            </div>
          </div>
        </div>
      </main>

      {panel ? <div className="absolute inset-0 z-50 flex justify-end bg-black/45" onMouseDown={(event) => { if (event.currentTarget === event.target) setPanel(null); }}><section className="h-full w-full max-w-md overflow-y-auto border-l-[4px] border-black bg-white p-6 shadow-[-10px_0_0_0_rgba(0,0,0,0.18)]"><div className="flex items-center justify-between"><div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-neutral-500">Organizations</p><h2 className="mt-1 font-display text-xl">{panel === 'create' ? 'Create organization' : panel === 'invite' ? 'Invite member' : 'Create team'}</h2></div><button className="border-2 border-black p-1.5" onClick={() => setPanel(null)}><X className="h-4 w-4" /></button></div>{panel === 'create' ? <div className="mt-7 space-y-4"><label className="text-[11px] font-bold uppercase tracking-[0.1em]">Name<input autoFocus className={`${appInput} mt-2`} value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} /></label><label className="text-[11px] font-bold uppercase tracking-[0.1em]">Slug (optional)<input className={`${appInput} mt-2`} value={createForm.slug} onChange={(event) => setCreateForm({ ...createForm, slug: event.target.value })} /></label><button className={`${appBtnInk} w-full`} disabled={busy} onClick={() => void createOrganization()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create organization</button></div> : panel === 'invite' ? <div className="mt-7 space-y-4"><label className="text-[11px] font-bold uppercase tracking-[0.1em]">Email<input autoFocus type="email" className={`${appInput} mt-2`} value={inviteForm.email} onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })} /></label><label className="text-[11px] font-bold uppercase tracking-[0.1em]">Role<select className={`${appInput} mt-2`} value={inviteForm.roleKey} onChange={(event) => setInviteForm({ ...inviteForm, roleKey: event.target.value })}>{ASSIGNABLE_ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label><button className={`${appBtnInk} w-full`} disabled={busy} onClick={() => void inviteMember()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserRoundPlus className="h-4 w-4" />} Create invite</button>{createdInvitePath ? <div className="border-[3px] border-black bg-emerald-50 p-4"><p className="text-[11px] font-bold">Invitation link</p><p className="mt-2 break-all font-mono text-[10px]">{createdInvitePath}</p><button className={`${appBtnPaper} mt-3 w-full`} onClick={() => void navigator.clipboard.writeText(`${window.location.origin}${createdInvitePath}`)}><Copy className="h-4 w-4" /> Copy link</button><p className="mt-3 text-[10px] leading-relaxed text-neutral-600">The raw token is shown only now. DeplAI stores only its SHA-256 hash.</p></div> : null}</div> : <div className="mt-7 space-y-4"><label className="text-[11px] font-bold uppercase tracking-[0.1em]">Team name<input autoFocus className={`${appInput} mt-2`} value={teamForm.name} onChange={(event) => setTeamForm({ ...teamForm, name: event.target.value })} /></label><label className="text-[11px] font-bold uppercase tracking-[0.1em]">Description<textarea className={`${appInput} mt-2 min-h-24`} value={teamForm.description} onChange={(event) => setTeamForm({ ...teamForm, description: event.target.value })} /></label><button className={`${appBtnInk} w-full`} disabled={busy} onClick={() => void createTeam()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />} Create team</button></div>}</section></div> : null}
    </div>
  );
}

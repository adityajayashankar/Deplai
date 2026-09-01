'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  FileCode,
  Globe,
  Power,
  RefreshCw,
  Rocket,
  RotateCw,
  Server,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import {
  DEPLOY_STATE_STORAGE_PREFIX,
  downloadTextFile,
  extractDeploymentSummary,
  flattenDeployOutputs,
  iacRunIdFromResult,
  isIacPipelineResult,
  isRealAwsInstanceId,
  listApplyingDeploymentRecords,
  listManagedDeploymentRecords,
  readIacFilesFromSession,
  readSavedAws,
  readSavedIacMeta,
  readSavedIacRun,
  removeDeploySnapshot,
  saveDeployUiStage,
  type DeployApiResult,
  type ProjectRecord,
} from './state';
import { isProvisionedValue, isSensitiveOutputKey } from '@/features/deployment/infra-access-briefing';
import { WorkspaceCommandHeader } from '@/features/workspace/WorkspaceNav';
import { ProjectSourceThumb } from '@/components/project-icons';
import { appBtnInk, appBtnPaper, appInput, appPaper } from '@/features/workspace/theme';

type ViewTab = 'runtime' | 'iac';

interface AwsRuntimeLiveInstance {
  instance_id?: string;
  public_ipv4_address?: string;
  private_ipv4_address?: string;
  instance_state?: string;
  instance_type?: string;
  public_dns?: string;
  private_dns?: string;
  vpc_id?: string;
  subnet_id?: string;
  instance_arn?: string;
  launch_time?: string | null;
}

interface AwsRuntimeLiveDetails {
  region?: string;
  account_id?: string;
  lookup_status?: 'ok' | 'not_found' | 'unavailable' | string;
  lookup_error?: string | null;
  instance?: AwsRuntimeLiveInstance;
  resource_counts?: {
    ec2_instances_total?: number;
    ec2_instances_running?: number;
    s3_buckets?: number;
    cloudfront_distributions?: number;
  };
}

interface ManagedEnvironment {
  projectId: string;
  projectName: string;
  source: 'Github' | 'Local';
  owner?: string;
  branch: string;
  region: string;
  lastDeploy: string;
  deployResult: DeployApiResult | null;
  summary: ReturnType<typeof extractDeploymentSummary>;
  iacMode: 'iac_pipeline' | 'terraform';
  runId: string | null;
  workspace: string | null;
  iacFileCount: number;
  outputs: Array<{ key: string; value: string }>;
}

interface RuntimeInstanceView {
  environment: ManagedEnvironment;
  id: string;
  name: string;
  specs: string;
  ip: string;
  privateIp: string;
  dns: string;
  status: 'running' | 'stopped' | 'unknown';
  uptime: string;
  vpc: string;
  subnet: string;
  arn: string;
  appUrl: string;
}

const REFRESH_INTERVAL_MS = 8000;
const KPI_TICK_INTERVAL_MS = 15000;
const RUNTIME_DETAILS_REFRESH_MS = 12000;
const INSTANCE_VCPU_COUNT: Record<string, number> = {
  't2.micro': 1,
  't2.small': 1,
  't3.micro': 2,
  't3.small': 2,
  't3.medium': 2,
  't3a.micro': 2,
};

const paperIconBtn =
  'inline-flex h-8 w-8 items-center justify-center border-[3px] border-black bg-white text-black shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none disabled:cursor-not-allowed disabled:opacity-50';

function relativeTimeLabel(isoLike: string | null | undefined, nowMs: number = Date.now()): string {
  if (!isoLike) return 'just now';
  const ts = Date.parse(String(isoLike));
  if (!Number.isFinite(ts)) return 'just now';
  const mins = Math.floor((nowMs - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatUptimeFromLaunch(launchIso: string | null | undefined, nowMs: number): string {
  if (!launchIso) return '-';
  const started = Date.parse(String(launchIso));
  if (!Number.isFinite(started)) return '-';
  const totalMinutes = Math.floor(Math.max(0, nowMs - started) / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(minutes, 1)}m`;
}

function instanceSpecLabel(instanceType: string): string {
  const type = String(instanceType || '').trim();
  const known: Record<string, string> = {
    't2.micro': '1 vCPU • 1GB',
    't2.small': '1 vCPU • 2GB',
    't3.micro': '2 vCPU • 1GB',
    't3.small': '2 vCPU • 2GB',
    't3.medium': '2 vCPU • 4GB',
    't3a.micro': '2 vCPU • 1GB',
  };
  if (!type || type === 'n/a') return 'n/a';
  return `${type} • ${known[type] || 'n/a'}`;
}

function displayValue(value: string | null | undefined): string {
  return isProvisionedValue(value) ? String(value) : '—';
}

function publicIacOutputs(result: DeployApiResult | null): Array<{ key: string; value: string }> {
  const flat = flattenDeployOutputs(result?.raw_outputs || result?.outputs) || {};
  const rows: Array<{ key: string; value: string }> = [];
  for (const [key, raw] of Object.entries(flat)) {
    if (key === 'outputs') continue;
    if (isSensitiveOutputKey(key)) continue;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in (raw as Record<string, unknown>)) {
      const nested = String((raw as { value?: unknown }).value ?? '').trim();
      if (isProvisionedValue(nested)) rows.push({ key, value: nested });
      continue;
    }
    const value = Array.isArray(raw) ? raw.filter(Boolean).join(', ') : String(raw ?? '').trim();
    if (isProvisionedValue(value)) rows.push({ key, value });
  }
  return rows.slice(0, 18);
}

function StatCard({ label, value, suffix }: { label: string; value: React.ReactNode; suffix?: string }) {
  return (
    <div className={`${appPaper} p-5`}>
      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-neutral-500">{label}</p>
      <div className="mt-4 font-display text-3xl font-bold text-black">
        {value}
        {suffix ? <span className="ml-1 text-lg font-normal text-neutral-500">{suffix}</span> : null}
      </div>
    </div>
  );
}

function CopyValue({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const canCopy = isProvisionedValue(value);
  return (
    <button
      type="button"
      disabled={!canCopy}
      onClick={async () => {
        if (!canCopy) return;
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className={className || 'inline-flex items-center text-neutral-500 hover:text-black disabled:opacity-40'}
      title={copied ? 'Copied' : 'Copy'}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-[12px] font-bold ${active ? 'bg-black text-white' : 'bg-white text-black hover:bg-neutral-100'}`}
    >
      {children}
    </button>
  );
}

export default function ManageInstancesApp({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedProjectId = String(searchParams.get('projectId') || '').trim();
  const requestedTab = searchParams.get('tab') === 'iac' ? 'iac' : 'runtime';

  const [tab, setTab] = useState<ViewTab>(requestedTab);
  const [searchTerm, setSearchTerm] = useState('');
  const [regionFilter, setRegionFilter] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [runtimeDetailsByProject, setRuntimeDetailsByProject] = useState<Record<string, AwsRuntimeLiveDetails>>({});
  const [busyActions, setBusyActions] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setTab(requestedTab);
  }, [requestedTab]);

  const replaceQuery = useCallback((next: { projectId?: string; tab?: ViewTab }) => {
    const params = new URLSearchParams(searchParams.toString());
    const projectId = next.projectId === undefined ? requestedProjectId : next.projectId;
    const nextTab = next.tab || tab;
    if (projectId) params.set('projectId', projectId);
    else params.delete('projectId');
    if (nextTab === 'iac') params.set('tab', 'iac');
    else params.delete('tab');
    const query = params.toString();
    router.replace(query ? `/dashboard/instances?${query}` : '/dashboard/instances');
  }, [requestedProjectId, router, searchParams, tab]);

  const loadProjects = useCallback(async (withSpinner: boolean) => {
    if (withSpinner) setRefreshing(true);
    try {
      const response = await fetch('/api/projects', { cache: 'no-store' }).catch(() => null);
      if (!response?.ok) return;
      const data = (await response.json().catch(() => ({}))) as { projects?: ProjectRecord[] };
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch {
      /* keep last known list */
    } finally {
      if (withSpinner) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects(true);
  }, [loadProjects]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadProjects(false);
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [loadProjects]);

  useEffect(() => {
    const tickId = window.setInterval(() => setNowMs(Date.now()), KPI_TICK_INTERVAL_MS);
    return () => window.clearInterval(tickId);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key.startsWith(DEPLOY_STATE_STORAGE_PREFIX)) {
        void loadProjects(false);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [loadProjects]);

  const liveRecords = useMemo(() => listManagedDeploymentRecords(projects), [projects]);
  const applyingRecords = useMemo(() => listApplyingDeploymentRecords(projects), [projects]);

  const environments = useMemo<ManagedEnvironment[]>(() => {
    const savedIacMeta = readSavedIacMeta();
    const savedIacRun = readSavedIacRun();
    const sessionIacFiles = readIacFilesFromSession();
    return liveRecords.map((record) => {
      const result = record.latest?.deployResult || record.snapshot.deployResult;
      const summary = extractDeploymentSummary(result);
      const project = projects.find((item) => item.id === record.projectId);
      const sessionMatches = savedIacMeta?.project_id === record.projectId;
      return {
        projectId: record.projectId,
        projectName: record.projectName,
        source: project?.type === 'github' ? 'Github' : 'Local',
        owner: project?.owner,
        branch: project?.branch || 'main',
        region: String(runtimeDetailsByProject[record.projectId]?.region || record.latest?.region || 'eu-north-1'),
        lastDeploy: relativeTimeLabel(record.snapshot.updatedAt, nowMs),
        deployResult: result,
        summary,
        iacMode: isIacPipelineResult(result) ? 'iac_pipeline' : 'terraform',
        runId: iacRunIdFromResult(result) || (sessionMatches ? savedIacRun?.run_id || null : null),
        workspace: sessionMatches ? (savedIacMeta?.workspace || savedIacRun?.workspace || null) : null,
        iacFileCount: sessionMatches ? sessionIacFiles.length : 0,
        outputs: publicIacOutputs(result),
      };
    });
  }, [liveRecords, nowMs, projects, runtimeDetailsByProject]);

  const scopedEnvironments = useMemo(() => {
    const projectScoped = requestedProjectId
      ? environments.filter((item) => item.projectId === requestedProjectId)
      : environments;
    const query = searchTerm.trim().toLowerCase();
    return projectScoped.filter((item) => {
      if (regionFilter !== 'all' && item.region !== regionFilter) return false;
      if (!query) return true;
      return (
        item.projectName.toLowerCase().includes(query)
        || item.branch.toLowerCase().includes(query)
        || item.region.toLowerCase().includes(query)
        || String(item.runId || '').toLowerCase().includes(query)
        || String(item.summary.instanceId || '').toLowerCase().includes(query)
      );
    });
  }, [environments, regionFilter, requestedProjectId, searchTerm]);

  const regions = useMemo(() => {
    const unique = new Set(environments.map((item) => item.region).filter(Boolean));
    return Array.from(unique).sort();
  }, [environments]);

  const setActionBusy = useCallback((key: string, busy: boolean) => {
    setBusyActions((prev) => {
      if (!busy) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: true };
    });
  }, []);

  const refreshRuntimeDetails = useCallback(async () => {
    if (liveRecords.length === 0) {
      setRuntimeDetailsByProject({});
      return;
    }
    const aws = readSavedAws();
    if (!aws.aws_access_key_id || !aws.aws_secret_access_key) return;

    const results = await Promise.all(
      liveRecords.map(async (record) => {
        try {
          const summary = extractDeploymentSummary(record.latest?.deployResult || record.snapshot.deployResult);
          const instanceId = isRealAwsInstanceId(summary.instanceId) ? summary.instanceId : undefined;
          const region = String(record.latest?.region || aws.aws_region || 'eu-north-1');
          const response = await fetch('/api/pipeline/runtime-details', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project_id: record.projectId,
              aws_access_key_id: aws.aws_access_key_id,
              aws_secret_access_key: aws.aws_secret_access_key,
              aws_region: region,
              instance_id: instanceId,
            }),
          });
          const data = (await response.json().catch(() => ({}))) as { success?: boolean; details?: AwsRuntimeLiveDetails };
          if (!response.ok || data.success !== true || !data.details) return null;
          return [record.projectId, data.details] as const;
        } catch {
          return null;
        }
      }),
    );

    const next: Record<string, AwsRuntimeLiveDetails> = {};
    for (const row of results) {
      if (!row) continue;
      next[row[0]] = row[1];
    }
    setRuntimeDetailsByProject(next);
  }, [liveRecords]);

  useEffect(() => {
    void refreshRuntimeDetails();
    const intervalId = window.setInterval(() => {
      void refreshRuntimeDetails();
    }, RUNTIME_DETAILS_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [refreshRuntimeDetails]);

  const instances = useMemo<RuntimeInstanceView[]>(() => {
    return scopedEnvironments.flatMap((environment) => {
      const runtime = runtimeDetailsByProject[environment.projectId];
      if (runtime?.lookup_status === 'not_found') return [];
      const live = runtime?.instance;
      const instanceId = isRealAwsInstanceId(live?.instance_id)
        ? String(live?.instance_id)
        : isRealAwsInstanceId(environment.summary.instanceId)
          ? environment.summary.instanceId
          : null;
      if (!instanceId) return [];
      const stateRaw = String(live?.instance_state || environment.summary.instanceState || '').toLowerCase();
      const status: RuntimeInstanceView['status'] = stateRaw.includes('running')
        ? 'running'
        : stateRaw.includes('stopped') || stateRaw.includes('stopping')
          ? 'stopped'
          : isProvisionedValue(stateRaw)
            ? 'unknown'
            : 'unknown';
      const instanceType = String(live?.instance_type || environment.summary.instanceType || '').trim();
      const launchTime = String(live?.launch_time || '').trim() || null;
      return [{
        environment,
        id: instanceId,
        name: environment.projectName.toLowerCase().replace(/\s+/g, '-'),
        specs: instanceSpecLabel(instanceType),
        ip: String(live?.public_ipv4_address || environment.summary.publicIp || ''),
        privateIp: String(live?.private_ipv4_address || environment.summary.privateIp || ''),
        dns: String(live?.public_dns || environment.summary.publicDns || ''),
        status,
        uptime: status === 'running'
          ? (launchTime ? formatUptimeFromLaunch(launchTime, nowMs) : environment.lastDeploy.replace(' ago', ''))
          : '-',
        vpc: String(live?.vpc_id || environment.summary.vpcId || ''),
        subnet: String(live?.subnet_id || environment.summary.subnetId || ''),
        arn: String(live?.instance_arn || environment.summary.instanceArn || ''),
        appUrl: environment.summary.appUrl,
      }];
    });
  }, [nowMs, runtimeDetailsByProject, scopedEnvironments]);

  const applyingForScope = useMemo(
    () => applyingRecords.filter((record) => !requestedProjectId || record.projectId === requestedProjectId),
    [applyingRecords, requestedProjectId],
  );

  const runningCount = instances.filter((item) => item.status === 'running').length;
  const totalVcpu = instances.reduce((sum, item) => {
    if (item.status !== 'running') return sum;
    const type = String(item.specs.split('•')[0] || '').trim().toLowerCase();
    return sum + (INSTANCE_VCPU_COUNT[type] || 0);
  }, 0);
  const iacStackCount = scopedEnvironments.length;
  const hasAwsCreds = Boolean(readSavedAws().aws_access_key_id && readSavedAws().aws_secret_access_key);

  useEffect(() => {
    if (requestedTab !== 'runtime') return;
    if (scopedEnvironments.length === 0) return;
    const hasEc2Summary = scopedEnvironments.some((env) => isRealAwsInstanceId(env.summary.instanceId));
    if (hasEc2Summary) return;
    setTab('iac');
    replaceQuery({ tab: 'iac' });
  }, [replaceQuery, requestedTab, scopedEnvironments]);

  const openDeploy = useCallback((projectId: string, stage: 'outputs' | 'terraform' | 'deploy') => {
    saveDeployUiStage(projectId, stage);
    try {
      window.localStorage.setItem(`deplai.pipeline.currentStage.${projectId}`, stage);
    } catch {
      /* ignore */
    }
    router.push(`/dashboard/deploy?projectId=${encodeURIComponent(projectId)}`);
  }, [router]);

  const openInstanceTerminal = useCallback((instance: RuntimeInstanceView) => {
    const region = encodeURIComponent(instance.environment.region || 'eu-north-1');
    window.open(
      `https://${instance.environment.region}.console.aws.amazon.com/ec2/home?region=${region}#ConnectToInstance:instanceId=${encodeURIComponent(instance.id)}`,
      '_blank',
      'noopener,noreferrer',
    );
  }, []);

  const runInstanceAction = useCallback(
    async (instance: RuntimeInstanceView, action: 'start' | 'stop' | 'reboot') => {
      const aws = readSavedAws();
      if (!aws.aws_access_key_id || !aws.aws_secret_access_key) {
        setNotice('AWS credentials are missing. Set them in Deploy before managing runtime.');
        return;
      }
      const actionKey = `${instance.environment.projectId}:${instance.id}:${action}`;
      setActionBusy(actionKey, true);
      setNotice(null);
      try {
        const response = await fetch('/api/pipeline/runtime-instance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: instance.environment.projectId,
            aws_access_key_id: aws.aws_access_key_id,
            aws_secret_access_key: aws.aws_secret_access_key,
            aws_region: instance.environment.region || aws.aws_region,
            instance_id: instance.id,
            action,
          }),
        });
        const data = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string };
        if (!response.ok || data.success !== true) {
          setNotice(data.error || `Failed to ${action} instance.`);
          return;
        }
        await loadProjects(false);
        await refreshRuntimeDetails();
      } finally {
        setActionBusy(actionKey, false);
      }
    },
    [loadProjects, refreshRuntimeDetails, setActionBusy],
  );

  const handleDestroy = useCallback(
    async (environment: ManagedEnvironment) => {
      const aws = readSavedAws();
      if (!aws.aws_access_key_id || !aws.aws_secret_access_key) {
        setNotice('AWS credentials are missing. Set them in Deploy before destroying infrastructure.');
        return;
      }
      const viaTerraform = Boolean(environment.runId);
      const confirmMessage = viaTerraform
        ? `Destroy Terraform stack for ${environment.projectName}? This runs terraform destroy, then cleans leftover runtime resources.`
        : `Destroy DeplAI-tagged runtime resources for ${environment.projectName}? This cannot be undone.`;
      if (!window.confirm(confirmMessage)) return;

      const actionKey = `${environment.projectId}:destroy`;
      setActionBusy(actionKey, true);
      setNotice(null);
      try {
        const response = await fetch('/api/pipeline/deploy/destroy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: environment.projectId,
            run_id: environment.runId || undefined,
            aws_access_key_id: aws.aws_access_key_id,
            aws_secret_access_key: aws.aws_secret_access_key,
            aws_region: environment.region || aws.aws_region,
          }),
        });
        const data = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string };
        if (!response.ok || data.success !== true) {
          setNotice(data.error || 'Failed to destroy infrastructure.');
          return;
        }
        removeDeploySnapshot(environment.projectId);
        setRuntimeDetailsByProject((prev) => {
          const next = { ...prev };
          delete next[environment.projectId];
          return next;
        });
        setExpandedId(null);
        await loadProjects(false);
        await refreshRuntimeDetails();
      } finally {
        setActionBusy(actionKey, false);
      }
    },
    [loadProjects, refreshRuntimeDetails, setActionBusy],
  );

  const emptyBecauseNoApply = liveRecords.length === 0 && applyingRecords.length === 0;

  const toolbar = (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center border-[3px] border-black">
        <TabButton
          active={tab === 'runtime'}
          onClick={() => {
            setTab('runtime');
            replaceQuery({ tab: 'runtime' });
          }}
        >
          Runtime
        </TabButton>
        <TabButton
          active={tab === 'iac'}
          onClick={() => {
            setTab('iac');
            replaceQuery({ tab: 'iac' });
          }}
        >
          IaC stacks
        </TabButton>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder={tab === 'iac' ? 'Search stacks…' : 'Search instances…'}
          className={`${appInput} w-56 py-1.5`}
        />
        <select
          value={regionFilter}
          onChange={(event) => setRegionFilter(event.target.value)}
          className={`${appInput} w-40 py-1.5`}
        >
          <option value="all">All regions</option>
          {regions.map((region) => (
            <option key={region} value={region}>{region}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            void loadProjects(true);
            void refreshRuntimeDetails();
          }}
          disabled={refreshing}
          className={appBtnPaper}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
    </div>
  );

  const emptyState = (
    <div className={`${appPaper} p-10 text-center`}>
      <Server className="mx-auto mb-4 h-8 w-8 text-black" />
      <h2 className="font-display text-xl font-semibold text-black">Manage instances after apply</h2>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-neutral-600">
        Runtime start/stop/reboot and Terraform destroy are available only after a project has been applied in Deploy.
        Generate IaC, confirm the plan, then come back here.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <button
          type="button"
          className={appBtnInk}
          onClick={() => router.push(requestedProjectId
            ? `/dashboard/deploy?projectId=${encodeURIComponent(requestedProjectId)}`
            : '/dashboard/deploy')}
        >
          <Rocket className="h-4 w-4" /> Open Deploy
        </button>
      </div>
    </div>
  );

  const renderInstanceCard = (instance: RuntimeInstanceView) => {
    const env = instance.environment;
    const expanded = expandedId === instance.id;
    const destroyBusy = Boolean(busyActions[`${env.projectId}:destroy`]);
    const sshHost = isProvisionedValue(instance.ip) ? instance.ip : (isProvisionedValue(instance.dns) ? instance.dns : null);
    const sshCommand = sshHost
      ? `ssh -i ./${env.summary.keyName || 'deplai-ec2-key'}.pem -o StrictHostKeyChecking=accept-new ec2-user@${sshHost}`
      : null;

    return (
      <div key={instance.id} className={`${appPaper} p-5`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-4">
            <ProjectSourceThumb type={env.source === 'Github' ? 'github' : 'local'} owner={env.owner} />
            <div>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-black">{instance.name}</h3>
                <span className="border-2 border-black px-1.5 py-0.5 font-mono text-[10px] text-black">{instance.id}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-neutral-600">
                <span>{env.projectName}</span>
                <span className="text-neutral-400">·</span>
                <span className="font-mono text-black">{env.branch}</span>
                <span className="text-neutral-400">·</span>
                <span>AWS {env.region}</span>
                <span className="text-neutral-400">·</span>
                <span>{env.iacMode === 'iac_pipeline' ? 'IaC pipeline' : 'Terraform'}</span>
              </div>
            </div>
          </div>
          <div className={`flex items-center gap-1.5 border-[3px] border-black px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${instance.status === 'running' ? 'bg-black text-white' : 'bg-white text-black'}`}>
            <span className={`h-1.5 w-1.5 ${instance.status === 'running' ? 'bg-white' : 'bg-black'}`} />
            {instance.status}
          </div>
        </div>

        <div className="mb-4 grid grid-cols-3 gap-4 border-b-[3px] border-t-[3px] border-black py-4">
          <div>
            <span className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-neutral-500">Specs</span>
            <div className="text-[13px] font-medium text-black">{displayValue(instance.specs)}</div>
          </div>
          <div>
            <span className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-neutral-500">Public IP</span>
            <div className="flex items-center gap-2 font-mono text-[13px] text-black">
              {displayValue(instance.ip)}
              <CopyValue value={instance.ip} />
            </div>
          </div>
          <div>
            <span className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-neutral-500">Uptime</span>
            <div className="text-[13px] font-medium text-black">{instance.uptime}</div>
          </div>
        </div>

        {expanded && (
          <div className="mb-4 space-y-5 border-t-[3px] border-black pt-5">
            <div className="grid grid-cols-2 gap-x-4 gap-y-4 md:grid-cols-4">
              {[
                ['Private IP', instance.privateIp],
                ['Public DNS', instance.dns],
                ['VPC', instance.vpc],
                ['Subnet', instance.subnet],
                ['ARN', instance.arn],
                ['App URL', instance.appUrl],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1.5">
                  <span className="font-mono text-[10px] font-bold uppercase text-neutral-500">{label}</span>
                  <div className="flex items-center gap-2 font-mono text-xs text-black">
                    <span className="truncate">{displayValue(value)}</span>
                    <CopyValue value={value} />
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <button type="button" className={appBtnPaper} onClick={() => openDeploy(env.projectId, 'outputs')}>
                Open deploy outputs
              </button>
              <button type="button" className={appBtnPaper} onClick={() => openDeploy(env.projectId, 'terraform')}>
                <FileCode className="h-3.5 w-3.5" /> Open Terraform
              </button>
              {isProvisionedValue(instance.appUrl) ? (
                <button
                  type="button"
                  className={appBtnPaper}
                  onClick={() => window.open(instance.appUrl.startsWith('http') ? instance.appUrl : `http://${instance.appUrl}`, '_blank', 'noopener,noreferrer')}
                >
                  <Globe className="h-3.5 w-3.5" /> Open app
                </button>
              ) : (
                <button type="button" className={appBtnPaper} disabled>
                  App URL pending
                </button>
              )}
            </div>

            {sshCommand ? (
              <div className="border-[3px] border-black bg-white p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-[10px] font-bold uppercase text-neutral-500">SSH</span>
                  <CopyValue value={sshCommand} />
                </div>
                <code className="block break-all font-mono text-[11px] text-black">{sshCommand}</code>
                {env.summary.generatedPem ? (
                  <button
                    type="button"
                    className={`${appBtnPaper} mt-3`}
                    onClick={() => {
                      const pem = env.summary.generatedPem || '';
                      downloadTextFile(`${env.summary.keyName || 'deplai-ec2-key'}.pem`, pem.endsWith('\n') ? pem : `${pem}\n`);
                    }}
                  >
                    <Download className="h-3.5 w-3.5" /> Download PEM
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-neutral-500">Applied {env.lastDeploy}</div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setExpandedId(expanded ? null : instance.id)}
              className={`${expanded ? appBtnInk : appBtnPaper} h-8 px-3 text-xs`}
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} Details
            </button>
            <button type="button" onClick={() => openInstanceTerminal(instance)} className={`${appBtnPaper} h-8 px-3 text-xs`}>
              <TerminalSquare className="h-3.5 w-3.5" /> Connect
            </button>
            <button
              type="button"
              onClick={() => void runInstanceAction(instance, 'reboot')}
              disabled={instance.status !== 'running' || Boolean(busyActions[`${env.projectId}:${instance.id}:reboot`])}
              className={paperIconBtn}
              title="Reboot"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void runInstanceAction(instance, instance.status === 'running' ? 'stop' : 'start')}
              disabled={Boolean(busyActions[`${env.projectId}:${instance.id}:${instance.status === 'running' ? 'stop' : 'start'}`])}
              className={paperIconBtn}
              title={instance.status === 'running' ? 'Stop' : 'Start'}
            >
              <Power className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void handleDestroy(env)}
              disabled={destroyBusy}
              className={`${paperIconBtn} ml-1`}
              title="Destroy infrastructure"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderIacCard = (environment: ManagedEnvironment) => {
    const expanded = expandedId === `iac-${environment.projectId}`;
    const destroyBusy = Boolean(busyActions[`${environment.projectId}:destroy`]);
    return (
      <div key={environment.projectId} className={`${appPaper} p-5`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-black bg-black">
              <FileCode className="h-4 w-4 text-white" />
            </div>
            <div>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-black">{environment.projectName}</h3>
                <span className="border-2 border-black px-1.5 py-0.5 font-mono text-[10px] uppercase text-black">
                  {environment.iacMode === 'iac_pipeline' ? 'IaC pipeline' : 'Terraform'}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-neutral-600">
                <span>AWS {environment.region}</span>
                <span className="text-neutral-400">·</span>
                <span>Applied {environment.lastDeploy}</span>
                {environment.runId ? (
                  <>
                    <span className="text-neutral-400">·</span>
                    <span className="font-mono text-black">run {environment.runId.slice(0, 8)}</span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-3 gap-4 border-b-[3px] border-t-[3px] border-black py-4">
          <div>
            <span className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-neutral-500">Workspace</span>
            <div className="truncate font-mono text-[13px] text-black">{displayValue(environment.workspace)}</div>
          </div>
          <div>
            <span className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-neutral-500">Run ID</span>
            <div className="flex items-center gap-2 font-mono text-[13px] text-black">
              <span className="truncate">{displayValue(environment.runId)}</span>
              {environment.runId ? <CopyValue value={environment.runId} /> : null}
            </div>
          </div>
          <div>
            <span className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-neutral-500">Bundle</span>
            <div className="text-[13px] font-medium text-black">
              {environment.iacFileCount > 0 ? `${environment.iacFileCount} files in session` : 'Open Deploy to view files'}
            </div>
          </div>
        </div>

        {expanded && (
          <div className="mb-4 space-y-4 border-t-[3px] border-black pt-5">
            {environment.outputs.length === 0 ? (
              <p className="text-sm text-neutral-600">No public Terraform outputs stored for this apply yet.</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {environment.outputs.map((row) => (
                  <div key={row.key} className="flex items-start justify-between gap-3 border-[3px] border-black p-3">
                    <div className="min-w-0">
                      <div className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">{row.key}</div>
                      <div className="mt-1 break-all font-mono text-[12px] text-black">{row.value}</div>
                    </div>
                    <CopyValue value={row.value} />
                  </div>
                ))}
              </div>
            )}
            {isProvisionedValue(environment.summary.appUrl) ? (
              <a
                href={environment.summary.appUrl.startsWith('http') ? environment.summary.appUrl : `http://${environment.summary.appUrl}`}
                target="_blank"
                rel="noreferrer"
                className={`${appBtnPaper} self-start`}
              >
                <ExternalLink className="h-3.5 w-3.5" /> {environment.summary.appUrl}
              </a>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-neutral-500">
            {environment.runId ? 'Terraform destroy available' : 'Runtime cleanup available'}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setExpandedId(expanded ? null : `iac-${environment.projectId}`)}
              className={`${expanded ? appBtnInk : appBtnPaper} h-8 px-3 text-xs`}
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} Outputs
            </button>
            <button type="button" className={`${appBtnPaper} h-8 px-3 text-xs`} onClick={() => openDeploy(environment.projectId, 'terraform')}>
              Open in Deploy
            </button>
            <button
              type="button"
              onClick={() => void handleDestroy(environment)}
              disabled={destroyBusy}
              className={`${appBtnPaper} h-8 px-3 text-xs`}
            >
              <Trash2 className="h-3.5 w-3.5" /> {destroyBusy ? 'Destroying…' : 'Destroy stack'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const history = useMemo(() => {
    const rows: Array<{ id: string; repo: string; branch: string; status: 'success' | 'failed'; time: string; detail: string }> = [];
    for (const record of liveRecords.concat(applyingRecords)) {
      const project = projects.find((item) => item.id === record.projectId);
      for (const entry of record.snapshot.deploymentHistory) {
        rows.push({
          id: `${record.projectId}-${entry.id}`,
          repo: record.projectName,
          branch: project?.branch || 'main',
          status: entry.status === 'done' ? 'success' : 'failed',
          time: relativeTimeLabel(entry.createdAt, nowMs),
          detail: isIacPipelineResult(entry.deployResult) ? 'IaC pipeline' : 'Terraform apply',
        });
      }
    }
    return rows.slice(0, 16);
  }, [applyingRecords, liveRecords, nowMs, projects]);

  const body = (
    <div className="custom-scrollbar flex-1 overflow-y-auto p-8">
      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-4">
        <StatCard label="Live environments" value={scopedEnvironments.length} />
        <StatCard label="Running instances" value={runningCount} />
        <StatCard label="Compute in use" value={totalVcpu} suffix="vCPU" />
        <StatCard label="IaC stacks" value={iacStackCount} />
      </div>

      {toolbar}

      {requestedProjectId ? (
        <div className="mb-4 flex items-center justify-between border-[3px] border-black bg-white px-4 py-2 text-sm">
          <span>Showing the selected project only.</span>
          <button type="button" className="font-bold underline" onClick={() => replaceQuery({ projectId: '' })}>
            View all
          </button>
        </div>
      ) : null}

      {!hasAwsCreds && liveRecords.length > 0 ? (
        <div className="mb-4 border-[3px] border-black bg-white px-4 py-3 text-sm text-neutral-700">
          AWS credentials from Deploy are required to refresh live instance state and run start/stop/destroy.
        </div>
      ) : null}

      {notice ? (
        <div className="mb-4 border-[3px] border-black bg-white px-4 py-3 text-sm text-black">{notice}</div>
      ) : null}

      {applyingForScope.length > 0 ? (
        <div className="mb-4 border-[3px] border-black bg-white p-4">
          <p className="text-sm font-bold text-black">Apply in progress</p>
          <p className="mt-1 text-sm text-neutral-600">
            Instance and IaC management unlock when this apply finishes.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {applyingForScope.map((record) => (
              <button
                key={record.projectId}
                type="button"
                className={appBtnPaper}
                onClick={() => openDeploy(record.projectId, 'deploy')}
              >
                {record.projectName} →
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {emptyBecauseNoApply ? emptyState : tab === 'runtime' ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {instances.map(renderInstanceCard)}
            {instances.length === 0 && scopedEnvironments.length > 0 ? (
              <div className={`${appPaper} p-8 text-sm text-neutral-600`}>
                This apply did not provision an EC2 instance. Manage the Terraform stack from the IaC tab.
                <div className="mt-4">
                  <button type="button" className={appBtnInk} onClick={() => { setTab('iac'); replaceQuery({ tab: 'iac' }); }}>
                    Open IaC stacks
                  </button>
                </div>
              </div>
            ) : null}
            {instances.length === 0 && scopedEnvironments.length === 0 && applyingForScope.length === 0 ? (
              <div className={`${appPaper} p-8 text-sm text-neutral-600`}>No matching runtime instances.</div>
            ) : null}
          </div>
          <div className="lg:col-span-1">
            <div className={`${appPaper} sticky top-4 flex max-h-[calc(100vh-220px)] flex-col`}>
              <div className="border-b-[3px] border-black p-4">
                <h3 className="font-display text-sm font-semibold text-black">Apply history</h3>
              </div>
              <div className="custom-scrollbar flex-1 overflow-y-auto p-4">
                {history.length === 0 ? (
                  <p className="text-sm text-neutral-600">History appears after the first apply.</p>
                ) : (
                  <div className="space-y-3">
                    {history.map((log) => (
                      <div key={log.id} className="border-[3px] border-black p-3">
                        <div className="mb-1 flex items-start justify-between gap-2">
                          <span className="text-xs font-bold text-black">{log.repo}</span>
                          <span className="font-mono text-[10px] text-neutral-500">{log.time}</span>
                        </div>
                        <p className="text-[11px] text-neutral-600">
                          {log.detail} · <span className="font-mono text-black">{log.branch}</span>
                        </p>
                        <div className="mt-2 flex items-center gap-1.5 text-[10px] font-bold uppercase">
                          {log.status === 'success' ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                          {log.status}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {scopedEnvironments.map(renderIacCard)}
          {scopedEnvironments.length === 0 ? (
            <div className={`${appPaper} p-8 text-sm text-neutral-600`}>No applied Terraform stacks to manage yet.</div>
          ) : null}
        </div>
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <div className="instances-workspace flex h-full bg-white text-black">
      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <WorkspaceCommandHeader section="Instance Management" onExit={() => router.push('/dashboard')} />
        {body}
      </main>
    </div>
  );
}

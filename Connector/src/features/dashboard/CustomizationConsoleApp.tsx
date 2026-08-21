'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Lock, PanelLeftOpen } from 'lucide-react';
import { AgentPanel } from '@/features/customization/AgentPanel';
import { ByokDialog } from '@/features/customization/ByokDialog';
import {
  AUTO_APPLY_STORAGE_KEY,
  DEFAULT_APP_TARGETS,
  INITIAL_CHAT_TIMESTAMP,
  PROVIDER_TO_BACKEND_ID,
  REVERT_TO_BASE_CHAT_PATTERN,
  TENANT_STORAGE_KEY,
} from '@/features/customization/config';
import { PreviewPanel } from '@/features/customization/PreviewPanel';
import {
  AssetsPanel,
  ChangesPanel,
  ManifestPanel,
  QualityPanel,
  SettingsPanel,
  WorkspaceTabs,
} from '@/features/customization/WorkspacePanels';
import {
  CommandHeader,
  HandoffDialog,
  StatusBar,
  WorkflowRail,
} from '@/features/customization/WorkspaceChrome';
import type {
  AssetPreview,
  AssetsListResponse,
  AssetType,
  ByokConfig,
  ByokProvider,
  ChatMessage,
  ChatResponse,
  ConfirmationState,
  ConfirmResponse,
  CustomizationHandoffRecord,
  DiffEntry,
  ImplementResponse,
  ImplementRunState,
  LoadingState,
  ManifestResponse,
  PreviewDevice,
  PreviewMetaResponse,
  PreviewPayload,
  QualityReport,
  ResolveRepoPathResponse,
  SnapshotMetadata,
  CustomizationPrResult,
  StatusState,
  UploadAssetResponse,
  WorkflowStage,
  WorkspaceTab,
} from '@/features/customization/types';
import {
  DEPLOY_STATE_STORAGE_PREFIX,
  extractDeploymentSummary,
  type DeployStateSnapshot,
} from '@/features/deployment/state';
import {
  formatUiText,
  getErrorMessage,
  isAssetType,
  nowStamp,
  parseJsonSafe,
  sanitizeManifestForDisplay,
  sanitizeTenantId,
} from '@/features/customization/utils';

const initialLoading: LoadingState = {
  chat: false,
  manifest: false,
  confirm: false,
  implement: false,
  repair: false,
  upload: false,
  resetSession: false,
  resetRepo: false,
};

const initialRun: ImplementRunState = {
  appTargets: [...DEFAULT_APP_TARGETS],
  validatorIssues: [],
  repairPassUsed: false,
  pipelineMode: 'hybrid',
};

export default function CustomizationConsoleApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const tenantFromQuery = useMemo(() => sanitizeTenantId(searchParams.get('tenantId') || ''), [searchParams]);
  const projectId = useMemo(() => searchParams.get('projectId') || '', [searchParams]);
  const projectName = useMemo(() => searchParams.get('projectName') || '', [searchParams]);
  const [tenantId, setTenantId] = useState('');
  const [confirmedTenantId, setConfirmedTenantId] = useState('');
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [manifest, setManifest] = useState<Record<string, unknown> | null>(null);
  const [diffs, setDiffs] = useState<DiffEntry[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [qualityReport, setQualityReport] = useState<QualityReport | null>(null);
  const [lastPreviewPayload, setLastPreviewPayload] = useState<PreviewPayload | null>(null);
  const [implementStatus, setImplementStatus] = useState<'idle' | 'success' | 'partial' | 'failed'>('idle');

  const [chatInput, setChatInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'agent',
      content: 'Workspace ready. Enter a workspace ID, then describe the customization you want to draft.',
      timestamp: INITIAL_CHAT_TIMESTAMP,
    },
  ]);

  const [assetType, setAssetType] = useState<AssetType>('logo_light');
  const [assets, setAssets] = useState<AssetPreview[]>([]);
  const [pendingAssetTypes, setPendingAssetTypes] = useState<AssetType[]>([]);
  const [implementRun, setImplementRun] = useState<ImplementRunState>(initialRun);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('preview');
  const [status, setStatus] = useState<StatusState>({ level: 'info', text: 'Enter a workspace ID to continue.' });
  const [resolvedRepoPath, setResolvedRepoPath] = useState('');
  const [previewNonce, setPreviewNonce] = useState(0);
  const [previewMeta, setPreviewMeta] = useState<PreviewMetaResponse | null>(null);
  const [previewMetaLoading, setPreviewMetaLoading] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>('desktop');
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [agentOpen, setAgentOpen] = useState(true);
  const [agentWidth, setAgentWidth] = useState(330);
  const [resizingAgent, setResizingAgent] = useState(false);
  const [showByok, setShowByok] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  const [autoApply, setAutoApply] = useState(false);
  const [loading, setLoading] = useState<LoadingState>(initialLoading);
  const [finalizing, setFinalizing] = useState(false);
  const [snapshot, setSnapshot] = useState<SnapshotMetadata | null>(null);
  const [deployedUrl, setDeployedUrl] = useState('');
  const [creatingGitPr, setCreatingGitPr] = useState(false);
  const [gitPrResult, setGitPrResult] = useState<CustomizationPrResult | null>(null);

  const [byokDraft, setByokDraft] = useState<{ provider: ByokProvider | ''; modelId: string; apiKey: string }>({
    provider: '',
    modelId: '',
    apiKey: '',
  });
  const [byokConfig, setByokConfig] = useState<ByokConfig | null>(null);

  const effectiveTenantId = useMemo(
    () => sanitizeTenantId(tenantId || tenantFromQuery || projectName || ''),
    [projectName, tenantFromQuery, tenantId],
  );
  const previewUrl = useMemo(() => {
    if (!projectId) return '';
    const tenantSegment = effectiveTenantId ? `_tenant/${encodeURIComponent(effectiveTenantId)}/` : '';
    return `/api/customization/preview/${encodeURIComponent(projectId)}/${tenantSegment}?v=${previewNonce}`;
  }, [effectiveTenantId, previewNonce, projectId]);
  const previewMetaUrl = useMemo(() => {
    if (!projectId) return '';
    const tenantSegment = effectiveTenantId ? `_tenant/${encodeURIComponent(effectiveTenantId)}/` : '';
    return `/api/customization/preview/${encodeURIComponent(projectId)}/${tenantSegment}?meta=1&v=${previewNonce}`;
  }, [effectiveTenantId, previewNonce, projectId]);

  const previewStarting = previewMeta?.preview_kind === 'live_server' && previewMeta.preview_status === 'starting';
  const previewFailed = previewMeta?.preview_kind === 'live_server' && previewMeta.preview_status === 'failed';
  const previewHeld = previewStarting || previewFailed || (previewMetaLoading && !previewMeta);
  const previewFrameSrc = previewHeld ? '' : previewUrl;
  const previewReady =
    (previewMeta?.preview_kind === 'live_server' && previewMeta.preview_status === 'ready') ||
    (previewMeta?.preview_kind === 'static_file' && Boolean(previewMeta.preview_entry)) ||
    lastPreviewPayload?.status === 'ready';
  const qualityAcceptable = qualityReport?.status === 'passed' || qualityReport?.status === 'warning';
  const isBusy = Object.values(loading).some(Boolean) || previewMetaLoading || finalizing;
  const displayManifest = useMemo(() => (manifest ? sanitizeManifestForDisplay(manifest) : null), [manifest]);

  const workflowStage = useMemo<WorkflowStage>(() => {
    if (!effectiveTenantId || !manifest) return 'draft';
    if (!isConfirmed) return 'review';
    if (loading.implement) return 'apply';
    if (implementStatus === 'idle') return 'apply';
    if (loading.repair || implementStatus === 'failed' || implementStatus === 'partial' || qualityReport?.status === 'failed') {
      return 'validate';
    }
    if (!previewReady) return 'preview';
    return 'ready';
  }, [
    effectiveTenantId,
    implementStatus,
    isConfirmed,
    loading.implement,
    loading.repair,
    manifest,
    previewReady,
    qualityReport?.status,
  ]);

  const refreshPreview = useCallback(() => setPreviewNonce(Date.now()), []);

  useEffect(() => {
    setPreviewNonce(Date.now());
    if (typeof window !== 'undefined') {
      setAutoApply(window.localStorage.getItem(AUTO_APPLY_STORAGE_KEY) === 'true');
    }
  }, []);

  useEffect(() => {
    if (!projectId || typeof window === 'undefined') {
      setDeployedUrl('');
      setSnapshot(null);
      return;
    }
    const storageKey = `${DEPLOY_STATE_STORAGE_PREFIX}${projectId}`;
    try {
      const handoff = JSON.parse(
        window.sessionStorage.getItem(`deplai.customization.handoff.${projectId}`) || 'null',
      ) as CustomizationHandoffRecord | null;
      if (
        handoff?.project_id === projectId
        && handoff.tenant_id === effectiveTenantId
        && handoff.snapshot_id
        && handoff.snapshot_path
      ) {
        setSnapshot({
          snapshot_id: handoff.snapshot_id,
          tenant_id: handoff.tenant_id,
          snapshot_path: handoff.snapshot_path,
          source_tree_hash: handoff.source_tree_hash,
          created_at: handoff.created_at,
          status: 'immutable',
        });
      } else {
        setSnapshot(null);
      }
    } catch {
      setSnapshot(null);
    }
    const loadDeployedUrl = () => {
      try {
        const state = JSON.parse(window.localStorage.getItem(storageKey) || 'null') as DeployStateSnapshot | null;
        const summary = extractDeploymentSummary(state?.deployResult || null);
        const url = summary.appUrl !== 'n/a' ? summary.appUrl : summary.cloudfrontUrl;
        setDeployedUrl(url !== 'n/a' ? url : '');
      } catch {
        setDeployedUrl('');
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) loadDeployedUrl();
    };
    loadDeployedUrl();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [effectiveTenantId, projectId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading.chat]);

  useEffect(() => {
    if (!resizingAgent) return;
    const handleMove = (event: MouseEvent) => setAgentWidth(Math.min(480, Math.max(280, event.clientX)));
    const handleUp = () => setResizingAgent(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [resizingAgent]);

  useEffect(() => {
    if (!previewMetaUrl) {
      setPreviewMeta(null);
      setPreviewMetaLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewMetaLoading(true);
    const load = async () => {
      try {
        const response = await fetch(previewMetaUrl, { cache: 'no-store' });
        const payload = await parseJsonSafe<PreviewMetaResponse>(response);
        if (!cancelled) setPreviewMeta(response.ok && payload?.source ? payload : null);
      } catch {
        if (!cancelled) setPreviewMeta(null);
      } finally {
        if (!cancelled) setPreviewMetaLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [previewMetaUrl]);

  useEffect(() => {
    if (!previewStarting) return;
    const timer = window.setTimeout(refreshPreview, 4000);
    return () => window.clearTimeout(timer);
  }, [previewNonce, previewStarting, refreshPreview]);

  const syncConfirmation = useCallback((confirmation?: ConfirmationState) => {
    const confirmed = Boolean(confirmation?.is_confirmed) && !confirmation?.has_unconfirmed_changes;
    setIsConfirmed(confirmed);
    setConfirmedTenantId(confirmed && confirmation?.confirmed_tenant_id ? confirmation.confirmed_tenant_id : '');
  }, []);

  const loadAssets = useCallback(async (activeTenantId: string, pendingTypes?: AssetType[]) => {
    const response = await fetch(`/api/customization/assets/${encodeURIComponent(activeTenantId)}`, { cache: 'no-store' });
    const payload = await parseJsonSafe<AssetsListResponse>(response);
    if (!response.ok) throw new Error(getErrorMessage(payload, 'Failed to load workspace assets.'));
    const nextAssets = Object.entries(payload?.assets || {})
      .filter(([key]) => isAssetType(key))
      .map(([key, value]) => ({
        assetType: key as AssetType,
        fileName: value.filename || `${key}.asset`,
        previewUrl: `/api/customization/assets/${encodeURIComponent(activeTenantId)}/${encodeURIComponent(key)}`,
        uploadedAt: nowStamp(),
        storedPath: value.filename ? `tenants/${activeTenantId}/assets/${value.filename}` : undefined,
      }));
    setAssets((previous) => {
      const pending = new Set(
        pendingTypes ?? previous.filter((asset) => asset.pending).map((asset) => asset.assetType),
      );
      return nextAssets.map((asset) => ({ ...asset, pending: pending.has(asset.assetType) }));
    });
  }, []);

  const fetchManifest = useCallback(
    async (overrideTenantId?: string, silent = false) => {
      const activeTenantId = sanitizeTenantId(overrideTenantId || tenantId);
      if (!activeTenantId) {
        setStatus({ level: 'warning', text: 'Enter a workspace ID before loading the manifest.' });
        return false;
      }
      setLoading((previous) => ({ ...previous, manifest: true }));
      if (!silent) setStatus({ level: 'info', text: 'Loading manifest…' });
      try {
        const response = await fetch(`/api/customization/manifest?tenant_id=${encodeURIComponent(activeTenantId)}`, {
          cache: 'no-store',
        });
        const payload = await parseJsonSafe<ManifestResponse>(response);
        if (!response.ok || !payload?.manifest) throw new Error(getErrorMessage(payload, 'Failed to fetch manifest.'));
        setManifest(payload.manifest);
        syncConfirmation(payload.confirmation);
        await loadAssets(activeTenantId);
        if (!silent) setStatus({ level: 'success', text: 'Manifest loaded.' });
        return true;
      } catch (error) {
        setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to fetch manifest.' });
        return false;
      } finally {
        setLoading((previous) => ({ ...previous, manifest: false }));
      }
    },
    [loadAssets, syncConfirmation, tenantId],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = sanitizeTenantId(window.localStorage.getItem(TENANT_STORAGE_KEY) || '');
    const initialTenant = tenantFromQuery || sanitizeTenantId(projectName) || saved;
    if (!initialTenant) return;
    setTenantId(initialTenant);
    window.localStorage.setItem(TENANT_STORAGE_KEY, initialTenant);
    setMessages([{ role: 'agent', content: `Workspace loaded: ${initialTenant}.`, timestamp: nowStamp() }]);
    setStatus({ level: 'info', text: `Restored workspace ${initialTenant}.` });
    void fetchManifest(initialTenant, true);
  }, [fetchManifest, projectName, tenantFromQuery]);

  useEffect(() => {
    if (!projectId) {
      setResolvedRepoPath('');
      return;
    }
    let cancelled = false;
    const resolve = async () => {
      try {
        const response = await fetch(`/api/customization/resolve-repo-path?project_id=${encodeURIComponent(projectId)}`, {
          cache: 'no-store',
        });
        const payload = await parseJsonSafe<ResolveRepoPathResponse>(response);
        if (!cancelled) setResolvedRepoPath(response.ok && payload?.base_repo_path ? payload.base_repo_path : '');
      } catch {
        if (!cancelled) setResolvedRepoPath('');
      }
    };
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const clearRunResults = useCallback(() => {
    setDiffs([]);
    setErrors([]);
    setWarnings([]);
    setQualityReport(null);
    setLastPreviewPayload(null);
    setImplementStatus('idle');
    setImplementRun(initialRun);
  }, []);

  const handleTenantChange = useCallback(
    (value: string) => {
      const next = sanitizeTenantId(value);
      setTenantId(next);
      if (typeof window !== 'undefined') {
        if (next) window.localStorage.setItem(TENANT_STORAGE_KEY, next);
        else window.localStorage.removeItem(TENANT_STORAGE_KEY);
      }
      setManifest(null);
      setIsConfirmed(false);
      setConfirmedTenantId('');
      setAssets([]);
      setPendingAssetTypes([]);
      setSnapshot(null);
      clearRunResults();
      setMessages(
        next
          ? [{ role: 'agent', content: `Workspace set to ${next}. Load the manifest or send an instruction.`, timestamp: nowStamp() }]
          : [{ role: 'agent', content: 'Enter a workspace ID to begin.', timestamp: nowStamp() }],
      );
      setStatus({ level: next ? 'info' : 'warning', text: next ? 'Workspace updated.' : 'Enter a workspace ID to continue.' });
    },
    [clearRunResults],
  );

  const confirmManifest = useCallback(async () => {
    const activeTenantId = sanitizeTenantId(tenantId);
    if (!activeTenantId) {
      setStatus({ level: 'warning', text: 'Enter a workspace ID before confirming.' });
      return false;
    }
    setLoading((previous) => ({ ...previous, confirm: true }));
    setStatus({ level: 'info', text: 'Confirming manifest…' });
    try {
      const response = await fetch('/api/customization/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: activeTenantId }),
      });
      const payload = await parseJsonSafe<ConfirmResponse>(response);
      if (!response.ok || !payload) throw new Error(getErrorMessage(payload, 'Failed to confirm manifest.'));
      syncConfirmation(payload.confirmation);
      setConfirmedTenantId(payload.tenant_id);
      setIsConfirmed(true);
      setStatus({ level: 'success', text: 'Manifest confirmed. Ready to apply.', details: payload.path });
      return true;
    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to confirm manifest.' });
      return false;
    } finally {
      setLoading((previous) => ({ ...previous, confirm: false }));
    }
  }, [syncConfirmation, tenantId]);

  const runImplementation = useCallback(
    async (options?: { isRepairPass?: boolean; validatorIssues?: string[]; skipConfirmCheck?: boolean }) => {
      const activeTenantId = sanitizeTenantId(confirmedTenantId || tenantId);
      if (!activeTenantId) {
        setStatus({ level: 'warning', text: 'Enter a workspace ID before applying changes.' });
        return null;
      }
      if (!options?.skipConfirmCheck && !isConfirmed) {
        setStatus({ level: 'error', text: 'Confirm the manifest before applying changes.' });
        return null;
      }
      if (!implementRun.appTargets.length) {
        setStatus({ level: 'error', text: 'Select at least one application target in Settings.' });
        setActiveTab('settings');
        return null;
      }
      const repair = Boolean(options?.isRepairPass);
      const validatorIssues = (options?.validatorIssues || []).filter((issue) => issue.trim());
      setLoading((previous) => ({ ...previous, implement: !repair, repair }));
      setStatus({ level: 'info', text: repair ? 'Running repair pass…' : 'Applying confirmed changes…' });
      try {
        const response = await fetch('/api/customization/implement', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenant_id: activeTenantId,
            project_id: projectId || undefined,
            app_targets: implementRun.appTargets,
            validator_issues: validatorIssues.length ? validatorIssues : undefined,
            pipeline_mode: implementRun.pipelineMode,
            run_quality_gates: true,
            start_preview: true,
            ...(byokConfig
              ? {
                  llm_config: {
                    provider: PROVIDER_TO_BACKEND_ID[byokConfig.provider],
                    model: byokConfig.modelId,
                    api_key: byokConfig.apiKey,
                  },
                }
              : {}),
          }),
        });
        const payload = await parseJsonSafe<ImplementResponse>(response);
        if (!response.ok || !payload) throw new Error(getErrorMessage(payload, 'Implementation failed.'));

        const nextDiffs = Array.isArray(payload.modified_file_diffs)
          ? payload.modified_file_diffs.filter((entry) => entry && typeof entry.file === 'string' && typeof entry.diff === 'string')
          : [];
        const nextErrors = Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === 'string' && item.trim()) : [];
        const nextWarnings = Array.isArray(payload.warnings) ? payload.warnings.filter((item) => typeof item === 'string' && item.trim()) : [];
        const validatorIssuesFromRun = nextErrors.filter(
          (issue) => issue.startsWith('Validator issue') || issue.startsWith('[Validator]'),
        );

        setDiffs(nextDiffs);
        setErrors(nextErrors);
        setWarnings(nextWarnings);
        setQualityReport(payload.quality_report || null);
        setLastPreviewPayload(payload.preview || null);
        setActiveTab(nextErrors.length ? 'quality' : 'changes');

        if (validatorIssuesFromRun.length && !repair) {
          setImplementRun((previous) => ({ ...previous, validatorIssues: validatorIssuesFromRun, repairPassUsed: false }));
          setImplementStatus('partial');
          setStatus({
            level: 'warning',
            text: 'Validation found repairable issues.',
            details: `${validatorIssuesFromRun.length} issue(s) require operator approval.`,
          });
          return null;
        }
        if (nextErrors.length) {
          setImplementStatus('failed');
          setStatus({
            level: 'error',
            text: repair ? 'Repair completed with remaining issues.' : 'Implementation completed with errors.',
            details: nextErrors.join(' | '),
          });
          return null;
        }

        setImplementRun((previous) => ({
          ...previous,
          validatorIssues: [],
          repairPassUsed: repair ? true : previous.repairPassUsed,
        }));
        setImplementStatus(payload.status === 'no_changes' ? 'partial' : 'success');
        setPendingAssetTypes([]);
        setAssets((previous) => previous.map((asset) => ({ ...asset, pending: false })));
        setStatus({
          level: nextWarnings.length || payload.preview?.status === 'failed' ? 'warning' : 'success',
          text:
            payload.status === 'no_changes'
              ? 'Apply completed with no file changes.'
              : nextWarnings.length
                ? 'Changes applied with warnings.'
                : 'Changes applied successfully.',
          details: [
            payload.base_repo_path,
            payload.pipeline_mode ? `mode=${payload.pipeline_mode}` : '',
            payload.quality_report?.status ? `quality=${payload.quality_report.status}` : '',
            payload.preview?.status ? `preview=${payload.preview.status}` : '',
          ]
            .filter(Boolean)
            .join(' | '),
        });
        refreshPreview();
        await fetchManifest(activeTenantId, true);
        return payload;
      } catch (error) {
        setImplementStatus('failed');
        setActiveTab('quality');
        setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Implementation failed.' });
        return null;
      } finally {
        setLoading((previous) => ({ ...previous, implement: false, repair: false }));
      }
    },
    [
      byokConfig,
      confirmedTenantId,
      fetchManifest,
      implementRun.appTargets,
      implementRun.pipelineMode,
      isConfirmed,
      projectId,
      refreshPreview,
      tenantId,
    ],
  );

  const applyChanges = useCallback(async () => {
    let confirmed = isConfirmed;
    if (!confirmed) confirmed = await confirmManifest();
    if (!confirmed) return false;
    return runImplementation({ skipConfirmCheck: true });
  }, [confirmManifest, isConfirmed, runImplementation]);

  const handleExplicitConfirm = useCallback(async () => {
    const confirmed = await confirmManifest();
    if (confirmed && autoApply) {
      setMessages((previous) => [
        ...previous,
        { role: 'agent', content: 'Manifest confirmed. Starting your approved auto-apply preference.', timestamp: nowStamp() },
      ]);
      await runImplementation({ skipConfirmCheck: true });
    }
  }, [autoApply, confirmManifest, runImplementation]);

  const resetSession = useCallback(async () => {
    const activeTenantId = sanitizeTenantId(tenantId);
    if (!activeTenantId) return;
    if (!window.confirm('Reset the manifest and agent session? Applied repository files will be preserved.')) return;
    setLoading((previous) => ({ ...previous, resetSession: true }));
    setStatus({ level: 'warning', text: 'Resetting session…' });
    try {
      const response = await fetch('/api/customization/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: activeTenantId }),
      });
      const payload = await parseJsonSafe<ManifestResponse>(response);
      if (!response.ok || !payload?.manifest) throw new Error(getErrorMessage(payload, 'Failed to reset session.'));
      setManifest(payload.manifest);
      syncConfirmation(payload.confirmation);
      setPendingAssetTypes([]);
      setAssets((previous) => previous.map((asset) => ({ ...asset, pending: false })));
      clearRunResults();
      setMessages([{ role: 'agent', content: 'Session reset. Repository files were preserved.', timestamp: nowStamp() }]);
      setStatus({ level: 'success', text: 'Session reset; workspace copy preserved.' });
      setActiveTab('manifest');
    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to reset session.' });
    } finally {
      setLoading((previous) => ({ ...previous, resetSession: false }));
    }
  }, [clearRunResults, syncConfirmation, tenantId]);

  const resetRepository = useCallback(
    async (options?: { suppressPrompt?: boolean; preserveChat?: boolean }) => {
      const activeTenantId = sanitizeTenantId(tenantId);
      if (!activeTenantId) return false;
      if (!options?.suppressPrompt && !window.confirm('Reset the workspace copy to the base repository? This removes applied customizations.')) {
        return false;
      }
      setLoading((previous) => ({ ...previous, resetRepo: true }));
      setStatus({ level: 'warning', text: 'Resetting workspace copy…' });
      try {
        const response = await fetch('/api/customization/reset-repo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenant_id: activeTenantId, project_id: projectId || undefined }),
        });
        const payload = await parseJsonSafe<
          ManifestResponse & { repo_path?: string; tenant_id?: string }
        >(response);
        if (!response.ok || !payload) throw new Error(getErrorMessage(payload, 'Failed to reset repository.'));
        if (payload.manifest) setManifest(payload.manifest);
        syncConfirmation(payload.confirmation);
        setPendingAssetTypes([]);
        clearRunResults();
        await loadAssets(activeTenantId, []);
        refreshPreview();
        const resetMessage = 'Workspace copy reset to the base repository.';
        setMessages((previous) =>
          options?.preserveChat
            ? [...previous, { role: 'agent', content: resetMessage, timestamp: nowStamp() }]
            : [{ role: 'agent', content: resetMessage, timestamp: nowStamp() }],
        );
        setStatus({ level: 'success', text: resetMessage, details: payload.repo_path });
        return true;
      } catch (error) {
        setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to reset repository.' });
        return false;
      } finally {
        setLoading((previous) => ({ ...previous, resetRepo: false }));
      }
    },
    [clearRunResults, loadAssets, projectId, refreshPreview, syncConfirmation, tenantId],
  );

  const handleChatSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const activeTenantId = sanitizeTenantId(tenantId);
      const message = chatInput.trim();
      if (!activeTenantId || !message) return;
      setMessages((previous) => [...previous, { role: 'user', content: message, timestamp: nowStamp() }]);
      setChatInput('');
      if (REVERT_TO_BASE_CHAT_PATTERN.test(message)) {
        await resetRepository({ suppressPrompt: true, preserveChat: true });
        return;
      }
      setLoading((previous) => ({ ...previous, chat: true }));
      setStatus({ level: 'info', text: 'Drafting manifest changes…' });
      try {
        const response = await fetch('/api/customization/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenant_id: activeTenantId,
            message,
            ...(byokConfig
              ? {
                  llm_config: {
                    provider: PROVIDER_TO_BACKEND_ID[byokConfig.provider],
                    model: byokConfig.modelId,
                    api_key: byokConfig.apiKey,
                  },
                }
              : {}),
          }),
        });
        const payload = await parseJsonSafe<ChatResponse>(response);
        if (!response.ok) throw new Error(getErrorMessage(payload, 'Failed to send instruction.'));
        setMessages((previous) => [
          ...previous,
          {
            role: 'agent',
            content: `${payload?.response || 'Manifest updated.'}\n\nReview the manifest, then confirm it when ready.`,
            timestamp: nowStamp(),
          },
        ]);
        if (payload?.manifest) setManifest(payload.manifest);
        syncConfirmation(payload?.confirmation);
        setImplementStatus('idle');
        await loadAssets(activeTenantId);
        setActiveTab('manifest');
        setStatus({ level: 'success', text: 'Draft updated. Review and confirm before applying.' });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Failed to send instruction.';
        setStatus({ level: 'error', text: messageText });
        setMessages((previous) => [
          ...previous,
          { role: 'agent', content: `Error: ${formatUiText(messageText)}`, timestamp: nowStamp() },
        ]);
      } finally {
        setLoading((previous) => ({ ...previous, chat: false }));
      }
    },
    [byokConfig, chatInput, loadAssets, resetRepository, syncConfirmation, tenantId],
  );

  const handleAssetUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const activeTenantId = sanitizeTenantId(tenantId);
      if (!activeTenantId) {
        setStatus({ level: 'error', text: 'Enter a workspace ID before uploading an asset.' });
        return;
      }
      setLoading((previous) => ({ ...previous, upload: true }));
      setStatus({ level: 'info', text: `Uploading ${assetType}…` });
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('tenant_id', activeTenantId);
        formData.append('asset_type', assetType);
        const response = await fetch('/api/customization/assets/upload', { method: 'POST', body: formData });
        const payload = await parseJsonSafe<UploadAssetResponse>(response);
        if (!response.ok || !payload) throw new Error(getErrorMessage(payload, 'Asset upload failed.'));
        const nextPending = Array.from(new Set([...pendingAssetTypes, assetType]));
        setPendingAssetTypes(nextPending);
        syncConfirmation(payload.confirmation);
        setIsConfirmed(false);
        await fetchManifest(activeTenantId, true);
        await loadAssets(activeTenantId, nextPending);
        setStatus({ level: 'warning', text: `${assetType} uploaded and pending. Confirm and apply to update the preview.` });
      } catch (error) {
        setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to upload asset.' });
      } finally {
        setLoading((previous) => ({ ...previous, upload: false }));
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [assetType, fetchManifest, loadAssets, pendingAssetTypes, syncConfirmation, tenantId],
  );

  const selectWorkflowStage = useCallback((stage: WorkflowStage) => {
    if (stage === 'draft' || stage === 'review' || stage === 'apply') setActiveTab('manifest');
    else if (stage === 'validate') setActiveTab('quality');
    else setActiveTab('preview');
  }, []);

  const updateAutoApply = useCallback((next: boolean) => {
    setAutoApply(next);
    if (typeof window !== 'undefined') window.localStorage.setItem(AUTO_APPLY_STORAGE_KEY, String(next));
  }, []);

  const finalizeSnapshotAndContinue = useCallback(async () => {
    const activeTenantId = sanitizeTenantId(effectiveTenantId);
    if (!projectId || !activeTenantId || !manifest) {
      setStatus({ level: 'error', text: 'A project, workspace, and manifest are required before finalization.' });
      return;
    }

    setFinalizing(true);
    setStatus({ level: 'info', text: 'Finalizing an immutable deployment snapshot…' });
    try {
      let confirmed = isConfirmed;
      if (!confirmed) confirmed = await confirmManifest();
      if (!confirmed) throw new Error('The current manifest could not be confirmed.');

      let quality = qualityReport;
      let ready = previewReady;
      if (!isConfirmed || implementStatus !== 'success' || !qualityAcceptable) {
        const implementation = await runImplementation({ skipConfirmCheck: true });
        if (!implementation) throw new Error('The confirmed draft could not be applied cleanly.');
        quality = implementation.quality_report || null;
        ready = implementation.preview?.status === 'ready';
      }

      const acceptable = quality?.status === 'passed' || quality?.status === 'warning';
      if (!acceptable) {
        throw new Error(`Quality gates must pass before snapshot creation (status: ${quality?.status || 'not run'}).`);
      }

      if (!ready) {
        for (let attempt = 0; attempt < 10 && !ready; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          const response = await fetch(previewMetaUrl, { cache: 'no-store' });
          const preview = await parseJsonSafe<PreviewMetaResponse>(response);
          if (!response.ok) continue;
          setPreviewMeta(preview || null);
          ready =
            (preview?.preview_kind === 'live_server' && preview.preview_status === 'ready')
            || (preview?.preview_kind === 'static_file' && Boolean(preview.preview_entry));
          if (preview?.preview_status === 'failed') {
            throw new Error(preview.preview_error || 'Preview failed while finalizing the snapshot.');
          }
        }
      }
      if (!ready) throw new Error('Preview is not ready. Wait for it to start, then finalize again.');

      const response = await fetch('/api/customization/snapshots/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          tenant_id: activeTenantId,
          quality_report: quality,
        }),
      });
      const payload = await parseJsonSafe<SnapshotMetadata & { snapshot?: SnapshotMetadata }>(response);
      const created = payload?.snapshot || payload;
      if (!response.ok || !created?.snapshot_id || !created.snapshot_path) {
        throw new Error(getErrorMessage(payload, 'Immutable snapshot creation failed.'));
      }

      setSnapshot(created);
      const handoff: CustomizationHandoffRecord = {
        project_id: projectId,
        tenant_id: activeTenantId,
        snapshot_id: created.snapshot_id,
        snapshot_path: created.snapshot_path,
        source_tree_hash: created.source_tree_hash,
        created_at: created.created_at || new Date().toISOString(),
        status: 'ready_for_security',
      };
      window.sessionStorage.setItem(
        `deplai.customization.handoff.${projectId}`,
        JSON.stringify(handoff),
      );
      setStatus({
        level: 'success',
        text: 'Immutable snapshot created. Opening security analysis…',
        details: `${created.snapshot_id} | ${created.snapshot_path}`,
      });
      const query = new URLSearchParams({
        runAll: '1',
        customizationSnapshotId: created.snapshot_id,
        tenantId: activeTenantId,
      });
      router.push(`/dashboard/security-analysis/${encodeURIComponent(projectId)}?${query.toString()}`);
    } catch (error) {
      setStatus({
        level: 'error',
        text: error instanceof Error ? error.message : 'Snapshot finalization failed.',
      });
    } finally {
      setFinalizing(false);
    }
  }, [
    confirmManifest,
    effectiveTenantId,
    implementStatus,
    isConfirmed,
    manifest,
    previewMetaUrl,
    previewReady,
    projectId,
    qualityAcceptable,
    qualityReport,
    router,
    runImplementation,
  ]);

  const createGitPr = useCallback(async () => {
    if (!projectId || !effectiveTenantId || !snapshot?.snapshot_id || creatingGitPr) return;
    setCreatingGitPr(true);
    setStatus({ level: 'info', text: 'Creating optional GitHub PR from the immutable snapshot…' });
    try {
      const response = await fetch('/api/customization/snapshots/git-pr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          tenant_id: effectiveTenantId,
          snapshot_id: snapshot.snapshot_id,
        }),
      });
      const payload = await parseJsonSafe<CustomizationPrResult>(response);
      if (!response.ok || !payload) {
        throw new Error(getErrorMessage(payload, 'Git PR creation failed.'));
      }
      setGitPrResult(payload);
      setStatus({
        level: payload.success ? 'success' : 'warning',
        text: payload.success
          ? 'Optional Git PR created from the customization snapshot.'
          : payload.reason === 'local_project'
            ? 'Git PR skipped for local projects.'
            : payload.error || 'Git PR was not created.',
        details: payload.pr_url || payload.branch || undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Git PR creation failed.';
      setGitPrResult({
        attempted: true,
        success: false,
        pr_url: null,
        branch: null,
        error: message,
      });
      setStatus({ level: 'error', text: message });
    } finally {
      setCreatingGitPr(false);
    }
  }, [creatingGitPr, effectiveTenantId, projectId, snapshot?.snapshot_id]);

  const canFinalize = Boolean(
    projectId &&
      effectiveTenantId &&
      manifest &&
      !isBusy,
  );

  return (
    <div className="customization-workspace flex h-screen min-h-[560px] flex-col overflow-hidden bg-[#09090b] font-sans text-zinc-300">
      <style>{`
        .customization-workspace { --font-sans: 'Noto Sans', sans-serif; --font-display: 'Space Grotesk', sans-serif; --font-mono: 'JetBrains Mono', monospace; }
        .customization-workspace h1, .customization-workspace h2 { font-family: var(--font-display); }
        .customization-scrollbar { scrollbar-width: thin; scrollbar-color: #27272a transparent; }
        .customization-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
        .customization-scrollbar::-webkit-scrollbar-thumb { background: #27272a; border-radius: 999px; }
        @media (prefers-reduced-motion: reduce) {
          .customization-workspace *, .customization-workspace *::before, .customization-workspace *::after {
            scroll-behavior: auto !important; animation-duration: 0.01ms !important; transition-duration: 0.01ms !important;
          }
        }
      `}</style>
      <CommandHeader
        projectLabel={projectName || projectId}
        tenantId={tenantId}
        onTenantChange={handleTenantChange}
        onBack={() => router.push('/dashboard')}
        onConfirm={() => void handleExplicitConfirm()}
        onApply={() => void applyChanges()}
        onOpenHandoff={() => setShowHandoff(true)}
        isConfirmed={isConfirmed}
        hasManifest={Boolean(manifest)}
        isBusy={isBusy}
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <WorkflowRail
          currentStage={workflowStage}
          collapsed={railCollapsed}
          onToggle={() => setRailCollapsed((previous) => !previous)}
          onSelectStage={selectWorkflowStage}
        />
        <AgentPanel
          open={agentOpen}
          width={agentWidth}
          messages={messages}
          input={chatInput}
          loading={loading.chat}
          disabled={!tenantId.trim()}
          byokLabel={byokConfig ? byokConfig.provider : 'BYOK'}
          chatEndRef={chatEndRef}
          onInputChange={setChatInput}
          onSubmit={handleChatSubmit}
          onClose={() => setAgentOpen(false)}
          onOpenByok={() => setShowByok(true)}
          onResetSession={() => void resetSession()}
          onResizeStart={() => setResizingAgent(true)}
        />
        <main className="relative flex min-w-0 flex-1 flex-col">
          {!agentOpen && (
            <button
              type="button"
              onClick={() => setAgentOpen(true)}
              aria-label="Open agent panel"
              className="absolute left-2 top-1.5 z-20 rounded-md border border-white/10 bg-[#111113] p-2 text-zinc-500 shadow-lg hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"
            >
              <PanelLeftOpen className="h-3.5 w-3.5" />
            </button>
          )}
          <WorkspaceTabs
            active={activeTab}
            onChange={setActiveTab}
            errorCount={errors.length}
            pendingAssetCount={pendingAssetTypes.length}
          />
          <div className="relative min-h-0 flex-1">
            {!tenantId.trim() && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#09090b]/90 p-6 backdrop-blur-sm">
                <div className="max-w-sm rounded-xl border border-white/10 bg-[#111113] p-6 text-center shadow-2xl">
                  <Lock className="mx-auto h-6 w-6 text-zinc-600" />
                  <h1 className="mt-3 text-base font-semibold text-zinc-100">Workspace ID required</h1>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">Enter a workspace ID in the command header to unlock customization controls.</p>
                </div>
              </div>
            )}
            {activeTab === 'preview' && (
              <PreviewPanel
                device={previewDevice}
                meta={previewMeta}
                metaLoading={previewMetaLoading}
                frameSrc={previewFrameSrc}
                previewUrl={previewUrl}
                onDeviceChange={setPreviewDevice}
                onRefresh={refreshPreview}
              />
            )}
            {activeTab === 'changes' && <ChangesPanel entries={diffs} />}
            {activeTab === 'quality' && (
              <QualityPanel
                errors={errors}
                warnings={warnings}
                report={qualityReport}
                validatorIssues={implementRun.validatorIssues}
                repairing={loading.repair}
                onRepair={() =>
                  void runImplementation({
                    isRepairPass: true,
                    validatorIssues: implementRun.validatorIssues,
                    skipConfirmCheck: true,
                  })
                }
              />
            )}
            {activeTab === 'manifest' && (
              <ManifestPanel
                manifest={displayManifest}
                confirmed={isConfirmed}
                loading={loading.manifest || loading.confirm}
                onReload={() => void fetchManifest()}
                onConfirm={() => void handleExplicitConfirm()}
              />
            )}
            {activeTab === 'assets' && (
              <AssetsPanel
                assetType={assetType}
                assets={assets}
                loading={loading}
                fileInputRef={fileInputRef}
                onAssetTypeChange={setAssetType}
                onUpload={handleAssetUpload}
                onChooseFile={() => fileInputRef.current?.click()}
                onApplyNow={() => void applyChanges()}
              />
            )}
            {activeTab === 'settings' && (
              <SettingsPanel
                run={implementRun}
                autoApply={autoApply}
                resolvedRepoPath={resolvedRepoPath}
                onRunChange={setImplementRun}
                onAutoApplyChange={updateAutoApply}
              />
            )}
          </div>
        </main>
      </div>
      <StatusBar
        status={status}
        busy={isBusy}
        onToggleAgent={() => setAgentOpen((previous) => !previous)}
        onResetSession={() => void resetSession()}
        onResetRepo={() => void resetRepository()}
      />
      <ByokDialog
        open={showByok}
        config={byokConfig}
        draft={byokDraft}
        onDraftChange={setByokDraft}
        onSave={() => {
          if (!byokDraft.provider || !byokDraft.modelId || !byokDraft.apiKey.trim()) return;
          setByokConfig({
            provider: byokDraft.provider,
            modelId: byokDraft.modelId,
            apiKey: byokDraft.apiKey.trim(),
          });
        }}
        onClear={() => {
          setByokConfig(null);
          setByokDraft({ provider: '', modelId: '', apiKey: '' });
        }}
        onClose={() => setShowByok(false)}
      />
      <HandoffDialog
        open={showHandoff}
        onClose={() => setShowHandoff(false)}
        onContinue={() => void finalizeSnapshotAndContinue()}
        onCreateGitPr={() => void createGitPr()}
        tenantId={effectiveTenantId}
        manifestConfirmed={isConfirmed}
        changedFiles={diffs.length}
        quality={qualityReport}
        previewReady={previewReady}
        canContinue={canFinalize}
        finalizing={finalizing}
        creatingGitPr={creatingGitPr}
        snapshot={snapshot}
        gitPrResult={gitPrResult}
        deployedUrl={deployedUrl}
      />
    </div>
  );
}

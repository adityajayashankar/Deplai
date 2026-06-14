import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle,
  CheckCircle2,
  ChevronRight,
  Code2,
  FileJson,
  GitCompareArrows,
  Image as ImageIcon,
  Key,
  Loader2,
  Lock,
  MessageSquare,
  Monitor,
  Palette,
  Play,
  RefreshCcw,
  RefreshCw,
  Send,
  Settings,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Tablet,
  Upload,
  User,
  XCircle,
  Terminal,
  CircleDashed,
  Cpu,
  Search,
  Bell,
  PanelLeftClose,
  Maximize2,
  ExternalLink,
  Settings2,
  FolderTree,
  MoreHorizontal,
  Activity,
  GitBranch,
  Command,
  SendHorizontal,
  RotateCcw,
  Check,
  Copy,
  Layers,
  Wrench,
  Microscope,
  FileCode2,
  FileText,
  UploadCloud,
  Trash2,
  Download,
  Braces,
  LayoutTemplate
} from 'lucide-react';

/* ═══════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════ */

// [Include all types from the old file here...]
type StatusLevel = 'info' | 'success' | 'warning' | 'error';
type ChatMessage = { role: 'user' | 'agent'; content: string; timestamp: string; };
type StatusState = { level: StatusLevel; text: string; details?: string; };
type ConfirmationState = { confirmed_tenant_id?: string; has_unconfirmed_changes?: boolean; is_confirmed?: boolean; };
type AssetType = 'logo_light' | 'logo_dark' | 'favicon' | 'og_image' | 'hero_illustration' | 'why_background' | 'activities_background' | 'curated_image';
type AssetOption = { value: AssetType; label: string; };
type AssetPreview = { assetType: AssetType; fileName: string; previewUrl: string; uploadedAt: string; storedPath?: string; };
type PipelineMode = 'hybrid' | 'llm_only' | 'deterministic_only' | 'diagnostic';
type ImplementRunState = { appTargets: string[]; validatorIssues: string[]; repairPassUsed: boolean; pipelineMode: PipelineMode; };
type LoadingState = { chat: boolean; manifest: boolean; confirm: boolean; implement: boolean; repair: boolean; upload: boolean; resetSession: boolean; resetRepo: boolean; };
type ChatResponse = { response?: string; manifest?: Record<string, unknown>; confirmation?: ConfirmationState; tenant_id?: string; };
type ManifestResponse = { tenant_id?: string; manifest?: Record<string, unknown>; confirmation?: ConfirmationState; };
type ConfirmResponse = { tenant_id: string; path: string; confirmation?: ConfirmationState; };
type QualityReport = { status?: 'passed' | 'failed' | 'warning' | 'not_run'; checks?: Array<{ name?: string; status?: string; detail?: string }>; };
type PreviewPayload = { kind?: 'live_server' | 'static_file'; status?: 'ready' | 'unavailable' | 'failed' | 'stopped'; url?: string; detail?: string; };
type ImplementResponse = { status?: 'implementation_complete' | 'no_changes'; run_id?: string; pipeline_mode?: PipelineMode; tenant_id: string; app_targets?: string[]; base_repo_path?: string; errors?: string[]; modified_files?: string[]; modified_file_diffs?: Array<{ file: string; diff: string; truncated?: boolean; source?: string; operation?: string }>; change_sources?: Array<{ file: string; source: string; operation?: string }>; quality_report?: QualityReport; preview?: PreviewPayload; warnings?: string[]; plan_markdown_path?: string; };
type ResolveRepoPathResponse = { project_id: string; base_repo_path: string; };
type PreviewMetaResponse = { source?: 'base' | 'subspace'; base_repo_path?: string; tenant_repo_path?: string | null; tenant_repo_exists?: boolean; preview_root_path?: string; preview_entry?: string | null; preview_kind?: 'live_server' | 'static_file'; preview_url?: string | null; preview_status?: 'ready' | 'unavailable' | 'failed' | 'stopped' | 'starting'; preview_error?: string | null; preview_detail?: string | null; };
type AssetsListResponse = { tenant_id: string; assets?: Record<string, { filename?: string }>; };
type UploadAssetResponse = { tenant_id: string; asset_type: AssetType; stored_path: string; confirmation?: ConfirmationState; };

type PreviewDevice = 'desktop' | 'tablet' | 'mobile';
type WorkspaceTab = 'preview' | 'results' | 'manifest' | 'assets' | 'settings';
type ResultsSubTab = 'diffs' | 'errors' | 'quality';

/* ═══════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════ */

const TENANT_STORAGE_KEY = 'deplai.customization.tenant-id';
const DEFAULT_APP_TARGETS = ['frontend', 'admin-frontend', 'expert', 'corporates'];
const PIPELINE_MODE_OPTIONS = [
  { value: 'hybrid' as PipelineMode, label: 'Hybrid', description: 'LLM + deterministic', icon: Layers },
  { value: 'llm_only' as PipelineMode, label: 'LLM Only', description: 'AI-driven changes', icon: Bot },
  { value: 'deterministic_only' as PipelineMode, label: 'Deterministic', description: 'Rule-based only', icon: Wrench },
  { value: 'diagnostic' as PipelineMode, label: 'Diagnostic', description: 'Dry run & report', icon: Microscope },
];

/* Provider → Model map */
type ByokProvider = 'Anthropic' | 'OpenAI' | 'OpenRouter' | 'Groq' | 'MiniMax';
interface ByokModel { id: string; name: string; }
interface ByokConfig { provider: ByokProvider; modelId: string; apiKey: string; }

const PROVIDER_MODEL_MAP: Record<ByokProvider, ByokModel[]> = {
  Anthropic: [
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5 (Long-Context / Coding)' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (Balanced / Default)' },
    { id: 'claude-haiku-3-5', name: 'Claude Haiku 3.5 (Fast)' },
  ],
  OpenAI: [
    { id: 'gpt-4o', name: 'GPT-4o (Flagship)' },
    { id: 'gpt-4.1', name: 'GPT-4.1 (Latest)' },
    { id: 'o3-mini', name: 'o3-mini (Reasoning)' },
  ],
  Groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Versatile)' },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout (10M Context)' },
    { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2 (Coding)' },
  ],
  OpenRouter: [
    { id: 'anthropic/claude-opus-4-5', name: 'Claude Opus 4.5 (via OpenRouter)' },
    { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro (via OpenRouter)' },
    { id: 'openai/gpt-4o', name: 'GPT-4o (via OpenRouter)' },
  ],
  MiniMax: [
    { id: 'minimax-m3', name: 'MiniMax M3 (Latest / Agentic)' },
    { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
    { id: 'minimax-m2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
  ],
};

/* Map frontend provider name → backend provider id expected by callLLM */
const PROVIDER_TO_BACKEND_ID: Record<ByokProvider, string> = {
  Anthropic: 'claude',
  OpenAI: 'openai',
  Groq: 'groq',
  OpenRouter: 'openrouter',
  MiniMax: 'minimax',
};
const REVERT_TO_BASE_CHAT_PATTERN = /(revert|reset|restore|undo).*(original|base|default).*(ui|theme|frontend|site|design)/i;
const INITIAL_CHAT_TIMESTAMP = '--:--:--';
const CHAT_COMMAND_PRESETS = [
  'Change the landing headline to ',
  'Replace "Neural Atlas" with ',
  'Set primary theme color to #14b8a6',
  'Remove landing parts 6 to 10',
];
const PREVIEW_DEVICE_OPTIONS = [
  { value: 'desktop' as PreviewDevice, label: 'Desktop', icon: Monitor, width: 'w-full' },
  { value: 'tablet' as PreviewDevice, label: 'Tablet', icon: Tablet, width: 'w-[768px] max-w-full' },
  { value: 'mobile' as PreviewDevice, label: 'Mobile', icon: Smartphone, width: 'w-[390px] max-w-full' },
];
const ASSET_OPTIONS: AssetOption[] = [
  { value: 'logo_light', label: 'Logo (Light)' },
  { value: 'logo_dark', label: 'Logo (Dark)' },
  { value: 'favicon', label: 'Favicon' },
  { value: 'og_image', label: 'OG / Social Image' },
  { value: 'hero_illustration', label: 'Hero Illustration' },
  { value: 'why_background', label: 'Why Background' },
  { value: 'activities_background', label: 'Activities Background' },
  { value: 'curated_image', label: 'Curated Image' },
];
const WORKSPACE_TABS: Array<{ value: WorkspaceTab; label: string; icon: typeof Monitor }> = [
  { value: 'preview', label: 'Live Preview', icon: Monitor },
  { value: 'results', label: 'Code Diffs', icon: GitBranch },
  { value: 'manifest', label: 'manifest.json', icon: Braces },
  { value: 'assets', label: 'Assets', icon: ImageIcon },
  { value: 'settings', label: 'Settings', icon: Settings2 },
];

/* ═══════════════════════════════════════════════════
   UTILITY FUNCTIONS
   ═══════════════════════════════════════════════════ */

function nowStamp(): string { return new Date().toLocaleTimeString(); }
function sanitizeTenantId(raw: string): string { return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63); }
function isAssetType(value: string): value is AssetType { return ASSET_OPTIONS.some((option) => option.value === value); }
function getErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const body = payload as { error?: unknown; detail?: unknown; message?: unknown };
  if (typeof body.error === 'string' && body.error.trim()) return body.error;
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  if (typeof body.detail === 'string' && body.detail.trim()) return body.detail;
  if (body.detail && typeof body.detail === 'object') {
    const detailObj = body.detail as { message?: unknown; errors?: unknown };
    if (typeof detailObj.message === 'string' && detailObj.message.trim()) {
      if (Array.isArray(detailObj.errors) && detailObj.errors.length > 0) return `${detailObj.message} ${detailObj.errors.join(' | ')}`;
      return detailObj.message;
    }
  }
  return fallback;
}
function formatUiText(value: string): string {
  return value.replace(/Tenant Customization Operator/gi, 'Customization Operator').replace(/\bTenant ID\b/gi, 'Workspace ID').replace(/\bTenant key\b/gi, 'Workspace').replace(/\btenant key\b/gi, 'workspace').replace(/\bTenant repository\b/gi, 'Workspace copy').replace(/\btenant repository\b/gi, 'workspace copy').replace(/\bTenant repo\b/gi, 'Workspace copy').replace(/\btenant repo\b/gi, 'workspace copy').replace(/\bTenant required\b/gi, 'Workspace required').replace(/\btenant assets\b/gi, 'workspace assets').replace(/\bTenant\b/g, 'Workspace').replace(/\btenant\b/g, 'workspace').replace(/SubSpace-/g, 'Edited-').replace(/\bSubSpace\b/g, 'Edited Copy');
}
function sanitizeManifestForDisplay(manifest: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  if ('tenant_id' in clone) { clone.workspace_id = clone.tenant_id; delete clone.tenant_id; }
  if ('tenant_name' in clone) { clone.workspace_name = clone.tenant_name; delete clone.tenant_name; }
  const categories = clone.categories;
  if (categories && typeof categories === 'object') {
    const branding = (categories as { branding?: unknown }).branding;
    if (branding && typeof branding === 'object') {
      for (const [key, value] of Object.entries(branding as Record<string, unknown>)) {
        if (typeof value === 'string') { (branding as Record<string, unknown>)[key] = formatUiText(value); }
      }
    }
  }
  return clone;
}
function diffLineClassName(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-zinc-400';
  if (line.startsWith('@@')) return 'bg-sky-500/8 text-sky-300';
  if (line.startsWith('+')) return 'bg-emerald-500/8 text-emerald-300';
  if (line.startsWith('-')) return 'bg-rose-500/8 text-rose-300';
  return 'text-zinc-400';
}
async function parseJsonSafe<T>(response: Response): Promise<T | null> {
  try { return (await response.json()) as T; } catch { return null; }
}

export default function CustomizationConsoleApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const diffRefs = useRef<(HTMLDivElement | null)[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* ── Query params ── */
  const tenantFromQuery = useMemo(() => sanitizeTenantId(searchParams.get('tenantId') || ''), [searchParams]);
  const projectIdFromQuery = useMemo(() => searchParams.get('projectId') || '', [searchParams]);
  const projectNameFromQuery = useMemo(() => searchParams.get('projectName') || '', [searchParams]);
  const runAll = useMemo(() => searchParams.get('runAll') === '1', [searchParams]);
  const securityPath = useMemo(
    () => (projectIdFromQuery ? `/dashboard/security-analysis/${encodeURIComponent(projectIdFromQuery)}?runAll=1` : '/dashboard'),
    [projectIdFromQuery],
  );

  /* ── Core state ── */
  const [tenantId, setTenantId] = useState('');
  const [confirmedTenantId, setConfirmedTenantId] = useState('');
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [manifestJson, setManifestJson] = useState<Record<string, unknown> | null>(null);
  const [codeDiffEntries, setCodeDiffEntries] = useState<Array<{ file: string; diff: string; truncated?: boolean; source?: string; operation?: string }>>([]);
  const [lastImplementErrors, setLastImplementErrors] = useState<string[]>([]);
  const [lastImplementWarnings, setLastImplementWarnings] = useState<string[]>([]);
  const [lastQualityReport, setLastQualityReport] = useState<QualityReport | null>(null);
  const [lastPreviewPayload, setLastPreviewPayload] = useState<PreviewPayload | null>(null);
  const [lastImplementStatus, setLastImplementStatus] = useState<'idle' | 'success' | 'partial' | 'failed'>('idle');

  /* ── Chat state ── */
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { role: 'agent', content: 'Operator console initialized. Open from a repository card or enter a workspace ID.', timestamp: INITIAL_CHAT_TIMESTAMP },
  ]);

  /* ── Asset state ── */
  const [assetType, setAssetType] = useState<AssetType>('logo_light');
  const [uploadedAssetsSession, setUploadedAssetsSession] = useState<AssetPreview[]>([]);

  /* ── Implement state ── */
  const [implementRun, setImplementRun] = useState<ImplementRunState>({
    appTargets: [...DEFAULT_APP_TARGETS],
    validatorIssues: [],
    repairPassUsed: false,
    pipelineMode: 'hybrid',
  });

  /* ── UI state ── */
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('preview');
  const [resultsSubTab, setResultsSubTab] = useState<ResultsSubTab>('diffs');
  const [status, setStatus] = useState<StatusState>({ level: 'info', text: 'Enter workspace ID to continue.' });
  const [resolvedRepoPath, setResolvedRepoPath] = useState('');
  const [previewNonce, setPreviewNonce] = useState(0);
  const [previewMeta, setPreviewMeta] = useState<PreviewMetaResponse | null>(null);
  const [previewMetaLoading, setPreviewMetaLoading] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>('desktop');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showByokModal, setShowByokModal] = useState(false);

  /* ── BYOK State ── */
  const [byokDraft, setByokDraft] = useState<{ provider: ByokProvider | ''; modelId: string; apiKey: string; }>({ provider: '', modelId: '', apiKey: '' });
  const [byokConfig, setByokConfig] = useState<ByokConfig | null>(null); // provisioned config

  /* ── Loading state ── */
  const [loading, setLoading] = useState<LoadingState>({
    chat: false, manifest: false, confirm: false, implement: false, repair: false, upload: false, resetSession: false, resetRepo: false,
  });

  /* ── Derived ── */
  const activePreviewDevice = useMemo(
    () => PREVIEW_DEVICE_OPTIONS.find((o) => o.value === previewDevice) || PREVIEW_DEVICE_OPTIONS[0],
    [previewDevice],
  );

  const effectiveTenantId = useMemo(
    () => sanitizeTenantId(tenantId || tenantFromQuery || projectNameFromQuery || ''),
    [projectNameFromQuery, tenantFromQuery, tenantId],
  );

  const previewUrl = useMemo(() => {
    if (!projectIdFromQuery) return '';
    const tenantSegment = effectiveTenantId ? `_tenant/${encodeURIComponent(effectiveTenantId)}/` : '';
    return `/api/customization/preview/${encodeURIComponent(projectIdFromQuery)}/${tenantSegment}?v=${previewNonce}`;
  }, [effectiveTenantId, previewNonce, projectIdFromQuery]);

  const previewMetaUrl = useMemo(() => {
    if (!projectIdFromQuery) return '';
    const tenantSegment = effectiveTenantId ? `_tenant/${encodeURIComponent(effectiveTenantId)}/` : '';
    return `/api/customization/preview/${encodeURIComponent(projectIdFromQuery)}/${tenantSegment}?meta=1&v=${previewNonce}`;
  }, [effectiveTenantId, previewNonce, projectIdFromQuery]);

  const effectivePreviewUrl = useMemo(() => previewUrl, [previewUrl]);
  const refreshPreview = useCallback(() => { setPreviewNonce(Date.now()); }, []);

  const isGlobalDisabled = !tenantId.trim();
  const isAnyLoading = loading.chat || loading.manifest || loading.confirm || loading.implement || loading.repair || loading.upload || loading.resetRepo || loading.resetSession || previewMetaLoading;

  const previewStarting = previewMeta?.preview_kind === 'live_server' && previewMeta?.preview_status === 'starting';
  const previewFailed = previewMeta?.preview_kind === 'live_server' && previewMeta?.preview_status === 'failed';
  const previewFrameHeld = previewStarting || previewFailed || (previewMetaLoading && !previewMeta);
  const previewFrameSrc = previewFrameHeld ? '' : effectivePreviewUrl;

  const displayManifestJson = useMemo(
    () => (manifestJson ? sanitizeManifestForDisplay(manifestJson) : null),
    [manifestJson],
  );

  const workflowStep = useMemo(() => {
    if (!tenantId.trim()) return 0;
    if (!manifestJson) return 1;
    if (!isConfirmed) return 2;
    return 3;
  }, [tenantId, manifestJson, isConfirmed]);

  /* ═══════════════════════════════════════════════════
     EFFECTS & LOGIC
     ═══════════════════════════════════════════════════ */

  useEffect(() => { setPreviewNonce(Date.now()); }, []);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages, loading.chat]);

  useEffect(() => {
    if (!previewMetaUrl) {
      setPreviewMeta(null); setPreviewMetaLoading(false); return;
    }
    let isCancelled = false;
    setPreviewMetaLoading(true);
    const fetchPreviewMeta = async () => {
      try {
        const response = await fetch(previewMetaUrl, { cache: 'no-store' });
        const payload = await parseJsonSafe<PreviewMetaResponse>(response);
        if (!response.ok || !payload || !payload.source) { if (!isCancelled) setPreviewMeta(null); return; }
        if (!isCancelled) {
          setPreviewMeta(payload);
          setStatus((prev) => {
            if (prev.level === 'error' && /customization backend is unreachable/i.test(prev.text)) {
              return { level: 'success', text: payload.preview_kind === 'live_server' && payload.preview_status === 'ready' ? 'Customization backend reachable. Live preview connected.' : 'Customization backend reachable. Preview status refreshed.' };
            }
            return prev;
          });
        }
      } catch { if (!isCancelled) setPreviewMeta(null); }
      finally { if (!isCancelled) setPreviewMetaLoading(false); }
    };
    void fetchPreviewMeta();
    return () => { isCancelled = true; };
  }, [previewMetaUrl]);

  useEffect(() => {
    if (!previewStarting) return;
    const timer = setTimeout(() => refreshPreview(), 4000);
    return () => clearTimeout(timer);
  }, [previewStarting, previewNonce, refreshPreview]);

  const syncConfirmationState = useCallback((confirmation?: ConfirmationState) => {
    const isManifestConfirmed = Boolean(confirmation?.is_confirmed) && !confirmation?.has_unconfirmed_changes;
    setIsConfirmed(isManifestConfirmed);
    setConfirmedTenantId(isManifestConfirmed && confirmation?.confirmed_tenant_id ? confirmation.confirmed_tenant_id : '');
  }, []);

  const loadAssets = useCallback(async (activeTenantId: string) => {
    const response = await fetch(`/api/customization/assets/${encodeURIComponent(activeTenantId)}`, { cache: 'no-store' });
    const payload = await parseJsonSafe<AssetsListResponse>(response);
    if (!response.ok) throw new Error(getErrorMessage(payload, 'Failed to load workspace assets.'));
    const assetsMap = payload?.assets || {};
    const nextAssets: AssetPreview[] = Object.entries(assetsMap)
      .filter(([key]) => isAssetType(key))
      .map(([key, value]) => ({
        assetType: key as AssetType, fileName: value.filename || `${key}.asset`,
        previewUrl: `/api/customization/assets/${encodeURIComponent(activeTenantId)}/${encodeURIComponent(key)}`,
        uploadedAt: nowStamp(), storedPath: value.filename ? `tenants/${activeTenantId}/assets/${value.filename}` : undefined,
      }));
    setUploadedAssetsSession(nextAssets);
  }, []);

  const fetchManifest = useCallback(async (overrideTenantId?: string, silent = false) => {
    const activeTenantId = sanitizeTenantId(overrideTenantId || tenantId);
    if (!activeTenantId) { setStatus({ level: 'warning', text: 'Workspace required: Enter a workspace ID before fetching manifest.' }); return; }
    setLoading((prev) => ({ ...prev, manifest: true }));
    if (!silent) setStatus({ level: 'info', text: 'Fetching manifest...' });
    try {
      const response = await fetch(`/api/customization/manifest?tenant_id=${encodeURIComponent(activeTenantId)}`, { cache: 'no-store' });
      const payload = await parseJsonSafe<ManifestResponse>(response);
      if (!response.ok || !payload?.manifest) throw new Error(getErrorMessage(payload, 'Failed to fetch manifest.'));
      setManifestJson(payload.manifest);
      syncConfirmationState(payload.confirmation);
      await loadAssets(activeTenantId);
      if (!silent) setStatus({ level: 'success', text: 'Manifest loaded successfully.' });
    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to fetch manifest.' });
    } finally {
      setLoading((prev) => ({ ...prev, manifest: false }));
    }
  }, [loadAssets, syncConfirmationState, tenantId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedTenant = sanitizeTenantId(window.localStorage.getItem(TENANT_STORAGE_KEY) || '');
    const tenantFromProjectMetadata = sanitizeTenantId(projectNameFromQuery);
    const initialTenant = tenantFromQuery || tenantFromProjectMetadata || savedTenant;
    if (!initialTenant) return;
    setTenantId(initialTenant);
    window.localStorage.setItem(TENANT_STORAGE_KEY, initialTenant);
    void fetchManifest(initialTenant, true);
    setChatMessages([{ role: 'agent', content: `Workspace loaded: ${initialTenant}. You can start chatting now.`, timestamp: nowStamp() }]);
    setStatus({ level: 'info', text: `Restored session for workspace: ${initialTenant}` });
  }, [fetchManifest, projectNameFromQuery, tenantFromQuery]);

  useEffect(() => {
    if (!projectIdFromQuery) { setResolvedRepoPath(''); return; }
    let isCancelled = false;
    const resolveRepoPath = async () => {
      try {
        const response = await fetch(`/api/customization/resolve-repo-path?project_id=${encodeURIComponent(projectIdFromQuery)}`, { cache: 'no-store' });
        const payload = await parseJsonSafe<ResolveRepoPathResponse>(response);
        if (!response.ok || !payload?.base_repo_path) { if (!isCancelled) setResolvedRepoPath(''); return; }
        if (!isCancelled) setResolvedRepoPath(payload.base_repo_path);
      } catch { if (!isCancelled) setResolvedRepoPath(''); }
    };
    void resolveRepoPath();
    return () => { isCancelled = true; };
  }, [projectIdFromQuery]);

  const handleTenantChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const nextTenantId = sanitizeTenantId(event.target.value);
    setTenantId(nextTenantId);
    if (typeof window !== 'undefined') {
      if (nextTenantId) window.localStorage.setItem(TENANT_STORAGE_KEY, nextTenantId);
      else window.localStorage.removeItem(TENANT_STORAGE_KEY);
    }
    setIsConfirmed(false); setConfirmedTenantId(''); setManifestJson(null); setCodeDiffEntries([]); setLastImplementErrors([]); setLastImplementWarnings([]); setLastQualityReport(null); setLastPreviewPayload(null); setLastImplementStatus('idle'); setUploadedAssetsSession([]);
    setImplementRun({ appTargets: [...DEFAULT_APP_TARGETS], validatorIssues: [], repairPassUsed: false, pipelineMode: 'hybrid' });
    if (!nextTenantId) { setStatus({ level: 'warning', text: 'Enter a workspace ID to continue.' }); return; }
    setChatMessages([{ role: 'agent', content: `Workspace set to ${nextTenantId}. You can start chatting now.`, timestamp: nowStamp() }]);
    setStatus({ level: 'info', text: 'Workspace updated. Fetch manifest to begin.' });
  }, []);

  const performRepoReset = useCallback(async (options?: { suppressPrompt?: boolean; preserveChatHistory?: boolean }) => {
    const activeTenantId = sanitizeTenantId(tenantId);
    if (!activeTenantId) { setStatus({ level: 'warning', text: 'Enter a workspace ID before repo reset.' }); return false; }
    const shouldPrompt = !(options?.suppressPrompt ?? false);
    if (shouldPrompt && !window.confirm('This will reset the workspace copy entirely. Continue?')) return false;
    setLoading((prev) => ({ ...prev, resetRepo: true }));
    setStatus({ level: 'warning', text: 'Resetting workspace copy...' });
    try {
      const response = await fetch('/api/customization/reset-repo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: activeTenantId, project_id: projectIdFromQuery || undefined }),
      });
      const payload = await parseJsonSafe<{ tenant_id: string; repo_path: string; manifest?: Record<string, unknown>; confirmation?: ConfirmationState }>(response);
      if (!response.ok || !payload) throw new Error(getErrorMessage(payload, 'Failed to reset tenant repo.'));
      if (payload.manifest) setManifestJson(payload.manifest);
      setCodeDiffEntries([]); setLastImplementErrors([]); setLastImplementWarnings([]); setLastQualityReport(null); setLastPreviewPayload(null); setLastImplementStatus('idle');
      setPreviewNonce(Date.now());
      if (options?.preserveChatHistory) {
        setChatMessages((prev) => [...prev, { role: 'agent', content: 'Reverted to original UI. Workspace copy was reset to base state.', timestamp: nowStamp() }]);
      } else {
        setChatMessages([{ role: 'agent', content: 'Repository reset complete. Awaiting next instructions.', timestamp: nowStamp() }]);
      }
      setImplementRun({ appTargets: [...DEFAULT_APP_TARGETS], validatorIssues: [], repairPassUsed: false, pipelineMode: 'hybrid' });
      syncConfirmationState(payload.confirmation);
      await loadAssets(activeTenantId);
      setStatus({ level: 'success', text: `Workspace copy reset complete for ${payload.tenant_id}.`, details: payload.repo_path });
      return true;
    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to reset tenant repo.' });
      return false;
    } finally {
      setLoading((prev) => ({ ...prev, resetRepo: false }));
    }
  }, [loadAssets, projectIdFromQuery, syncConfirmationState, tenantId]);

  const handleConfirm = useCallback(async () => {
    const activeTenantId = sanitizeTenantId(tenantId);
    if (!activeTenantId) { setStatus({ level: 'warning', text: 'Enter a workspace ID before confirming.' }); return; }
    setLoading((prev) => ({ ...prev, confirm: true }));
    setStatus({ level: 'info', text: 'Confirming manifest...' });
    try {
      const response = await fetch('/api/customization/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: activeTenantId }),
      });
      const payload = await parseJsonSafe<ConfirmResponse>(response);
      if (!response.ok || !payload) throw new Error(getErrorMessage(payload, 'Failed to confirm manifest.'));
      syncConfirmationState(payload.confirmation);
      setStatus({ level: 'success', text: `Manifest confirmed for ${payload.tenant_id}.`, details: payload.path });
    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to confirm manifest.' });
    } finally {
      setLoading((prev) => ({ ...prev, confirm: false }));
    }
  }, [syncConfirmationState, tenantId]);

  const runImplementation = useCallback(async (options?: { isRepairPass?: boolean; validatorIssues?: string[]; skipConfirmCheck?: boolean }): Promise<boolean> => {
    const activeTenantId = sanitizeTenantId(confirmedTenantId || tenantId);
    if (!activeTenantId) { setStatus({ level: 'warning', text: 'Enter a workspace ID before implementation.' }); return false; }
    if (!options?.skipConfirmCheck && !isConfirmed) { setStatus({ level: 'error', text: 'Confirm manifest before implementation.' }); return false; }
    const isRepairPass = Boolean(options?.isRepairPass);
    const validatorIssues = Array.isArray(options?.validatorIssues) ? options.validatorIssues.filter((i) => i.trim().length > 0) : [];
    setLoading((prev) => ({ ...prev, implement: !isRepairPass, repair: isRepairPass }));
    setStatus({ level: 'info', text: isRepairPass ? 'Running repair pass...' : 'Implementing changes across app targets...' });
    try {
      const response = await fetch('/api/customization/implement', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: activeTenantId, project_id: projectIdFromQuery || undefined, app_targets: implementRun.appTargets,
          validator_issues: validatorIssues.length > 0 ? validatorIssues : undefined, pipeline_mode: implementRun.pipelineMode,
          run_quality_gates: true, start_preview: true,
          ...(byokConfig ? {
            llm_config: {
              provider: PROVIDER_TO_BACKEND_ID[byokConfig.provider],
              model: byokConfig.modelId,
              api_key: byokConfig.apiKey,
            }
          } : {}),
        }),
      });
      const payload = await parseJsonSafe<ImplementResponse>(response);
      if (!response.ok || !payload) throw new Error(getErrorMessage(payload, 'Implementation failed.'));

      const nextDiffEntries = Array.isArray(payload.modified_file_diffs)
        ? payload.modified_file_diffs.filter(
          (entry): entry is { file: string; diff: string; truncated?: boolean; source?: string; operation?: string } =>
            Boolean(entry) && typeof entry.file === 'string' && typeof entry.diff === 'string',
        ) : [];
      const errors = Array.isArray(payload.errors) ? payload.errors.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
      const warnings = Array.isArray(payload.warnings) ? payload.warnings.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];

      setCodeDiffEntries(nextDiffEntries);
      setLastImplementErrors(errors); setLastImplementWarnings(warnings);
      setLastQualityReport(payload.quality_report || null); setLastPreviewPayload(payload.preview || null);
      setActiveTab('results');

      const validatorIssuesFromRun = errors.filter((issue) => issue.startsWith('Validator issue') || issue.startsWith('[Validator]'));

      if (errors.length > 0 && validatorIssuesFromRun.length > 0 && !isRepairPass) {
        setImplementRun((prev) => ({ ...prev, validatorIssues: validatorIssuesFromRun, repairPassUsed: false }));
        setLastImplementStatus('partial');
        setStatus({ level: 'warning', text: 'Validator issues detected. Review and approve a repair pass.', details: `${validatorIssuesFromRun.length} issue(s)` });
        return false;
      }

      if (errors.length > 0) {
        setLastImplementStatus('failed');
        setStatus({
          level: 'error', text: isRepairPass ? 'Repair completed with remaining issues.' : 'Implementation completed with errors.',
          details: [errors.join(' | '), payload.quality_report?.status ? `Quality: ${payload.quality_report.status}` : ''].filter(Boolean).join(' | '),
        });
        return false;
      }

      if (payload.status === 'no_changes') {
        setImplementRun((prev) => ({ ...prev, validatorIssues: [], repairPassUsed: isRepairPass ? true : prev.repairPassUsed }));
        setLastImplementErrors([]); setLastImplementStatus('partial');
        setStatus({
          level: 'warning', text: 'Implementation completed with no file changes.',
          details: ['No modifications were applied.', warnings.length > 0 ? `Warnings: ${warnings.join(' | ')}` : '', payload.preview?.detail ? `Preview: ${payload.preview.detail}` : ''].filter(Boolean).join(' | '),
        });
        setPreviewNonce(Date.now()); await fetchManifest(activeTenantId, true); return true;
      }

      setImplementRun((prev) => ({ ...prev, validatorIssues: [], repairPassUsed: isRepairPass ? true : prev.repairPassUsed }));
      setLastImplementErrors([]); setLastImplementStatus('success');
      setStatus({
        level: warnings.length > 0 || payload.preview?.status === 'failed' ? 'warning' : 'success',
        text: warnings.length > 0 || payload.preview?.status === 'failed' ? 'Implementation completed with warnings.' : `Implementation successful — ${(payload.app_targets || implementRun.appTargets).join(', ')}.`,
        details: [
          payload.base_repo_path, payload.pipeline_mode ? `mode=${payload.pipeline_mode}` : '',
          warnings.length > 0 ? `warnings=${warnings.join(' | ')}` : '', payload.quality_report?.status ? `quality=${payload.quality_report.status}` : '',
          payload.preview?.status ? `preview=${payload.preview.status}${payload.preview.detail ? ` (${payload.preview.detail})` : ''}` : '',
        ].filter(Boolean).join(' | ') || undefined,
      });
      setPreviewNonce(Date.now()); await fetchManifest(activeTenantId, true);
      return true;
    } catch (error) {
      setLastImplementStatus('failed'); setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Implementation failed.' });
      return false;
    } finally {
      setLoading((prev) => ({ ...prev, implement: false, repair: false }));
    }
  }, [confirmedTenantId, fetchManifest, implementRun.appTargets, implementRun.pipelineMode, isConfirmed, projectIdFromQuery, tenantId]);

  const handleChatSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement> | { preventDefault: () => void }) => {
    event.preventDefault();
    const activeTenantId = sanitizeTenantId(tenantId);
    const message = chatInput.trim();
    if (!activeTenantId || !message) return;
    setChatMessages((prev) => [...prev, { role: 'user', content: message, timestamp: nowStamp() }]);
    setChatInput('');
    if (REVERT_TO_BASE_CHAT_PATTERN.test(message)) {
      setStatus({ level: 'info', text: 'Reverting to original UI...' });
      await performRepoReset({ suppressPrompt: true, preserveChatHistory: true });
      return;
    }

    // Original backend chat logic to modify manifest
    setLoading((prev) => ({ ...prev, chat: true }));
    setStatus({ level: 'info', text: 'Sending message to customization agent...' });
    try {
      const response = await fetch('/api/customization/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: activeTenantId,
          message,
          ...(byokConfig ? {
            llm_config: {
              provider: PROVIDER_TO_BACKEND_ID[byokConfig.provider],
              model: byokConfig.modelId,
              api_key: byokConfig.apiKey,
            }
          } : {}),
        }),
      });
      const payload = await parseJsonSafe<ChatResponse>(response);
      if (!response.ok) throw new Error(getErrorMessage(payload, 'Failed to send chat message.'));
      setChatMessages((prev) => [...prev, { role: 'agent', content: payload?.response || 'Agent updated the manifest.', timestamp: nowStamp() }]);
      if (payload?.manifest) setManifestJson(payload.manifest);
      syncConfirmationState(payload?.confirmation);
      await loadAssets(activeTenantId);

      // AUTOMATIC IMPLEMENTATION PIPELINE
      // Always run after a successful chat response to ensure any manifest changes are immediately implemented.
      setStatus({ level: 'info', text: 'Manifest updated. Automatically starting implementation...' });
      setChatMessages((prev) => [...prev, { role: 'agent', content: "Automatically applying these changes to the preview...", timestamp: nowStamp() }]);
      
      // We do not wait for the react state to settle to avoid race conditions. We pass skipConfirmCheck to bypass it.
      setTimeout(async () => {
        try {
            await fetchManifest(activeTenantId, true);
            await handleConfirm();
            await runImplementation({ skipConfirmCheck: true });
            setChatMessages((prev) => [...prev, { role: 'agent', content: "Implementation completed! You can view the live preview now.", timestamp: nowStamp() }]);
        } catch (e) {
            console.error('Auto-implementation workflow failed', e);
            setChatMessages((prev) => [...prev, { role: 'agent', content: "Implementation encountered an error. Please check the logs.", timestamp: nowStamp() }]);
        }
      }, 100);

    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to send chat message.' });
    } finally {
      setLoading((prev) => ({ ...prev, chat: false }));
    }
  }, [byokConfig, chatInput, fetchManifest, handleConfirm, runImplementation, loadAssets, performRepoReset, syncConfirmationState, tenantId]);

  const handleAssetUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const activeTenantId = sanitizeTenantId(tenantId);
    if (!activeTenantId) {
      setStatus({ level: 'error', text: 'Workspace required for asset upload.' });
      return;
    }
    
    setLoading(prev => ({ ...prev, upload: true }));
    setStatus({ level: 'info', text: `Uploading ${assetType}...` });
    
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('tenant_id', activeTenantId);
      formData.append('asset_type', assetType);
      
      const response = await fetch('/api/customization/assets/upload', {
        method: 'POST',
        body: formData,
      });
      
      if (!response.ok) {
        const payload = await parseJsonSafe(response);
        throw new Error(getErrorMessage(payload, 'Upload failed'));
      }
      
      setStatus({ level: 'success', text: `Asset ${assetType} uploaded successfully.` });
      await loadAssets(activeTenantId);
    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to upload asset.' });
    } finally {
      setLoading(prev => ({ ...prev, upload: false }));
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#09090b] text-zinc-300 font-sans selection:bg-white/30 overflow-hidden">
      <style>{`
        ::-webkit-scrollbar { width: 14px; height: 14px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background-color: #27272a; border-radius: 8px; border: 4px solid #09090b; background-clip: padding-box; }
        ::-webkit-scrollbar-thumb:hover { background-color: #3f3f46; }
        * { scrollbar-width: thin; scrollbar-color: #27272a transparent; }
      `}</style>
      
      {/* HEADER */}
      <header className="flex items-center justify-between h-12 px-4 bg-[#09090b] border-b border-zinc-800/80 shrink-0 text-xs">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5 text-zinc-100 font-semibold tracking-wide">
            <div className="w-6 h-6 rounded flex items-center justify-center bg-gradient-to-br from-white via-zinc-400 to-zinc-500 shadow-sm shadow-zinc-400/20 ring-1 ring-white/10">
               <Command className="w-3.5 h-3.5 text-white" />
            </div>
            <span>Deplai Console</span>
            {(projectNameFromQuery || projectIdFromQuery) && (
               <span className="text-zinc-500 font-normal"> / {projectNameFromQuery || projectIdFromQuery}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-5">
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-[#121214] border border-zinc-800 rounded-md text-zinc-500 w-64 transition-colors hover:border-zinc-700">
            <Search className="w-3.5 h-3.5" />
            <input 
              type="text" 
              value={tenantId}
              onChange={handleTenantChange}
              placeholder="Workspace ID..." 
              className="w-full bg-transparent text-zinc-200 outline-none"
            />
            <div className="flex items-center gap-0.5 text-[10px] font-mono bg-zinc-800/80 px-1.5 py-0.5 rounded text-zinc-400">
              <Command className="w-3 h-3" />K
            </div>
          </div>
          {runAll && projectIdFromQuery && (
              <button onClick={() => router.push(securityPath)} className="text-xs font-semibold px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded transition-colors">
                  Security Scan →
              </button>
          )}
          <button className="text-zinc-500 hover:text-zinc-300 transition-colors">
            <Bell className="w-4 h-4" />
          </button>
          <div className="w-7 h-7 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[10px] font-bold text-zinc-300 cursor-pointer hover:bg-zinc-700 transition-colors">
            AJ
          </div>
        </div>
      </header>

      {/* CONTEXT BAR */}
      <div className="flex items-center justify-between h-14 px-5 bg-[#121214] border-b border-zinc-800/80 shrink-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/dashboard')} className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-md transition-all">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-sm font-semibold text-zinc-100 tracking-tight">Customization Environment</h1>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={async () => { 
                await fetchManifest(); 
                await handleConfirm(); 
                const success = await runImplementation(); 
                if (success && securityPath) {
                  router.push(securityPath);
                }
              }}
            disabled={isGlobalDisabled || loading.implement}
            className="flex items-center gap-2 px-4 py-2 bg-zinc-100 hover:bg-white disabled:opacity-50 text-zinc-900 text-xs font-semibold rounded-md shadow-sm transition-all active:scale-95"
          >
            {loading.implement ? <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-600" /> : <Play className="w-3.5 h-3.5 fill-current" />}
            Commit & Proceed
          </button>
        </div>
      </div>
      
      {/* MAIN LAYOUT */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* LOCK OVERLAY */}
        {isGlobalDisabled && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#0A0A0F]/90 backdrop-blur-sm">
            <div className="flex max-w-sm flex-col items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/90 p-8 text-center shadow-2xl">
              <div className="flex h-14 w-14 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800">
                <Lock className="h-6 w-6 text-zinc-400" />
              </div>
              <div>
                <h3 className="mb-1 text-lg font-semibold text-white">Workspace Required</h3>
                <p className="text-sm leading-relaxed text-zinc-400">Enter a workspace ID in the header to unlock customization controls.</p>
              </div>
            </div>
          </div>
        )}

        {/* SIDE PANEL */}
        {sidebarOpen && (
          <aside className="w-[360px] flex flex-col bg-[#09090b] border-r border-zinc-800/80 shrink-0 z-10 h-full">
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/80 bg-[#121214]">
              <div className="flex items-center">
                <Terminal className="w-4 h-4 text-zinc-400 mr-2.5" />
                <h2 className="text-xs font-semibold text-zinc-200">Deplai Agent Session</h2>
                <button onClick={() => setShowByokModal(true)} className="flex items-center gap-1.5 px-2 py-1 ml-3 text-[10px] font-bold text-black bg-white hover:bg-zinc-300 rounded transition-colors shadow-sm" title="Bring Your Own Key">
                  <Key className="w-3 h-3" /> BYOK
                </button>
              </div>
              <div className="flex gap-1">
                <button onClick={() => performRepoReset()} className="p-1.5 text-zinc-500 hover:text-zinc-300 rounded hover:bg-zinc-800 transition-colors"><RotateCcw className="w-3.5 h-3.5" /></button>
                <button className="p-1.5 text-zinc-500 hover:text-zinc-300 rounded hover:bg-zinc-800 transition-colors"><MoreHorizontal className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-5 space-y-6 bg-[#09090b]">
              {chatMessages.map((msg, i) => (
                msg.role === 'agent' ? (
                  <div key={i} className="flex gap-3.5 mt-6 mb-2">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-b from-zinc-100 to-zinc-300 flex items-center justify-center shrink-0 shadow-sm ring-1 ring-zinc-800">
                      <Cpu className="w-4 h-4 text-zinc-900" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[13px] font-bold text-zinc-100 tracking-wide">Deplai Agent</span>
                        <span className="text-[10px] text-zinc-600 font-mono">{msg.timestamp}</span>
                      </div>
                      <div className="text-[13px] leading-relaxed text-zinc-300">{formatUiText(msg.content)}</div>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex flex-col items-end">
                    <span className="text-[10px] text-zinc-600 font-mono mb-1.5">{msg.timestamp}</span>
                    <div className="px-4 py-2.5 bg-zinc-100 text-zinc-900 text-[13px] font-semibold rounded-2xl rounded-tr-sm max-w-[85%] shadow-sm">
                      {formatUiText(msg.content)}
                    </div>
                  </div>
                )
              ))}
              {loading.chat && (
                 <div className="flex gap-3.5 mt-6 mb-2">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-b from-zinc-100 to-zinc-300 flex items-center justify-center shrink-0 shadow-sm ring-1 ring-zinc-800">
                      <Cpu className="w-4 h-4 animate-pulse text-zinc-900" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[13px] font-bold text-zinc-100 tracking-wide">Deplai Agent</span>
                      </div>
                      <div className="text-[13px] leading-relaxed text-zinc-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin"/> Processing...</div>
                    </div>
                  </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="p-5 bg-[#121214] border-t border-zinc-800/80">
              <div className="relative group">
                <div className="absolute inset-0 bg-gradient-to-r from-white/20 to-zinc-400/20 rounded-xl blur opacity-0 group-focus-within:opacity-100 transition-opacity"></div>
                <form onSubmit={handleChatSubmit} className="relative flex items-center bg-[#09090b] border border-zinc-700 focus-within:border-white/50 rounded-xl overflow-hidden transition-colors">
                  <div className="pl-4 pr-2 text-zinc-500"><Sparkles className="w-4 h-4" /></div>
                  <input 
                    type="text" 
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    disabled={loading.chat || isGlobalDisabled}
                    placeholder="Instruct Deplai Agent (say 'confirm' to execute)..." 
                    className="flex-1 bg-transparent py-3.5 text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
                  />
                  <button type="submit" disabled={!chatInput.trim() || loading.chat || isGlobalDisabled} className="px-4 text-zinc-500 hover:text-zinc-300 transition-colors">
                    <SendHorizontal className="w-4 h-4" />
                  </button>
                </form>
              </div>
            </div>
          </aside>
        )}

        {/* WORKSPACE AREA */}
        <main className="flex-1 flex flex-col min-w-0 bg-[#09090b] relative z-0 h-full overflow-hidden">
          <div className="flex items-center bg-[#121214] border-b border-zinc-800/80 h-12 shrink-0 px-2 overflow-x-auto">
            {WORKSPACE_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.value;
              return (
                <button
                  key={tab.value}
                  onClick={() => setActiveTab(tab.value)}
                  className={`group flex items-center gap-2 px-4 h-full text-[13px] font-medium border-r border-zinc-800/40 transition-all relative shrink-0 ${isActive ? 'bg-[#09090b] text-zinc-100' : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'}`}
                >
                  {isActive && <div className="absolute top-0 left-0 right-0 h-[2px] bg-white"></div>}
                  <Icon className={`w-4 h-4 ${isActive ? 'text-zinc-300' : 'text-zinc-600 group-hover:text-zinc-400'}`} />
                  {tab.label}
                  {tab.value === 'results' && lastImplementErrors.length > 0 && (
                    <span className="ml-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500/20 px-1 text-[9px] font-bold text-rose-400">{lastImplementErrors.length}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-hidden relative flex flex-col">
            {/* PREVIEW VIEW */}
            {activeTab === 'preview' && (
              <div className="flex-1 w-full p-6 flex flex-col items-center bg-[#09090b]">
                <div className="w-full flex items-center justify-end h-10 mb-4 text-xs shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="flex bg-[#121214] border border-zinc-800 rounded-md p-1 shadow-inner">
                      {PREVIEW_DEVICE_OPTIONS.map((opt) => (
                        <button key={opt.value} onClick={() => setPreviewDevice(opt.value)} className={`p-1.5 rounded transition-colors ${previewDevice === opt.value ? 'text-zinc-200 bg-zinc-800' : 'text-zinc-500 hover:text-zinc-300'}`}><opt.icon className="w-4 h-4" /></button>
                      ))}
                    </div>
                    <div className="w-px h-5 bg-zinc-800"></div>
                    <button onClick={refreshPreview} className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded hover:bg-zinc-800 transition-colors"><RefreshCw className="w-3.5 h-3.5" />Reload</button>
                    <a href={effectivePreviewUrl || '#'} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded hover:bg-zinc-800 transition-colors"><ExternalLink className="w-3.5 h-3.5" />Popout</a>
                  </div>
                </div>
                
                <div className="flex-1 flex flex-col bg-[#121214] border border-zinc-800/80 rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/5 transition-all duration-300 w-full" style={{ maxWidth: previewDevice === 'desktop' ? '100%' : previewDevice === 'tablet' ? '768px' : '375px' }}>
                  <div className="h-12 flex items-center gap-4 px-4 bg-[#18181b] border-b border-zinc-800 shrink-0">
                    <div className="flex gap-2">
                      <div className="w-3 h-3 rounded-full bg-zinc-700"></div>
                      <div className="w-3 h-3 rounded-full bg-zinc-700"></div>
                      <div className="w-3 h-3 rounded-full bg-zinc-700"></div>
                    </div>
                    <div className="flex-1 flex items-center justify-center max-w-2xl mx-auto">
                      <div className="w-full flex items-center gap-2 px-3 py-1.5 bg-[#09090b] border border-zinc-800/80 rounded-md text-[11px] font-mono text-zinc-500">
                        <Lock className="w-3.5 h-3.5 text-zinc-600" />
                        <span className="truncate">{previewMeta?.preview_url || effectivePreviewUrl || 'about:blank'}</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex-1 bg-[#09090b] relative flex flex-col items-center justify-center overflow-hidden">
                    {previewFrameHeld ? (
                      <>
                        <div className="absolute inset-0" style={{ backgroundImage: 'radial-gradient(#27272a 1px, transparent 1px)', backgroundSize: '24px 24px', opacity: 0.3 }}></div>
                        <div className="relative z-10 flex flex-col items-center max-w-md w-full px-6 text-center">
                            {previewFailed ? (
                                <>
                                  <div className="relative w-24 h-24 mb-8 flex items-center justify-center text-rose-500"><XCircle className="w-12 h-12" /></div>
                                  <h3 className="text-zinc-200 font-medium mb-2 text-lg">Preview Failed</h3>
                                  <p className="text-zinc-400 text-sm">{previewMeta?.preview_detail || 'The dev server failed to start.'}</p>
                                  <button onClick={refreshPreview} className="mt-4 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white text-sm rounded">Retry Preview</button>
                                </>
                            ) : (
                                <>
                                  <div className="relative w-24 h-24 mb-8 flex items-center justify-center">
                                    <svg className="absolute inset-0 w-full h-full text-zinc-800 animate-[spin_4s_linear_infinite]" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="none" strokeWidth="1" stroke="currentColor" strokeDasharray="4 4" /></svg>
                                    <svg className="absolute inset-2 w-[calc(100%-16px)] h-[calc(100%-16px)] text-white animate-[spin_2s_linear_infinite_reverse]" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="none" strokeWidth="2" stroke="currentColor" strokeDasharray="80 220" strokeLinecap="round" /></svg>
                                    <Code2 className="w-8 h-8 text-zinc-400" />
                                  </div>
                                  <h3 className="text-zinc-200 font-medium mb-2 text-lg">{previewStarting ? 'Starting dev server...' : 'Loading preview...'}</h3>
                                  <div className="w-full bg-[#121214] border border-zinc-800/80 rounded-lg p-4 font-mono text-xs text-zinc-500 mt-4 h-32 overflow-hidden relative shadow-inner text-left">
                                    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#121214] z-10 pointer-events-none"></div>
                                    <div className="space-y-1.5 animate-pulse">
                                      <p className="text-zinc-300/70">{previewMeta?.preview_detail || 'Initializing environments...'}</p>
                                    </div>
                                  </div>
                                </>
                            )}
                        </div>
                      </>
                    ) : (
                      <iframe key={previewFrameSrc} src={previewFrameSrc} className="w-full h-full border-0 bg-white" />
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* RESULTS VIEW */}
            {activeTab === 'results' && (
              <div className="flex-1 flex flex-col bg-[#09090b] overflow-hidden">
                <div className="flex items-center gap-8 px-6 h-12 border-b border-zinc-800/80 text-[13px] font-medium shrink-0 bg-[#0c0c0e]">
                  <button onClick={() => setResultsSubTab('diffs')} className={`h-full border-b-2 flex items-center transition-colors ${resultsSubTab === 'diffs' ? 'border-white text-zinc-300' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}>
                    Code Diffs {codeDiffEntries.length > 0 && <span className="ml-2 px-2 py-0.5 rounded-full bg-zinc-800 text-[10px] text-zinc-300">{codeDiffEntries.length}</span>}
                  </button>
                  <button onClick={() => setResultsSubTab('errors')} className={`h-full border-b-2 flex items-center transition-colors ${resultsSubTab === 'errors' ? 'border-white text-zinc-300' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}>
                    Compilation Logs {lastImplementErrors.length > 0 && <span className="ml-2 px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 text-[10px]">{lastImplementErrors.length}</span>}
                  </button>
                </div>

                {resultsSubTab === 'diffs' && (
                  <div className="flex flex-1 overflow-hidden">
                    <div className="w-72 border-r border-zinc-800/80 bg-[#0c0c0e] flex flex-col shrink-0">
                      <div className="p-4 border-b border-zinc-800/80 text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                        <FolderTree className="w-4 h-4" /> Changed Files
                      </div>
                      <div className="flex-1 overflow-y-auto p-3 space-y-1">
                        {codeDiffEntries.map((entry, idx) => (
                          <div key={idx} onClick={() => diffRefs.current[idx]?.scrollIntoView({ behavior: 'smooth' })} className="flex items-center justify-between px-3 py-2 hover:bg-zinc-800/50 rounded-md cursor-pointer text-zinc-400 hover:text-zinc-200 text-[13px] transition-colors">
                            <div className="flex items-center gap-2.5 truncate"><FileCode2 className="w-4 h-4 shrink-0" /> <span className="truncate">{entry.file.split('/').pop()}</span></div>
                          </div>
                        ))}
                        {codeDiffEntries.length === 0 && <div className="text-zinc-600 text-xs p-2">No code diffs available.</div>}
                      </div>
                    </div>

                    <div className="flex-1 flex flex-col bg-[#09090b] overflow-hidden">
                      <div className="flex-1 overflow-auto p-5 space-y-4">
                        {codeDiffEntries.map((entry, idx) => (
                           <div key={idx} ref={(el) => { diffRefs.current[idx] = el; }} className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                              <div className="flex items-center justify-between border-b border-zinc-800/60 px-4 py-2.5">
                                <span className="font-mono text-[12px] font-medium text-zinc-300">{entry.file}</span>
                              </div>
                              <div className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed">
                                {entry.diff.split('\n').map((line, i) => (
                                  <div key={i} className={`whitespace-pre-wrap break-all rounded-sm px-2 py-0.5 ${diffLineClassName(line)}`}>{line || ' '}</div>
                                ))}
                              </div>
                           </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                {resultsSubTab === 'errors' && (
                  <div className="flex-1 overflow-auto p-6 space-y-3">
                     {lastImplementErrors.map((err, i) => (
                        <div key={i} className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 flex gap-3 text-rose-300 text-sm">
                           <XCircle className="w-5 h-5 shrink-0" />
                           <p>{err}</p>
                        </div>
                     ))}
                     {lastImplementErrors.length === 0 && <div className="text-zinc-500 text-sm">No errors in compilation logs.</div>}
                  </div>
                )}
              </div>
            )}

            {/* MANIFEST VIEW */}
            {activeTab === 'manifest' && (
              <div className="flex-1 flex flex-col bg-[#09090b] overflow-hidden">
                <div className="flex items-center justify-between px-6 h-14 border-b border-zinc-800/80 bg-[#121214] shrink-0">
                  <div className="flex items-center gap-3 text-[13px] font-semibold text-zinc-200">
                    <Braces className="w-4 h-4 text-zinc-300" /> manifest.json
                    {manifestJson && <span className="px-2.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] uppercase tracking-wider">Valid JSON</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => fetchManifest()} className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-md transition-colors">
                      <RefreshCw className="w-4 h-4" /> Reload
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-auto bg-[#09090b] p-6">
                  {manifestJson ? (
                    <div className="max-w-4xl mx-auto font-mono text-[14px] leading-loose tracking-wide bg-[#121214] border border-zinc-800/60 rounded-xl shadow-2xl relative overflow-hidden">
                       <pre className="p-6 text-zinc-300">{JSON.stringify(displayManifestJson, null, 2)}</pre>
                    </div>
                  ) : (
                    <div className="text-zinc-500 text-sm text-center mt-20">Manifest not loaded.</div>
                  )}
                </div>
              </div>
            )}

            {/* ASSETS VIEW */}
            {activeTab === 'assets' && (
              <div className="flex-1 flex flex-col bg-[#09090b] overflow-y-auto">
                <div className="max-w-5xl mx-auto w-full p-8 space-y-10">
                  <div>
                    <h2 className="text-2xl font-semibold text-zinc-100 tracking-tight">Branding Assets</h2>
                    <p className="text-sm text-zinc-500 mt-2">Upload and manage logos, favicons, and custom fonts for your implementation.</p>
                  </div>
                  
                  <div className="flex items-center gap-4">
                    <label className="text-sm font-medium text-zinc-300">Select Asset Type:</label>
                    <select 
                      value={assetType} 
                      onChange={(e) => setAssetType(e.target.value as AssetType)}
                      className="bg-[#121214] border border-zinc-700 text-zinc-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-white"
                    >
                      {ASSET_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  </div>

                  <div 
                    onClick={() => fileInputRef.current?.click()}
                    className={`group relative w-full rounded-2xl border-2 border-dashed border-zinc-700/80 hover:border-white hover:bg-white/5 transition-all duration-300 p-12 flex flex-col items-center justify-center cursor-pointer ${loading.upload ? 'opacity-50 pointer-events-none' : 'bg-[#121214]/50'}`}
                  >
                    <input 
                      type="file" 
                      ref={fileInputRef} 
                      onChange={handleAssetUpload} 
                      className="hidden" 
                      accept="image/svg+xml,image/png,image/jpeg,image/webp"
                    />
                    <div className="w-20 h-20 rounded-full bg-zinc-800 group-hover:bg-white/20 flex items-center justify-center mb-5 transition-colors">
                      {loading.upload ? <Loader2 className="w-10 h-10 animate-spin text-zinc-300" /> : <UploadCloud className="w-10 h-10 text-zinc-400 group-hover:text-zinc-300 transition-colors" />}
                    </div>
                    <h3 className="text-base font-semibold text-zinc-200 mb-2 group-hover:text-indigo-200 transition-colors">
                      {loading.upload ? 'Uploading...' : 'Click or drag file to this area to upload'}
                    </h3>
                    <p className="text-sm text-zinc-500 text-center max-w-md">Supports SVG, PNG, JPG, or WEBP. Max file size is 5MB.</p>
                  </div>

                  <div className="space-y-5 pt-4">
                    <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wider border-b border-zinc-800/80 pb-3">Session Uploads</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {uploadedAssetsSession.map((asset, i) => (
                         <div key={i} className="bg-[#121214] border border-zinc-800 rounded-xl overflow-hidden shadow-lg">
                           <div className="h-40 bg-zinc-900/80 flex items-center justify-center relative p-6">
                             <img src={asset.previewUrl} alt={asset.fileName} className="max-w-full max-h-full object-contain" />
                           </div>
                           <div className="p-4 border-t border-zinc-800/80">
                             <span className="text-sm font-semibold text-zinc-200">{asset.assetType}</span>
                           </div>
                         </div>
                      ))}
                      {uploadedAssetsSession.length === 0 && <div className="text-zinc-500 text-sm">No assets uploaded yet.</div>}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* SETTINGS VIEW */}
            {activeTab === 'settings' && (
              <div className="flex-1 w-full overflow-y-auto bg-[#09090b]">
                <div className="max-w-4xl mx-auto p-8 space-y-12">
                  <div>
                    <h2 className="text-xl font-semibold text-zinc-100 tracking-tight">Configuration Settings</h2>
                    <p className="text-sm text-zinc-500 mt-1">Manage implementation pipelines, targets, and environment paths.</p>
                  </div>

                  <section className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div><h3 className="text-sm font-medium text-zinc-200">Pipeline Mode</h3></div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {PIPELINE_MODE_OPTIONS.map((mode) => (
                        <div key={mode.value} onClick={() => setImplementRun(p => ({...p, pipelineMode: mode.value}))} className={`relative p-4 rounded-xl border cursor-pointer transition-all ${implementRun.pipelineMode === mode.value ? 'bg-white/5 border-white/50 shadow-[0_0_15px_rgba(99,102,241,0.1)]' : 'bg-[#121214] border-zinc-800 hover:border-zinc-700'}`}>
                          <div className="flex items-start gap-4">
                            <div className={`p-2.5 rounded-lg ${implementRun.pipelineMode === mode.value ? 'bg-white/20 text-zinc-300' : 'bg-zinc-800 text-zinc-400'}`}><mode.icon className="w-5 h-5" /></div>
                            <div className="flex-1 mt-0.5">
                              <h4 className="text-sm font-semibold text-zinc-200">{mode.label}</h4>
                              <p className="text-xs text-zinc-500">{mode.description}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
      
      {/* STATUS BAR */}
      <footer className="h-8 bg-[#09090b] border-t border-zinc-800/80 flex items-center justify-between px-4 text-[10px] font-mono text-zinc-500 shrink-0 z-20">
        <div className="flex items-center gap-5">
          <div onClick={() => setSidebarOpen(!sidebarOpen)} className="flex items-center gap-1.5 hover:text-zinc-300 cursor-pointer transition-colors"><PanelLeftClose className="w-3.5 h-3.5" /></div>
          <div className="flex items-center gap-2 font-medium">
            <div className={`w-1.5 h-1.5 rounded-full ${status.level === 'error' ? 'bg-rose-500' : status.level === 'success' ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-amber-400'}`}></div>
            {status.text}
          </div>
          <div className="flex items-center gap-1.5"><Activity className="w-3.5 h-3.5"/> {isAnyLoading ? 'Loading...' : 'Idle'}</div>
        </div>
        <div className="flex items-center gap-5">
          <div onClick={() => performRepoReset()} className="flex items-center gap-1.5 text-zinc-400 hover:text-rose-400 cursor-pointer transition-colors"><AlertTriangle className="w-3.5 h-3.5 text-rose-500/80" />Reset Env</div>
          <div className="opacity-70">UTF-8</div>
        </div>
      </footer>

      {/* BYOK MODAL */}
      {showByokModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#09090b] border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-[#121214]">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Key className="w-4 h-4 text-zinc-300" />
                Provision Deplai Agent
              </h3>
              <button onClick={() => setShowByokModal(false)} className="text-zinc-500 hover:text-white transition-colors text-lg leading-none">&times;</button>
            </div>

            {byokConfig ? (
              /* ── Success Card ── */
              <div className="p-6 space-y-5">
                <div className="flex flex-col items-center text-center gap-3 py-4">
                  <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                    <CheckCircle className="w-6 h-6 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">Agent Provisioned</p>
                    <p className="text-xs text-zinc-400 mt-1">Your key is active for this session only — never stored.</p>
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 divide-y divide-zinc-800 text-sm">
                  <div className="flex items-center justify-between px-4 py-3">
                    <span className="text-zinc-400">Provider</span>
                    <span className="font-medium text-white">{byokConfig.provider}</span>
                  </div>
                  <div className="flex items-center justify-between px-4 py-3">
                    <span className="text-zinc-400">Model</span>
                    <span className="font-medium text-white">{PROVIDER_MODEL_MAP[byokConfig.provider].find(m => m.id === byokConfig.modelId)?.name ?? byokConfig.modelId}</span>
                  </div>
                  <div className="flex items-center justify-between px-4 py-3">
                    <span className="text-zinc-400">Agentic Readiness</span>
                    <span className="text-xs font-medium text-emerald-400 flex items-center gap-1.5"><span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />Active</span>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={() => { setByokConfig(null); setByokDraft({ provider: '', modelId: '', apiKey: '' }); }} className="flex-1 px-4 py-2.5 text-xs font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors">Reconfigure</button>
                  <button onClick={() => setShowByokModal(false)} className="flex-1 px-4 py-2.5 text-xs font-semibold text-black bg-white hover:bg-white rounded-lg transition-colors">Done</button>
                </div>
              </div>
            ) : (
              /* ── Configuration Form ── */
              <div className="p-6 space-y-5">
                {/* Step 1: Provider */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-2">1. Select Provider</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(Object.keys(PROVIDER_MODEL_MAP) as ByokProvider[]).map((p) => (
                      <button
                        key={p}
                        onClick={() => setByokDraft(d => ({ ...d, provider: p, modelId: '' }))}
                        className={`px-3 py-2.5 rounded-lg text-xs font-medium border transition-all text-left ${
                          byokDraft.provider === p
                            ? 'border-white bg-white/10 text-white'
                            : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Step 2: Model */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-2">2. Select Model</label>
                  <select
                    disabled={!byokDraft.provider}
                    value={byokDraft.modelId}
                    onChange={(e) => setByokDraft(d => ({ ...d, modelId: e.target.value }))}
                    className="w-full bg-[#121214] border border-zinc-700 focus:border-white rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <option value="" disabled>{byokDraft.provider ? 'Choose a model...' : 'Select a provider first'}</option>
                    {byokDraft.provider && PROVIDER_MODEL_MAP[byokDraft.provider].map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>

                {/* Step 3: API Key */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-2">3. Paste API Key</label>
                  <input
                    type="password"
                    value={byokDraft.apiKey}
                    onChange={(e) => setByokDraft(d => ({ ...d, apiKey: e.target.value }))}
                    placeholder={byokDraft.provider === 'Anthropic' ? 'sk-ant-...' : byokDraft.provider === 'Groq' ? 'gsk_...' : byokDraft.provider === 'OpenRouter' ? 'sk-or-...' : 'sk-...'}
                    className="w-full bg-[#121214] border border-zinc-700 focus:border-white focus:ring-1 focus:ring-white/30 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none transition-all"
                  />
                  <p className="mt-2 text-[11px] text-zinc-500">Keys are used in-memory for this session only and are never logged or stored.</p>
                </div>

                <div className="flex items-center justify-end gap-3 pt-1">
                  <button onClick={() => setShowByokModal(false)} className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-white transition-colors">Cancel</button>
                  <button
                    disabled={!byokDraft.provider || !byokDraft.modelId || !byokDraft.apiKey.trim()}
                    onClick={() => {
                      if (!byokDraft.provider || !byokDraft.modelId || !byokDraft.apiKey.trim()) return;
                      setByokConfig({ provider: byokDraft.provider as ByokProvider, modelId: byokDraft.modelId, apiKey: byokDraft.apiKey.trim() });
                    }}
                    className="px-5 py-2 text-xs font-semibold text-black bg-white hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
                  >
                    Provision Agent
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

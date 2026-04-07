'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  FileJson,
  Image as ImageIcon,
  Key,
  Lock,
  MessageSquare,
  Play,
  RefreshCcw,
  RefreshCw,
  Send,
  ShieldAlert,
  TerminalSquare,
  Upload,
  User,
  XCircle,
} from 'lucide-react';

type StatusLevel = 'info' | 'success' | 'warning' | 'error';

type ChatMessage = {
  role: 'user' | 'agent';
  content: string;
  timestamp: string;
};

type StatusState = {
  level: StatusLevel;
  text: string;
  details?: string;
};

type ConfirmationState = {
  confirmed_tenant_id?: string;
  has_unconfirmed_changes?: boolean;
  is_confirmed?: boolean;
};

type AssetType =
  | 'logo_light'
  | 'logo_dark'
  | 'favicon'
  | 'og_image'
  | 'hero_illustration'
  | 'why_background'
  | 'activities_background'
  | 'curated_image';

type AssetOption = {
  value: AssetType;
  label: string;
};

type AssetPreview = {
  assetType: AssetType;
  fileName: string;
  previewUrl: string;
  uploadedAt: string;
  storedPath?: string;
};

type ImplementRunState = {
  appTargets: string[];
  validatorIssues: string[];
  repairPassUsed: boolean;
};

type LoadingState = {
  chat: boolean;
  manifest: boolean;
  confirm: boolean;
  implement: boolean;
  repair: boolean;
  upload: boolean;
  resetSession: boolean;
  resetRepo: boolean;
};

type ChatResponse = {
  response?: string;
  manifest?: Record<string, unknown>;
  confirmation?: ConfirmationState;
  tenant_id?: string;
};

type ManifestResponse = {
  tenant_id?: string;
  manifest?: Record<string, unknown>;
  confirmation?: ConfirmationState;
};

type ConfirmResponse = {
  tenant_id: string;
  path: string;
  confirmation?: ConfirmationState;
};

type ImplementResponse = {
  status?: 'implementation_complete' | 'no_changes';
  tenant_id: string;
  app_targets?: string[];
  base_repo_path?: string;
  errors?: string[];
  modified_files?: string[];
  modified_file_diffs?: Array<{
    file: string;
    diff: string;
    truncated?: boolean;
  }>;
  plan_markdown_path?: string;
};

type ResolveRepoPathResponse = {
  project_id: string;
  base_repo_path: string;
};

type PreviewMetaResponse = {
  source?: 'base' | 'subspace';
  base_repo_path?: string;
  tenant_repo_path?: string | null;
  tenant_repo_exists?: boolean;
  preview_root_path?: string;
  preview_entry?: string | null;
};

type AssetsListResponse = {
  tenant_id: string;
  assets?: Record<string, { filename?: string }>;
};

type UploadAssetResponse = {
  tenant_id: string;
  asset_type: AssetType;
  stored_path: string;
  confirmation?: ConfirmationState;
};

const TENANT_STORAGE_KEY = 'deplai.customization.tenant-id';
const DEFAULT_APP_TARGETS = ['frontend', 'admin-frontend', 'expert', 'corporates'];
const REVERT_TO_BASE_CHAT_PATTERN = /(revert|reset|restore|undo).*(original|base|default).*(ui|theme|frontend|site|design)/i;
const INITIAL_CHAT_TIMESTAMP = '--:--:--';

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

class Pixel {
  width: number;
  height: number;
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  color: string;
  speed: number;
  size: number;
  sizeStep: number;
  minSize: number;
  maxSizeInteger: number;
  maxSize: number;
  delay: number;
  counter: number;
  counterStep: number;
  isIdle: boolean;
  isReverse: boolean;
  isShimmer: boolean;

  constructor(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    color: string,
    speed: number,
    delay: number,
  ) {
    const dpr = window.devicePixelRatio || 1;
    this.width = canvas.width / dpr;
    this.height = canvas.height / dpr;
    this.ctx = context;
    this.x = x;
    this.y = y;
    this.color = color;
    this.speed = (Math.random() * 0.8 + 0.1) * speed;
    this.size = 0;
    this.sizeStep = Math.random() * 0.4;
    this.minSize = 0.5;
    this.maxSizeInteger = 2;
    this.maxSize = Math.random() * (this.maxSizeInteger - this.minSize) + this.minSize;
    this.delay = delay;
    this.counter = 0;
    this.counterStep = Math.random() * 4 + (this.width + this.height) * 0.01;
    this.isIdle = false;
    this.isReverse = false;
    this.isShimmer = false;
  }

  draw() {
    const centerOffset = this.maxSizeInteger * 0.5 - this.size * 0.5;
    this.ctx.fillStyle = this.color;
    this.ctx.fillRect(
      Math.round(this.x + centerOffset),
      Math.round(this.y + centerOffset),
      Math.round(this.size),
      Math.round(this.size),
    );
  }

  appear() {
    this.isIdle = false;
    if (this.counter <= this.delay) {
      this.counter += this.counterStep;
      return;
    }
    if (this.size >= this.maxSize) this.isShimmer = true;
    if (this.isShimmer) this.shimmer();
    else this.size += this.sizeStep;
    this.draw();
  }

  disappear() {
    this.isShimmer = false;
    this.counter = 0;
    if (this.size <= 0) {
      this.isIdle = true;
      return;
    }
    this.size -= 0.1;
    this.draw();
  }

  shimmer() {
    if (this.size >= this.maxSize) this.isReverse = true;
    else if (this.size <= this.minSize) this.isReverse = false;
    if (this.isReverse) this.size -= this.speed;
    else this.size += this.speed;
  }
}

type PixelCardProps = {
  gap?: number;
  speed?: number;
  colors?: string;
  className?: string;
  children: React.ReactNode;
};

function PixelCard({
  gap = 5,
  speed = 35,
  colors = '#3f3f46,#18181b,#ffffff',
  className = '',
  children,
}: PixelCardProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pixelsRef = useRef<Pixel[]>([]);
  const animationRef = useRef<number | null>(null);
  const timePreviousRef = useRef(performance.now());

  const initPixels = useCallback(() => {
    if (!containerRef.current || !canvasRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvasRef.current.width = width * dpr;
    canvasRef.current.height = height * dpr;
    ctx.scale(dpr, dpr);

    const colorsArray = colors.split(',');
    const nextPixels: Pixel[] = [];

    for (let x = 0; x < width; x += gap) {
      for (let y = 0; y < height; y += gap) {
        const color = colorsArray[Math.floor(Math.random() * colorsArray.length)];
        const distance = Math.sqrt((x - width / 2) ** 2 + (y - height / 2) ** 2);
        nextPixels.push(new Pixel(canvasRef.current, ctx, x, y, color, speed * 0.001, distance));
      }
    }

    pixelsRef.current = nextPixels;
  }, [colors, gap, speed]);

  const doAnimate = useCallback((fnName: 'appear' | 'disappear') => {
    animationRef.current = requestAnimationFrame(() => doAnimate(fnName));

    const timeNow = performance.now();
    const timePassed = timeNow - timePreviousRef.current;
    if (timePassed < 1000 / 60) return;
    timePreviousRef.current = timeNow - (timePassed % (1000 / 60));

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    let allIdle = true;
    pixelsRef.current.forEach((pixel) => {
      pixel[fnName]();
      if (!pixel.isIdle) allIdle = false;
    });

    if (allIdle && animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
    }
  }, []);

  const handleAnimation = useCallback((name: 'appear' | 'disappear') => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = requestAnimationFrame(() => doAnimate(name));
  }, [doAnimate]);

  useEffect(() => {
    initPixels();
    const observer = new ResizeObserver(() => initPixels());
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    };
  }, [initPixels]);

  return (
    <div
      ref={containerRef}
      className={`relative isolate overflow-hidden select-none transition-colors duration-200 ${className}`}
      onMouseEnter={() => handleAnimation('appear')}
      onMouseLeave={() => handleAnimation('disappear')}
    >
      <canvas className="pointer-events-none absolute inset-0 z-0 block h-full w-full mix-blend-lighten opacity-30" ref={canvasRef} />
      <div className="relative z-10 flex h-full w-full flex-col">{children}</div>
    </div>
  );
}

type BorderGlowProps = {
  children: React.ReactNode;
  className?: string;
  active?: boolean;
};

function BorderGlow({ children, className = '', active = false }: BorderGlowProps) {
  const glowColor = active ? 'from-white/30 via-white/10' : 'from-zinc-500/10 via-zinc-500/5';
  return (
    <div className={`group relative ${className}`}>
      <div className={`absolute -inset-[1px] rounded-lg bg-gradient-to-r ${glowColor} to-transparent opacity-100 blur-sm transition duration-500`} />
      <div className="relative flex h-full flex-col overflow-hidden rounded-lg border border-[#262626] bg-[#050505]">
        {children}
      </div>
    </div>
  );
}

function nowStamp(): string {
  return new Date().toLocaleTimeString();
}

function sanitizeTenantId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
}

function isAssetType(value: string): value is AssetType {
  return ASSET_OPTIONS.some((option) => option.value === value);
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;

  const body = payload as { error?: unknown; detail?: unknown; message?: unknown };

  if (typeof body.error === 'string' && body.error.trim()) return body.error;
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  if (typeof body.detail === 'string' && body.detail.trim()) return body.detail;

  if (body.detail && typeof body.detail === 'object') {
    const detailObj = body.detail as { message?: unknown; errors?: unknown };
    if (typeof detailObj.message === 'string' && detailObj.message.trim()) {
      if (Array.isArray(detailObj.errors) && detailObj.errors.length > 0) {
        return `${detailObj.message} ${detailObj.errors.join(' | ')}`;
      }
      return detailObj.message;
    }
  }

  return fallback;
}

async function parseJsonSafe<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export default function CustomizationConsoleApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const tenantFromQuery = useMemo(() => sanitizeTenantId(searchParams.get('tenantId') || ''), [searchParams]);
  const projectIdFromQuery = useMemo(() => searchParams.get('projectId') || '', [searchParams]);
  const projectNameFromQuery = useMemo(() => searchParams.get('projectName') || '', [searchParams]);
  const runAll = useMemo(() => searchParams.get('runAll') === '1', [searchParams]);
  const securityPath = useMemo(
    () => (projectIdFromQuery ? `/dashboard/security-analysis/${encodeURIComponent(projectIdFromQuery)}?runAll=1` : '/dashboard'),
    [projectIdFromQuery],
  );

  const [tenantId, setTenantId] = useState('');
  const [confirmedTenantId, setConfirmedTenantId] = useState('');
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [manifestJson, setManifestJson] = useState<Record<string, unknown> | null>(null);
  const [isManifestViewerOpen, setIsManifestViewerOpen] = useState(false);
  const [isCodeDiffViewerOpen, setIsCodeDiffViewerOpen] = useState(false);
  const [codeDiffEntries, setCodeDiffEntries] = useState<Array<{ file: string; diff: string; truncated?: boolean }>>([]);
  const [lastImplementErrors, setLastImplementErrors] = useState<string[]>([]);

  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { role: 'agent', content: 'Operator console initialized. Enter a tenant key or open from a repository card.', timestamp: INITIAL_CHAT_TIMESTAMP },
  ]);

  const [assetType, setAssetType] = useState<AssetType>('logo_light');
  const [uploadedAssetsSession, setUploadedAssetsSession] = useState<AssetPreview[]>([]);

  const [implementRun, setImplementRun] = useState<ImplementRunState>({
    appTargets: [...DEFAULT_APP_TARGETS],
    validatorIssues: [],
    repairPassUsed: false,
  });

  const [status, setStatus] = useState<StatusState>({
    level: 'info',
    text: 'Enter Tenant ID to continue.',
  });
  const [resolvedRepoPath, setResolvedRepoPath] = useState('');
  const [previewNonce, setPreviewNonce] = useState(0);
  const [previewMeta, setPreviewMeta] = useState<PreviewMetaResponse | null>(null);
  const [previewMetaLoading, setPreviewMetaLoading] = useState(false);

  const [loading, setLoading] = useState<LoadingState>({
    chat: false,
    manifest: false,
    confirm: false,
    implement: false,
    repair: false,
    upload: false,
    resetSession: false,
    resetRepo: false,
  });

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

  const refreshPreview = useCallback(() => {
    setPreviewNonce(Date.now());
  }, []);

  useEffect(() => {
    // Keep initial SSR and client render deterministic for hydration safety.
    setPreviewNonce(Date.now());
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, loading.chat]);

  useEffect(() => {
    if (!previewMetaUrl) {
      setPreviewMeta(null);
      setPreviewMetaLoading(false);
      return;
    }

    let isCancelled = false;
    setPreviewMetaLoading(true);

    const fetchPreviewMeta = async () => {
      try {
        const response = await fetch(previewMetaUrl, { cache: 'no-store' });
        const payload = await parseJsonSafe<PreviewMetaResponse>(response);
        if (!response.ok || !payload || !payload.source) {
          if (!isCancelled) {
            setPreviewMeta(null);
          }
          return;
        }
        if (!isCancelled) {
          setPreviewMeta(payload);
        }
      } catch {
        if (!isCancelled) {
          setPreviewMeta(null);
        }
      } finally {
        if (!isCancelled) {
          setPreviewMetaLoading(false);
        }
      }
    };

    void fetchPreviewMeta();

    return () => {
      isCancelled = true;
    };
  }, [previewMetaUrl]);

  const previewSourceLabel = useMemo(() => {
    if (!projectIdFromQuery) return 'Preview Source: Unavailable';
    if (previewMetaLoading) return 'Preview Source: Resolving...';
    if (!previewMeta?.source) return 'Preview Source: Unknown';

    if (previewMeta.source === 'subspace') {
      return `Preview Source: SubSpace-${effectiveTenantId || 'tenant'}`;
    }

    if (effectiveTenantId && previewMeta.tenant_repo_exists === false) {
      return `Preview Source: Base (SubSpace-${effectiveTenantId} not found)`;
    }

    return 'Preview Source: Base';
  }, [effectiveTenantId, previewMeta, previewMetaLoading, projectIdFromQuery]);

  const previewSourceChipLabel = useMemo(() => {
    if (!projectIdFromQuery) return 'Source: Unavailable';
    if (previewMetaLoading) return 'Source: Resolving';
    if (previewMeta?.source === 'subspace') return 'Source: SubSpace';
    if (previewMeta?.source === 'base') return 'Source: Base';
    return 'Source: Unknown';
  }, [previewMeta?.source, previewMetaLoading, projectIdFromQuery]);

  const syncConfirmationState = useCallback((confirmation?: ConfirmationState) => {
    const isManifestConfirmed = Boolean(confirmation?.is_confirmed) && !confirmation?.has_unconfirmed_changes;
    setIsConfirmed(isManifestConfirmed);
    setConfirmedTenantId(isManifestConfirmed && confirmation?.confirmed_tenant_id ? confirmation.confirmed_tenant_id : '');
  }, []);

  const loadAssets = useCallback(async (activeTenantId: string) => {
    const response = await fetch(`/api/customization/assets/${encodeURIComponent(activeTenantId)}`, {
      cache: 'no-store',
    });
    const payload = await parseJsonSafe<AssetsListResponse>(response);
    if (!response.ok) {
      throw new Error(getErrorMessage(payload, 'Failed to load tenant assets.'));
    }

    const assetsMap = payload?.assets || {};
    const nextAssets: AssetPreview[] = Object.entries(assetsMap)
      .filter(([key]) => isAssetType(key))
      .map(([key, value]) => {
        const previewUrl = `/api/customization/assets/${encodeURIComponent(activeTenantId)}/${encodeURIComponent(key)}`;
        return {
          assetType: key as AssetType,
          fileName: value.filename || `${key}.asset`,
          previewUrl,
          uploadedAt: nowStamp(),
          storedPath: value.filename ? `tenants/${activeTenantId}/assets/${value.filename}` : undefined,
        };
      });

    setUploadedAssetsSession(nextAssets);
  }, []);

  const fetchManifest = useCallback(async (overrideTenantId?: string, silent = false) => {
    const activeTenantId = sanitizeTenantId(overrideTenantId || tenantId);
    if (!activeTenantId) {
      setStatus({ level: 'warning', text: 'Tenant required: Enter Tenant ID before fetching manifest.' });
      return;
    }

    setLoading((prev) => ({ ...prev, manifest: true }));
    if (!silent) setStatus({ level: 'info', text: 'Fetching manifest...' });

    try {
      const response = await fetch(`/api/customization/manifest?tenant_id=${encodeURIComponent(activeTenantId)}`, {
        cache: 'no-store',
      });
      const payload = await parseJsonSafe<ManifestResponse>(response);
      if (!response.ok || !payload?.manifest) {
        throw new Error(getErrorMessage(payload, 'Failed to fetch manifest.'));
      }

      setManifestJson(payload.manifest);
      syncConfirmationState(payload.confirmation);
      await loadAssets(activeTenantId);

      if (!silent) {
        setStatus({ level: 'success', text: 'Manifest fetched: Manifest loaded successfully.' });
      }
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
    setChatMessages([
      {
        role: 'agent',
        content: `Tenant key loaded: ${initialTenant}. You can start chatting now.`,
        timestamp: nowStamp(),
      },
    ]);
    setStatus({ level: 'info', text: `Restored session for Tenant ID: ${initialTenant}` });
  }, [fetchManifest, projectNameFromQuery, tenantFromQuery]);

  useEffect(() => {
    if (!projectIdFromQuery) {
      setResolvedRepoPath('');
      return;
    }

    let isCancelled = false;

    const resolveRepoPath = async () => {
      try {
        const response = await fetch(
          `/api/customization/resolve-repo-path?project_id=${encodeURIComponent(projectIdFromQuery)}`,
          { cache: 'no-store' },
        );
        const payload = await parseJsonSafe<ResolveRepoPathResponse>(response);
        if (!response.ok || !payload?.base_repo_path) {
          if (!isCancelled) {
            setResolvedRepoPath('');
          }
          return;
        }

        if (!isCancelled) {
          setResolvedRepoPath(payload.base_repo_path);
        }
      } catch {
        if (!isCancelled) {
          setResolvedRepoPath('');
        }
      }
    };

    void resolveRepoPath();

    return () => {
      isCancelled = true;
    };
  }, [projectIdFromQuery]);

  const handleTenantChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const nextTenantId = sanitizeTenantId(event.target.value);
    setTenantId(nextTenantId);

    if (typeof window !== 'undefined') {
      if (nextTenantId) {
        window.localStorage.setItem(TENANT_STORAGE_KEY, nextTenantId);
      } else {
        window.localStorage.removeItem(TENANT_STORAGE_KEY);
      }
    }

    setIsConfirmed(false);
    setConfirmedTenantId('');
    setManifestJson(null);
    setCodeDiffEntries([]);
    setLastImplementErrors([]);
    setIsCodeDiffViewerOpen(false);
    setUploadedAssetsSession([]);
    setImplementRun({ appTargets: [...DEFAULT_APP_TARGETS], validatorIssues: [], repairPassUsed: false });

    if (!nextTenantId) {
      setStatus({ level: 'warning', text: 'Tenant required: Enter Tenant ID to continue.' });
      return;
    }

    setChatMessages([
      {
        role: 'agent',
        content: `Tenant key set to ${nextTenantId}. You can start chatting now.`,
        timestamp: nowStamp(),
      },
    ]);
    setStatus({ level: 'info', text: 'Tenant ID updated. Fetch manifest to begin.' });
  }, []);

  const performRepoReset = useCallback(async (options?: { suppressPrompt?: boolean; preserveChatHistory?: boolean }) => {
    const activeTenantId = sanitizeTenantId(tenantId);
    if (!activeTenantId) {
      setStatus({ level: 'warning', text: 'Tenant required: Enter Tenant ID before repo reset.' });
      return false;
    }

    const shouldPrompt = !(options?.suppressPrompt ?? false);
    if (shouldPrompt && !window.confirm('This will reset tenant repo state entirely. Continue?')) {
      return false;
    }

    setLoading((prev) => ({ ...prev, resetRepo: true }));
    setStatus({ level: 'warning', text: 'Resetting tenant repository...' });

    try {
      const response = await fetch('/api/customization/reset-repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: activeTenantId,
          project_id: projectIdFromQuery || undefined,
        }),
      });

      const payload = await parseJsonSafe<{
        tenant_id: string;
        repo_path: string;
        manifest?: Record<string, unknown>;
        confirmation?: ConfirmationState;
      }>(response);

      if (!response.ok || !payload) {
        throw new Error(getErrorMessage(payload, 'Failed to reset tenant repo.'));
      }

      if (payload.manifest) {
        setManifestJson(payload.manifest);
      }

      setCodeDiffEntries([]);
      setLastImplementErrors([]);
      setIsCodeDiffViewerOpen(false);
      setPreviewNonce(Date.now());

      if (options?.preserveChatHistory) {
        setChatMessages((prev) => [
          ...prev,
          { role: 'agent', content: 'Reverted to original UI. Tenant repository was reset to base state.', timestamp: nowStamp() },
        ]);
      } else {
        setChatMessages([
          { role: 'agent', content: 'Repository reset complete. Awaiting next instructions.', timestamp: nowStamp() },
        ]);
      }

      setImplementRun({ appTargets: [...DEFAULT_APP_TARGETS], validatorIssues: [], repairPassUsed: false });
      syncConfirmationState(payload.confirmation);
      await loadAssets(activeTenantId);

      setStatus({
        level: 'success',
        text: `Reset repo success: Tenant repo reset complete for ${payload.tenant_id}.`,
        details: payload.repo_path,
      });

      return true;
    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to reset tenant repo.' });
      return false;
    } finally {
      setLoading((prev) => ({ ...prev, resetRepo: false }));
    }
  }, [loadAssets, projectIdFromQuery, syncConfirmationState, tenantId]);

  const handleChatSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const activeTenantId = sanitizeTenantId(tenantId);
    const message = chatInput.trim();
    if (!activeTenantId || !message) return;

    const outgoingMessage: ChatMessage = {
      role: 'user',
      content: message,
      timestamp: nowStamp(),
    };

    setChatMessages((prev) => [...prev, outgoingMessage]);
    setChatInput('');

    if (REVERT_TO_BASE_CHAT_PATTERN.test(message)) {
      setStatus({ level: 'info', text: 'Reverting to original UI...' });
      await performRepoReset({ suppressPrompt: true, preserveChatHistory: true });
      return;
    }

    setLoading((prev) => ({ ...prev, chat: true }));
    setStatus({ level: 'info', text: 'Chat sent: Sending message to customization agent...' });

    try {
      const response = await fetch('/api/customization/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: activeTenantId, message }),
      });

      const payload = await parseJsonSafe<ChatResponse>(response);
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, 'Failed to send chat message.'));
      }

      const assistantResponse = payload?.response || 'Agent updated the manifest.';
      setChatMessages((prev) => [
        ...prev,
        { role: 'agent', content: assistantResponse, timestamp: nowStamp() },
      ]);

      if (payload?.manifest) {
        setManifestJson(payload.manifest);
      }

      syncConfirmationState(payload?.confirmation);
      if (payload?.confirmation?.has_unconfirmed_changes) {
        setStatus({ level: 'warning', text: 'Manifest updated. Confirm again before implementation.' });
      } else {
        setStatus({ level: 'success', text: 'Chat success: Agent response received. Manifest refreshed.' });
      }

      await loadAssets(activeTenantId);
    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to send chat message.' });
    } finally {
      setLoading((prev) => ({ ...prev, chat: false }));
    }
  }, [chatInput, loadAssets, performRepoReset, syncConfirmationState, tenantId]);

  const handleConfirm = useCallback(async () => {
    const activeTenantId = sanitizeTenantId(tenantId);
    if (!activeTenantId) {
      setStatus({ level: 'warning', text: 'Tenant required: Enter Tenant ID before confirming.' });
      return;
    }

    setLoading((prev) => ({ ...prev, confirm: true }));
    setStatus({ level: 'info', text: 'Confirming manifest...' });

    try {
      const response = await fetch('/api/customization/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: activeTenantId }),
      });

      const payload = await parseJsonSafe<ConfirmResponse>(response);
      if (!response.ok || !payload) {
        throw new Error(getErrorMessage(payload, 'Failed to confirm manifest.'));
      }

      syncConfirmationState(payload.confirmation);
      setStatus({
        level: 'success',
        text: `Confirm success: Manifest confirmed for ${payload.tenant_id}.`,
        details: payload.path,
      });
    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to confirm manifest.' });
    } finally {
      setLoading((prev) => ({ ...prev, confirm: false }));
    }
  }, [syncConfirmationState, tenantId]);

  const runImplementation = useCallback(async (options?: { isRepairPass?: boolean; validatorIssues?: string[] }) => {
    const activeTenantId = sanitizeTenantId(confirmedTenantId || tenantId);
    if (!activeTenantId) {
      setStatus({ level: 'warning', text: 'Tenant required: Enter Tenant ID before implementation.' });
      return;
    }

    if (!isConfirmed) {
      setStatus({ level: 'error', text: 'Implement blocked: Confirm manifest before implementation.' });
      return;
    }

    const isRepairPass = Boolean(options?.isRepairPass);
    const validatorIssues = Array.isArray(options?.validatorIssues)
      ? options.validatorIssues.filter((issue) => issue.trim().length > 0)
      : [];

    setLoading((prev) => ({
      ...prev,
      implement: !isRepairPass,
      repair: isRepairPass,
    }));

    setStatus({
      level: 'info',
      text: isRepairPass
        ? 'Repair running: Running one-time repair pass...'
        : 'Implement running: Implementing changes across app targets...',
    });

    try {
      const response = await fetch('/api/customization/implement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: activeTenantId,
          project_id: projectIdFromQuery || undefined,
          app_targets: implementRun.appTargets,
          validator_issues: validatorIssues.length > 0 ? validatorIssues : undefined,
        }),
      });

      const payload = await parseJsonSafe<ImplementResponse>(response);
      if (!response.ok || !payload) {
        throw new Error(getErrorMessage(payload, 'Implementation failed.'));
      }

      const nextDiffEntries = Array.isArray(payload.modified_file_diffs)
        ? payload.modified_file_diffs.filter(
          (entry): entry is { file: string; diff: string; truncated?: boolean } => (
            Boolean(entry)
            && typeof entry.file === 'string'
            && typeof entry.diff === 'string'
          ),
        )
        : [];

      const errors = Array.isArray(payload.errors)
        ? payload.errors.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];

      setCodeDiffEntries(nextDiffEntries);
      setLastImplementErrors(errors);
      // Always open diff panel after implement so users can inspect either
      // concrete diffs or explicit reasons why no diff was produced.
      setIsCodeDiffViewerOpen(true);

      const validatorIssuesFromRun = errors.filter(
        (issue) => issue.startsWith('Validator issue') || issue.startsWith('[Validator]'),
      );

      if (errors.length > 0 && validatorIssuesFromRun.length > 0 && !isRepairPass) {
        setImplementRun((prev) => ({
          ...prev,
          validatorIssues: validatorIssuesFromRun,
          repairPassUsed: false,
        }));

        setStatus({
          level: 'warning',
          text: 'Validator issues: Review issues and approve one repair pass.',
          details: `${validatorIssuesFromRun.length} validator issue(s) detected.`,
        });
        return;
      }

      if (errors.length > 0) {
        setStatus({
          level: 'error',
          text: isRepairPass
            ? 'Repair completed with remaining issues.'
            : 'Implementation completed with issues.',
          details: errors.join(' | '),
        });
        return;
      }

      if (payload.status === 'no_changes') {
        setImplementRun((prev) => ({
          ...prev,
          validatorIssues: [],
          repairPassUsed: isRepairPass ? true : prev.repairPassUsed,
        }));
        setLastImplementErrors([]);
        setStatus({
          level: 'warning',
          text: 'Implement completed with no file changes.',
          details: 'No modifications were applied in this run.',
        });
        setPreviewNonce(Date.now());
        await fetchManifest(activeTenantId, true);
        return;
      }

      setImplementRun((prev) => ({
        ...prev,
        validatorIssues: [],
        repairPassUsed: isRepairPass ? true : prev.repairPassUsed,
      }));

      setStatus({
        level: 'success',
        text: isRepairPass
          ? `Implementation success (post-repair): Rolled out to ${(payload.app_targets || implementRun.appTargets).join(', ')}.`
          : `Implementation success: Rolled out to ${(payload.app_targets || implementRun.appTargets).join(', ')}.`,
        details: payload.base_repo_path || undefined,
      });

      setLastImplementErrors([]);
      setPreviewNonce(Date.now());
      await fetchManifest(activeTenantId, true);
    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Implementation failed.' });
    } finally {
      setLoading((prev) => ({
        ...prev,
        implement: false,
        repair: false,
      }));
    }
  }, [confirmedTenantId, fetchManifest, implementRun.appTargets, isConfirmed, projectIdFromQuery, tenantId]);

  const handleRepair = useCallback(async () => {
    if (implementRun.validatorIssues.length === 0) return;
    setImplementRun((prev) => ({ ...prev, repairPassUsed: true }));
    await runImplementation({
      isRepairPass: true,
      validatorIssues: implementRun.validatorIssues,
    });
  }, [implementRun.validatorIssues, runImplementation]);

  const handleUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const activeTenantId = sanitizeTenantId(tenantId);

    if (!file || !activeTenantId) {
      event.target.value = '';
      return;
    }

    setLoading((prev) => ({ ...prev, upload: true }));
    setStatus({ level: 'info', text: `Uploading ${assetType}...` });

    try {
      const formData = new FormData();
      formData.append('tenant_id', activeTenantId);
      formData.append('asset_type', assetType);
      formData.append('file', file);

      const response = await fetch('/api/customization/assets/upload', {
        method: 'POST',
        body: formData,
      });

      const payload = await parseJsonSafe<UploadAssetResponse>(response);
      if (!response.ok || !payload) {
        throw new Error(getErrorMessage(payload, 'Asset upload failed.'));
      }

      const previewUrl = `/api/customization/assets/${encodeURIComponent(activeTenantId)}/${encodeURIComponent(assetType)}`;
      setUploadedAssetsSession((prev) => {
        const withoutCurrentType = prev.filter((entry) => entry.assetType !== assetType);
        return [
          ...withoutCurrentType,
          {
            assetType,
            fileName: file.name,
            previewUrl,
            uploadedAt: nowStamp(),
            storedPath: payload.stored_path,
          },
        ];
      });

      syncConfirmationState(payload.confirmation);
      setStatus({ level: 'success', text: 'Upload success: Asset uploaded and manifest updated.' });
      await fetchManifest(activeTenantId, true);
    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Asset upload failed.' });
    } finally {
      setLoading((prev) => ({ ...prev, upload: false }));
      event.target.value = '';
    }
  }, [assetType, fetchManifest, syncConfirmationState, tenantId]);

  const handleResetSession = useCallback(async () => {
    const activeTenantId = sanitizeTenantId(tenantId);
    if (!activeTenantId) {
      setStatus({ level: 'warning', text: 'Tenant required: Enter Tenant ID before reset.' });
      return;
    }

    setLoading((prev) => ({ ...prev, resetSession: true }));
    setStatus({ level: 'info', text: 'Resetting session...' });

    try {
      const response = await fetch('/api/customization/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: activeTenantId }),
      });

      const payload = await parseJsonSafe<ManifestResponse>(response);
      if (!response.ok || !payload?.manifest) {
        throw new Error(getErrorMessage(payload, 'Failed to reset session.'));
      }

      setChatMessages([
        { role: 'agent', content: 'Session reset. Awaiting instructions.', timestamp: nowStamp() },
      ]);
      setManifestJson(payload.manifest);
      setCodeDiffEntries([]);
      setLastImplementErrors([]);
      setIsCodeDiffViewerOpen(false);
      setImplementRun({ appTargets: [...DEFAULT_APP_TARGETS], validatorIssues: [], repairPassUsed: false });
      syncConfirmationState(payload.confirmation);
      await loadAssets(activeTenantId);
      setStatus({ level: 'success', text: 'Reset session success: Session reset complete.' });
    } catch (error) {
      setStatus({ level: 'error', text: error instanceof Error ? error.message : 'Failed to reset session.' });
    } finally {
      setLoading((prev) => ({ ...prev, resetSession: false }));
    }
  }, [loadAssets, syncConfirmationState, tenantId]);

  const handleResetRepo = useCallback(async () => {
    await performRepoReset();
  }, [performRepoReset]);

  const isGlobalDisabled = !tenantId.trim();

  const statusIcon = useMemo(() => {
    if (status.level === 'success') return <CheckCircle2 className="h-4 w-4 shrink-0 text-white" />;
    if (status.level === 'error') return <XCircle className="h-4 w-4 shrink-0 text-rose-500" />;
    if (status.level === 'warning') return <AlertTriangle className="h-4 w-4 shrink-0 text-white" />;
    return <TerminalSquare className="h-4 w-4 shrink-0 text-zinc-500" />;
  }, [status.level]);

  return (
    <div className="flex h-screen flex-col overflow-y-auto bg-[#000000] font-sans text-zinc-300 selection:bg-white selection:text-black">
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
            .custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
            .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
            .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #262626; border-radius: 10px; }
            .custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #3f3f46; }
          `,
        }}
      />

      <header className="z-20 flex h-14 shrink-0 items-center justify-between border-b border-[#1A1A1A] bg-[#050505] px-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/dashboard')}
            className="flex items-center gap-1.5 rounded border border-[#262626] bg-[#0A0A0A] px-2.5 py-1 text-[10px] font-semibold tracking-wider text-zinc-300 uppercase transition-colors hover:border-zinc-500 hover:text-white"
          >
            <ArrowLeft className="h-3 w-3" /> Back
          </button>
          <div className="flex h-6 w-6 items-center justify-center rounded bg-white text-[10px] font-bold tracking-tighter text-black">TC</div>
          <div className="flex flex-col">
            <h1 className="text-[11px] font-bold tracking-widest text-white uppercase">Tenant Customization Operator</h1>
            {(projectNameFromQuery || projectIdFromQuery) && (
              <p className="text-[10px] text-zinc-500">
                {projectNameFromQuery || 'Project'}
                {projectIdFromQuery ? ` (${projectIdFromQuery})` : ''}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {runAll && projectIdFromQuery ? (
            <button
              type="button"
              onClick={() => router.push(securityPath)}
              className="inline-flex items-center justify-center rounded-md border border-[#d4d4d8] bg-zinc-100 px-4 py-2 text-xs font-semibold text-black shadow-[0_8px_30px_rgba(0,0,0,0.35)] transition-colors hover:bg-white"
            >
              Move to Security Scan
            </button>
          ) : null}
          <div className="flex items-center gap-3 rounded-md border border-[#262626] bg-[#000000] px-3 py-1">
            <Key className="h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              value={tenantId}
              onChange={handleTenantChange}
              placeholder="tenant-id"
              className="w-48 bg-transparent text-[12px] font-mono text-white placeholder:text-zinc-600 transition-colors focus:outline-none"
            />
          </div>
        </div>
      </header>

      <main className="relative grid h-[calc(100vh-56px)] min-h-0 flex-1 grid-cols-12 overflow-visible">
        {isGlobalDisabled && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#000000]/80 backdrop-blur-sm">
            <div className="flex max-w-sm flex-col items-center gap-4 rounded-lg border border-[#262626] bg-[#050505] p-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[#262626] bg-[#111111]">
                <Lock className="h-5 w-5 text-white" />
              </div>
              <div>
                <h3 className="mb-1 font-bold text-white">Workspace Locked</h3>
                <p className="text-xs leading-relaxed text-zinc-400">Please enter a valid Tenant ID in the header bar to load customization controls.</p>
              </div>
            </div>
          </div>
        )}

        <section className="col-span-3 flex min-h-0 flex-col border-r border-[#1A1A1A] bg-[#000000]">
          <div className="flex items-center gap-2 border-b border-[#1A1A1A] bg-[#050505] px-4 py-3">
            <MessageSquare className="h-3.5 w-3.5 text-zinc-400" />
            <span className="text-[10px] font-bold tracking-widest text-zinc-300 uppercase">Agent Chat</span>
          </div>

          <div className="shrink-0 border-b border-[#1A1A1A] bg-[#050505] p-3">
            <form onSubmit={handleChatSubmit} className="relative flex items-center">
              <input
                type="text"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                disabled={loading.chat || isGlobalDisabled}
                placeholder="Type here and press Enter..."
                className="w-full rounded border border-[#262626] bg-[#000000] py-2.5 pr-10 pl-3 text-xs text-zinc-200 transition-colors placeholder:text-zinc-500 focus:border-white focus:outline-none disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!chatInput.trim() || loading.chat || isGlobalDisabled}
                className="absolute right-1.5 inline-flex items-center gap-1 rounded bg-white px-2 py-1.5 text-[10px] font-semibold tracking-wide text-black transition-colors disabled:bg-transparent disabled:text-zinc-600"
              >
                <Send className="h-3 w-3" />
                Send
              </button>
            </form>
          </div>

          <div className="custom-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            {chatMessages.map((message, index) => (
              <div key={`${message.timestamp}-${index}`} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 px-1">
                  {message.role === 'agent' ? (
                    <Bot className="h-3 w-3 text-zinc-500" />
                  ) : (
                    <User className="h-3 w-3 text-zinc-500" />
                  )}
                  <span className="text-[10px] font-bold text-zinc-500 uppercase">{message.role === 'agent' ? 'Agent' : 'You'}</span>
                  <span className="ml-auto font-mono text-[9px] text-zinc-600">{message.timestamp}</span>
                </div>
                <div className={`rounded-md border p-3 text-[12px] leading-relaxed ${message.role === 'agent' ? 'border-[#1A1A1A] bg-[#050505] text-zinc-300' : 'border-[#262626] bg-[#111111] text-white'}`}>
                  {message.content}
                </div>
              </div>
            ))}

            {loading.chat && (
              <div className="flex animate-pulse flex-col gap-1.5">
                <div className="flex items-center gap-2 px-1">
                  <Bot className="h-3 w-3 text-zinc-500" />
                  <span className="text-[10px] font-bold text-zinc-500 uppercase">Agent</span>
                </div>
                <div className="rounded-md border border-[#1A1A1A] bg-[#050505] p-3 text-[12px] text-zinc-500">
                  Processing request...
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

        </section>

        <section className="col-span-5 flex min-h-0 flex-col border-r border-[#1A1A1A] bg-[#000000]">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-[#1A1A1A] bg-[#050505] px-4 py-3">
              <div className="flex items-center gap-2">
                <TerminalSquare className="h-3.5 w-3.5 text-zinc-400" />
                <span className="text-[10px] font-bold tracking-widest text-zinc-300 uppercase">Live Preview Canvas</span>
                <span
                  title={`${previewSourceLabel}${previewMeta?.preview_root_path ? `\n${previewMeta.preview_root_path}` : ''}`}
                  className="max-w-[180px] truncate rounded border border-[#262626] bg-[#000000] px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-zinc-400"
                >
                  {previewSourceChipLabel}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={refreshPreview}
                  disabled={!projectIdFromQuery || isGlobalDisabled}
                  className="inline-flex items-center gap-1 rounded border border-[#262626] bg-[#000000] px-2 py-1 text-[10px] font-semibold tracking-wider text-zinc-300 uppercase transition-colors hover:border-zinc-500 hover:text-white disabled:opacity-50"
                >
                  <RefreshCw className="h-3 w-3" /> Refresh
                </button>
                <a
                  href={previewUrl || '#'}
                  target="_blank"
                  rel="noreferrer"
                  className={`inline-flex items-center rounded border border-[#262626] bg-[#111111] px-2 py-1 text-[10px] font-semibold tracking-wider text-zinc-300 uppercase transition-colors hover:border-zinc-500 hover:text-white ${!projectIdFromQuery || isGlobalDisabled ? 'pointer-events-none opacity-50' : ''}`}
                >
                  Open
                </a>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 bg-[#000000] p-4">
              {projectIdFromQuery ? (
                <div className="h-full w-full overflow-hidden rounded border border-[#262626] bg-white">
                  <iframe
                    key={previewUrl}
                    src={previewUrl}
                    title="Repository UI preview"
                    className="h-full w-full border-0"
                  />
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center space-y-3 text-zinc-600">
                  <TerminalSquare className="h-6 w-6 opacity-30" />
                  <p className="text-xs">Open customization from a project card to enable live preview.</p>
                </div>
              )}
            </div>
          </div>

          <div className="flex h-56 flex-col border-t border-[#1A1A1A] bg-[#050505]">
            <div className="flex items-center gap-2 border-b border-[#1A1A1A] px-4 py-3">
              <ImageIcon className="h-3.5 w-3.5 text-zinc-400" />
              <span className="text-[10px] font-bold tracking-widest text-zinc-300 uppercase">Branding Assets</span>
            </div>

            <div className="flex h-full flex-col overflow-hidden p-4">
              <div className="mb-4 flex shrink-0 gap-2">
                <select
                  value={assetType}
                  onChange={(event) => setAssetType(event.target.value as AssetType)}
                  disabled={loading.upload || isGlobalDisabled}
                  className="cursor-pointer rounded border border-[#262626] bg-[#000000] px-2 py-1.5 text-xs text-zinc-300 focus:border-white focus:outline-none disabled:opacity-60"
                >
                  {ASSET_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>

                <label className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded border border-dashed border-[#333333] bg-[#000000] text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-white ${loading.upload || isGlobalDisabled ? 'cursor-not-allowed opacity-50' : ''}`}>
                  <Upload className="h-3.5 w-3.5" />
                  {loading.upload ? 'Uploading...' : 'Select File'}
                  <input
                    type="file"
                    className="hidden"
                    accept="image/*,.ico,.svg"
                    onChange={handleUpload}
                    disabled={loading.upload || isGlobalDisabled}
                  />
                </label>
              </div>

              <div className="custom-scrollbar flex-1 space-y-2 overflow-y-auto">
                {uploadedAssetsSession.map((asset) => (
                  <div key={asset.assetType} className="flex items-center justify-between rounded border border-[#1A1A1A] bg-[#000000] px-3 py-2 text-xs">
                    <div className="flex items-center gap-3">
                      <div className="w-24 text-[9px] font-bold text-zinc-500 uppercase">{ASSET_OPTIONS.find((item) => item.value === asset.assetType)?.label || asset.assetType}</div>
                      <span className="max-w-[140px] truncate font-mono text-zinc-300">{asset.fileName}</span>
                    </div>
                    <a href={asset.previewUrl} target="_blank" rel="noreferrer" className="text-zinc-500 underline transition-colors hover:text-white">
                      Preview
                    </a>
                  </div>
                ))}

                {uploadedAssetsSession.length === 0 && (
                  <div className="py-4 text-center text-xs text-zinc-600">No assets uploaded in this session.</div>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="col-span-4 flex min-h-0 flex-col bg-[#050505]">
          <div className="border-b border-[#1A1A1A] p-4">
            <BorderGlow active className="h-32">
              <div className="flex h-full flex-col overflow-hidden rounded-[inherit] bg-black p-3">
                <div className="mb-2 flex items-center gap-2 border-b border-[#1A1A1A] pb-2 text-zinc-500">
                  <TerminalSquare className="h-3.5 w-3.5" />
                  <span className="text-[9px] font-bold tracking-widest uppercase">System Output</span>
                </div>

                <div className="custom-scrollbar flex flex-1 gap-3 overflow-y-auto font-mono text-[12px] leading-relaxed">
                  {statusIcon}
                  <div className="flex flex-col">
                    <span className={status.level === 'error' ? 'text-rose-400' : 'text-zinc-200'}>{status.text}</span>
                    {status.details ? <span className="mt-1 text-zinc-500">{status.details}</span> : null}
                  </div>
                </div>
              </div>
            </BorderGlow>
          </div>

          <div className="custom-scrollbar min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
            <div className="space-y-3">
              <span className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Pipeline Controls</span>

              <div className="space-y-1">
                <span className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Resolved Repo Path</span>
                <div className="rounded border border-[#262626] bg-[#000000] px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-300">
                  {resolvedRepoPath || 'Resolving from selected project...'}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => void fetchManifest()}
                  disabled={loading.manifest || isGlobalDisabled}
                  className="flex flex-col items-center justify-center gap-2 rounded border border-[#262626] bg-[#000000] p-3 transition-all hover:border-zinc-500 hover:bg-[#111111] disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 text-zinc-300 ${loading.manifest ? 'animate-spin' : ''}`} />
                  <span className="text-[11px] font-bold tracking-wider text-white uppercase">Fetch</span>
                </button>

                <button
                  onClick={() => void handleConfirm()}
                  disabled={loading.confirm || isConfirmed || isGlobalDisabled}
                  className={`flex flex-col items-center justify-center gap-2 rounded border p-3 transition-all disabled:opacity-50 ${isConfirmed ? 'border-white bg-white text-black' : 'border-[#262626] bg-[#000000] text-white hover:border-zinc-500 hover:bg-[#111111]'}`}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span className="text-[11px] font-bold tracking-wider uppercase">{isConfirmed ? 'Confirmed' : 'Confirm'}</span>
                </button>
              </div>

              <PixelCard gap={4} speed={40} colors="#ffffff,#a1a1aa,#000000" className="mt-3 cursor-pointer rounded border border-[#262626] transition-colors hover:border-white">
                <button
                  onClick={() => void runImplementation()}
                  disabled={!isConfirmed || loading.implement || isGlobalDisabled}
                  className="flex w-full items-center justify-center gap-2 bg-transparent py-4 text-[12px] font-bold tracking-widest text-white uppercase disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Play className="h-4 w-4 fill-current" />
                  {loading.implement ? 'Implementing...' : 'Execute Implement'}
                </button>
              </PixelCard>

              <button
                onClick={() => setIsManifestViewerOpen((prev) => !prev)}
                disabled={isGlobalDisabled}
                className="flex w-full items-center justify-center gap-2 rounded border border-[#262626] bg-[#000000] py-2.5 text-[11px] font-bold tracking-widest text-zinc-300 uppercase transition-colors hover:border-zinc-500 hover:text-white disabled:opacity-50"
              >
                <FileJson className="h-4 w-4" />
                {isManifestViewerOpen ? 'Hide Manifest JSON' : 'View Manifest JSON'}
              </button>

              <button
                onClick={() => setIsCodeDiffViewerOpen((prev) => !prev)}
                disabled={isGlobalDisabled}
                className="flex w-full items-center justify-center gap-2 rounded border border-[#262626] bg-[#000000] py-2.5 text-[11px] font-bold tracking-widest text-zinc-300 uppercase transition-colors hover:border-zinc-500 hover:text-white disabled:opacity-50"
              >
                <TerminalSquare className="h-4 w-4" />
                {isCodeDiffViewerOpen ? 'Hide Code Diff' : 'View Code Diff'}
              </button>
            </div>

            <div className="space-y-3 border-t border-[#1A1A1A] pt-4">
              <span className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Implementation Scope</span>
              <div className="flex flex-wrap gap-2">
                {implementRun.appTargets.map((target) => (
                  <span key={target} className="rounded border border-[#262626] bg-[#111111] px-2 py-1 font-mono text-[10px] text-zinc-400">
                    {target}
                  </span>
                ))}
              </div>
            </div>

            {isManifestViewerOpen && (
              <div className="space-y-2 border-t border-[#1A1A1A] pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Manifest JSON</span>
                  <button
                    onClick={() => void fetchManifest()}
                    disabled={loading.manifest || isGlobalDisabled}
                    className="inline-flex items-center gap-1 rounded border border-[#262626] bg-[#000000] px-2 py-1 text-[10px] font-semibold tracking-wider text-zinc-300 uppercase transition-colors hover:border-zinc-500 hover:text-white disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${loading.manifest ? 'animate-spin' : ''}`} /> Refresh
                  </button>
                </div>

                <div className="custom-scrollbar max-h-56 overflow-y-auto rounded border border-[#262626] bg-[#000000] p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                  {manifestJson ? (
                    <pre className="whitespace-pre-wrap break-all text-zinc-300">{JSON.stringify(manifestJson, null, 2)}</pre>
                  ) : (
                    <p className="text-zinc-500">No manifest loaded yet. Click Refresh to fetch latest manifest.</p>
                  )}
                </div>
              </div>
            )}

            {isCodeDiffViewerOpen && (
              <div className="space-y-2 border-t border-[#1A1A1A] pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Code Diff</span>
                  <span className="text-[10px] text-zinc-500">{codeDiffEntries.length} file(s)</span>
                </div>

                <div className="custom-scrollbar max-h-72 space-y-3 overflow-y-auto rounded border border-[#262626] bg-[#000000] p-3">
                  {codeDiffEntries.length > 0 ? (
                    codeDiffEntries.map((entry) => (
                      <div key={`${entry.file}-${entry.diff.length}`} className="rounded border border-[#1A1A1A] bg-[#050505] p-2">
                        <div className="mb-2 font-mono text-[10px] font-bold tracking-wide text-zinc-400 uppercase">{entry.file}</div>
                        <pre className="custom-scrollbar max-h-52 overflow-auto whitespace-pre-wrap break-all rounded border border-[#262626] bg-black p-2 font-mono text-[10px] leading-relaxed text-zinc-300">
                          {entry.diff}
                        </pre>
                        {entry.truncated && <p className="mt-1 text-[10px] text-zinc-500">Diff truncated.</p>}
                      </div>
                    ))
                  ) : (
                    <div className="space-y-2 text-xs text-zinc-500">
                      <p>No code diff was produced for the last implement run.</p>
                      {lastImplementErrors.length > 0 && (
                        <ul className="list-disc space-y-1 pl-4">
                          {lastImplementErrors.map((error) => (
                            <li key={error} className="break-all">{error}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {implementRun.validatorIssues.length > 0 && !implementRun.repairPassUsed && (
              <div className="relative flex animate-fade-in flex-col gap-3 overflow-hidden rounded border border-[#262626] bg-[#000000] p-4">
                <div className="absolute top-0 bottom-0 left-0 w-1 bg-white" />
                <div className="flex items-center gap-2 text-xs font-bold tracking-wider text-white uppercase">
                  <ShieldAlert className="h-4 w-4" />
                  Validator Intervention
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">Validation failed during implementation. Review issues and approve a one-time repair pass.</p>
                <div className="rounded border border-[#262626] bg-[#111111] p-3">
                  <ul className="list-disc space-y-1 pl-4 font-mono text-[11px] text-zinc-300">
                    {implementRun.validatorIssues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </div>
                <button
                  onClick={() => void handleRepair()}
                  disabled={loading.repair || isGlobalDisabled}
                  className="mt-1 w-full rounded bg-white py-2.5 text-[11px] font-bold tracking-wider text-black uppercase transition-colors hover:bg-zinc-200 disabled:opacity-50"
                >
                  {loading.repair ? 'Running Repair...' : 'Approve Repair Pass'}
                </button>
              </div>
            )}
          </div>

          <div className="grid shrink-0 grid-cols-2 gap-3 border-t border-[#1A1A1A] bg-[#000000] p-4">
            <button
              onClick={() => void handleResetSession()}
              disabled={loading.resetSession || isGlobalDisabled}
              className="flex items-center justify-center gap-2 rounded border border-[#262626] bg-[#111111] py-2.5 text-[11px] font-bold tracking-wider text-zinc-300 uppercase transition-colors hover:border-zinc-500 hover:bg-[#1A1A1A] disabled:opacity-50"
            >
              <RefreshCcw className="h-3.5 w-3.5" /> Session
            </button>
            <button
              onClick={() => void handleResetRepo()}
              disabled={loading.resetRepo || isGlobalDisabled}
              className="flex items-center justify-center gap-2 rounded border border-[#262626] bg-[#111111] py-2.5 text-[11px] font-bold tracking-wider text-rose-500 uppercase transition-colors hover:border-rose-500/50 hover:bg-[#1A1A1A] disabled:opacity-50"
            >
              <AlertTriangle className="h-3.5 w-3.5" /> Repo
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

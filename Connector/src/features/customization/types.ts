export type StatusLevel = 'info' | 'success' | 'warning' | 'error';
export type StatusState = { level: StatusLevel; text: string; details?: string };
export type ChatMessage = { role: 'user' | 'agent'; content: string; timestamp: string };
export type ConfirmationState = {
  confirmed_tenant_id?: string;
  has_unconfirmed_changes?: boolean;
  is_confirmed?: boolean;
};

export type AssetType =
  | 'logo_light'
  | 'logo_dark'
  | 'favicon'
  | 'og_image'
  | 'hero_illustration'
  | 'why_background'
  | 'activities_background'
  | 'curated_image';

export type AssetOption = { value: AssetType; label: string };
export type AssetPreview = {
  assetType: AssetType;
  fileName: string;
  previewUrl: string;
  uploadedAt: string;
  storedPath?: string;
  pending?: boolean;
};

export type PipelineMode = 'hybrid' | 'llm_only' | 'deterministic_only' | 'diagnostic';
export type ImplementRunState = {
  appTargets: string[];
  validatorIssues: string[];
  repairPassUsed: boolean;
  pipelineMode: PipelineMode;
};
export type LoadingState = {
  chat: boolean;
  manifest: boolean;
  confirm: boolean;
  implement: boolean;
  repair: boolean;
  upload: boolean;
  resetSession: boolean;
  resetRepo: boolean;
};

export type QualityReport = {
  status?: 'passed' | 'failed' | 'warning' | 'not_run';
  checks?: Array<{ name?: string; status?: string; detail?: string }>;
};
export type SnapshotFileChange = {
  status: 'added' | 'modified' | 'deleted';
  sha256: string | null;
  base_sha256: string | null;
};
export type SnapshotMetadata = {
  snapshot_id: string;
  tenant_id: string;
  snapshot_path: string;
  source_tree_hash?: string;
  source_file_count?: number;
  source_total_bytes?: number;
  changed_file_hashes?: Record<string, SnapshotFileChange>;
  created_at?: string;
  status?: 'immutable' | string;
};
export type CustomizationHandoffRecord = {
  project_id: string;
  tenant_id: string;
  snapshot_id: string;
  snapshot_path: string;
  source_tree_hash?: string;
  created_at: string;
  status: 'ready_for_security';
};
export type CustomizationPrResult = {
  attempted: boolean;
  success: boolean;
  pr_url: string | null;
  branch: string | null;
  reason?: string;
  error?: string;
  files_committed?: number;
};
export type PreviewPayload = {
  kind?: 'live_server' | 'static_file';
  status?: 'ready' | 'unavailable' | 'failed' | 'stopped';
  url?: string;
  detail?: string;
};
export type PreviewMetaResponse = {
  source?: 'base' | 'subspace';
  base_repo_path?: string;
  tenant_repo_path?: string | null;
  tenant_repo_exists?: boolean;
  preview_root_path?: string;
  preview_entry?: string | null;
  preview_kind?: 'live_server' | 'static_file';
  preview_url?: string | null;
  preview_status?: 'ready' | 'unavailable' | 'failed' | 'stopped' | 'starting';
  preview_error?: string | null;
  preview_detail?: string | null;
};

export type ChatResponse = {
  response?: string;
  manifest?: Record<string, unknown>;
  confirmation?: ConfirmationState;
  tenant_id?: string;
};
export type ManifestResponse = {
  tenant_id?: string;
  manifest?: Record<string, unknown>;
  confirmation?: ConfirmationState;
};
export type ConfirmResponse = {
  tenant_id: string;
  path: string;
  confirmation?: ConfirmationState;
};
export type ImplementResponse = {
  status?: 'implementation_complete' | 'no_changes';
  run_id?: string;
  pipeline_mode?: PipelineMode;
  tenant_id: string;
  app_targets?: string[];
  base_repo_path?: string;
  errors?: string[];
  modified_files?: string[];
  modified_file_diffs?: DiffEntry[];
  change_sources?: Array<{ file: string; source: string; operation?: string }>;
  quality_report?: QualityReport;
  preview?: PreviewPayload;
  warnings?: string[];
  plan_markdown_path?: string;
};
export type ResolveRepoPathResponse = { project_id: string; base_repo_path: string };
export type AssetsListResponse = {
  tenant_id: string;
  assets?: Record<string, { filename?: string }>;
};
export type UploadAssetResponse = {
  tenant_id: string;
  asset_type: AssetType;
  stored_path: string;
  confirmation?: ConfirmationState;
};

export type DiffEntry = {
  file: string;
  diff: string;
  truncated?: boolean;
  source?: string;
  operation?: string;
};
export type PreviewDevice = 'desktop' | 'tablet' | 'mobile';
export type WorkspaceTab = 'preview' | 'changes' | 'quality' | 'manifest' | 'assets' | 'settings';
export type WorkflowStage = 'draft' | 'review' | 'apply' | 'validate' | 'preview' | 'ready';
export type ByokProvider = 'Anthropic' | 'OpenAI' | 'OpenRouter' | 'Groq' | 'MiniMax';
export type ByokModel = { id: string; name: string };
export type ByokConfig = { provider: ByokProvider; modelId: string; apiKey: string };

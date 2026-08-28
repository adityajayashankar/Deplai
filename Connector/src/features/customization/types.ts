export type StatusLevel = 'info' | 'success' | 'warning' | 'error';
export type StatusState = { level: StatusLevel; text: string; details?: string };
export type ChatMessage = { role: 'user' | 'agent'; content: string; timestamp: string };
export type CustomizationAgent = 'workspace' | 'uiux_refactor';
export type UiuxAgentHealth = {
  available: boolean;
  ready?: boolean;
  detail?: string;
  workflow?: string;
};
export type UiuxStepRequirement = {
  step_id?: string;
  step_name?: string;
  requires_user_input?: boolean;
  requires_confirmation?: boolean;
  user_input_message?: string;
  user_input_schema?: Array<{ name: string; type?: string; required?: boolean }>;
  user_input?: Record<string, string>;
  confirmed?: boolean;
};
export type UiuxRefactorRunResponse = {
  run_id?: string;
  session_id?: string;
  status?: string;
  message?: string;
  content?: string;
  detail?: string;
  step_requirements?: UiuxStepRequirement[];
  requires_user_input?: boolean;
  user_input_message?: string;
  user_input_schema?: UiuxStepRequirement['user_input_schema'];
};
export type UiuxRefactorContinueRequest = {
  project_id: string;
  run_id: string;
  session_id: string;
  step_requirements?: UiuxStepRequirement[];
  user_input?: Record<string, string>;
  confirmed?: boolean;
};
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
export type CustomizationMode =
  | 'full_transformation'
  | 'targeted_screen'
  | 'design_system'
  | 'responsive'
  | 'accessibility';
export type StudioBottomTab = 'changes' | 'diff' | 'logs' | 'review';
export type FrontendRunStatus = 'queued' | 'running' | 'awaiting_review' | 'completed' | 'failed' | 'blocked';
export type FrontendRunEvent = { stage?: string; summary?: string; at?: string };
export type FrontendCheckpoint = {
  checkpoint_id: string;
  stage?: string;
  summary?: string;
  created_at?: string;
  files_changed?: number;
};
export type FrontendChangeset = {
  file: string;
  agent?: string;
  classification?: string;
  status?: string;
  diff?: string;
};
export type FrontendScreenPlan = {
  screen?: string;
  goal?: string;
  primary_action?: string;
  layout?: string;
  components?: string[];
};
export type FrontendTask = {
  id?: string;
  screen?: string;
  priority?: number;
  agent?: string;
  files_to_modify?: string[];
  acceptance_criteria?: string[];
};
export type FrontendQualityScores = {
  ui_quality?: number;
  consistency?: number;
  accessibility?: number;
  responsive_design?: number;
  navigation?: number;
  functional_safety?: number;
};
export type FrontendRunView = {
  run_id?: string;
  status?: FrontendRunStatus | string;
  workspace_session_id?: string;
  mode?: string;
  goal?: string;
  current_stage?: string;
  completed_nodes?: string[];
  interrupt_required?: boolean;
  interrupt_kind?: string;
  interrupt_reason?: string;
  interrupt_schema?: Array<{ name: string; type?: string; required?: boolean }>;
  repository_manifest?: Record<string, unknown>;
  frontend_manifest?: {
    stack_summary?: string;
    routes?: Array<{ path?: string; file?: string; purpose?: string }>;
    important_directories?: string[];
    frontend_files?: string[];
  };
  business_logic_boundary?: {
    protected_file_count?: number;
    allowed_file_count?: number;
    protected_directories?: string[];
  };
  product_ux_model?: Record<string, unknown>;
  design_system_plan?: {
    existing_system?: string;
    css_strategy?: string;
    reuse?: string[];
    improve?: string[];
    color?: Record<string, string>;
  };
  screen_plans?: FrontendScreenPlan[];
  tasks?: FrontendTask[];
  changesets?: FrontendChangeset[];
  checkpoints?: FrontendCheckpoint[];
  validation_results?: Array<Record<string, unknown>>;
  quality_scores?: FrontendQualityScores;
  final_review?: {
    gate_passed?: boolean;
    checks?: Record<string, string>;
    failed?: string[];
    strengths?: string[];
    remaining_issues?: string[];
    summary?: string;
    business_logic_protection?: string;
    files_changed?: string[];
  };
  github?: {
    branch?: string;
    commit_title?: string;
    pr_title?: string;
    state?: string;
  };
  preview_state?: Record<string, unknown>;
  warnings?: string[];
  errors?: Array<{ class?: string; detail?: string; stage?: string }>;
  events?: FrontendRunEvent[];
  gate_passed?: boolean;
  zip_available?: boolean;
};
export type FrontendFileListing = {
  files_changed?: Array<{ file: string; status?: string }>;
  files_added?: Array<{ file: string; status?: string }>;
  files_deleted?: Array<{ file: string; status?: string }>;
  tree?: Array<{ file: string; status?: string }>;
  changesets?: FrontendChangeset[];
};
export type EngineLlmSelection = {
  accessMode: 'platform' | 'byok' | 'auto';
  model: string;
  provider: string | null;
};

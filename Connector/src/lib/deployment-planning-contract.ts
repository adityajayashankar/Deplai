import { ArchitectureJson, validateArchitectureJson } from './architecture-contract';

export type PlanningConfidence = 'high' | 'medium' | 'low';

export interface ConflictItem {
  field: string;
  reason: string;
  signals?: string[];
}

export interface LowConfidenceItem {
  field: string;
  reason: string;
}

export interface RepositoryContextJson {
  document_kind: 'repository_context';
  workspace: string;
  project_name: string;
  project_type: 'local' | 'github';
  project_root: string;
  scan_timestamp: string;
  summary?: string;
  language?: Record<string, unknown>;
  frameworks?: Array<Record<string, unknown>>;
  build?: Record<string, unknown>;
  frontend?: Record<string, unknown>;
  data_stores?: Array<Record<string, unknown>>;
  processes?: Array<Record<string, unknown>>;
  environment_variables?: Record<string, unknown>;
  health?: Record<string, unknown>;
  monitoring?: Record<string, unknown>;
  infrastructure_hints?: Record<string, unknown>;
  conflicts?: ConflictItem[];
  low_confidence_items?: LowConfidenceItem[];
  readme_notes?: string | null;
}

export interface ArchitectureQuestionOption {
  value: string;
  label: string;
  description?: string | null;
}

export interface ArchitectureQuestion {
  id: string;
  category: string;
  question: string;
  required: boolean;
  default?: string | null;
  options?: ArchitectureQuestionOption[];
  affects?: string[];
}

export interface DeploymentProfileJson {
  document_kind: 'deployment_profile';
  profile_version: string;
  generated_at: string;
  workspace: string;
  project_name: string;
  provider: 'aws';
  application_type: string;
  environment: string;
  compute: Record<string, unknown>;
  networking: Record<string, unknown>;
  data_layer?: Array<Record<string, unknown>>;
  build_pipeline?: Record<string, unknown>;
  runtime_config?: Record<string, unknown>;
  dns_and_tls?: Record<string, unknown>;
  operational?: Record<string, unknown>;
  compliance?: Record<string, unknown>;
  warnings?: string[];
}

export interface ArchitectureReviewPayload {
  context_json: RepositoryContextJson;
  questions: ArchitectureQuestion[];
  defaults: Record<string, string>;
  conflicts: ConflictItem[];
  low_confidence_items: LowConfidenceItem[];
}

export interface PlanningValidationResult<T> {
  valid: boolean;
  errors: string[];
  normalized?: T;
}

export function buildDeploymentWorkspace(projectId: string, fallback?: string): string {
  const projectKey = String(projectId || '').trim();
  if (projectKey) {
    return `deploy-${projectKey}`;
  }
  const fallbackKey = String(fallback || '').trim();
  return fallbackKey || 'deploy-workspace';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isDeploymentProfileJson(value: unknown): value is DeploymentProfileJson {
  const root = asRecord(value);
  return !!root && String(root.document_kind || '').trim() === 'deployment_profile';
}

export function validateRepositoryContextJson(input: unknown): PlanningValidationResult<RepositoryContextJson> {
  const root = asRecord(input);
  if (!root) return { valid: false, errors: ['context_json must be an object'] };
  const errors: string[] = [];
  const documentKind = readString(root.document_kind);
  if (documentKind !== 'repository_context') errors.push('document_kind must be repository_context');
  const workspace = readString(root.workspace);
  if (!workspace) errors.push('workspace is required');
  const projectName = readString(root.project_name);
  if (!projectName) errors.push('project_name is required');
  const projectType = readString(root.project_type);
  if (projectType !== 'local' && projectType !== 'github') errors.push('project_type must be local or github');
  const projectRoot = readString(root.project_root);
  if (!projectRoot) errors.push('project_root is required');
  const scanTimestamp = readString(root.scan_timestamp);
  if (!scanTimestamp) errors.push('scan_timestamp is required');
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [], normalized: root as unknown as RepositoryContextJson };
}

export function validateDeploymentProfileJson(input: unknown): PlanningValidationResult<DeploymentProfileJson> {
  const root = asRecord(input);
  if (!root) return { valid: false, errors: ['deployment_profile must be an object'] };
  const errors: string[] = [];
  if (readString(root.document_kind) !== 'deployment_profile') errors.push('document_kind must be deployment_profile');
  if (!readString(root.workspace)) errors.push('workspace is required');
  if (!readString(root.project_name)) errors.push('project_name is required');
  if (readString(root.provider) !== 'aws') errors.push('provider must be aws');
  if (!readString(root.application_type)) errors.push('application_type is required');
  if (!readString(root.environment)) errors.push('environment is required');
  const compute = asRecord(root.compute);
  if (!compute) {
    errors.push('compute is required');
  } else {
    if (!readString(compute.strategy)) errors.push('compute.strategy is required');
    if (!Array.isArray(compute.services)) errors.push('compute.services must be an array');
  }
  if (!asRecord(root.networking)) errors.push('networking is required');
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [], normalized: root as unknown as DeploymentProfileJson };
}

export function validateDerivedArchitectureView(input: unknown): PlanningValidationResult<ArchitectureJson> {
  return validateArchitectureJson(input);
}

export function validateTerraformArchitectureInput(input: unknown): PlanningValidationResult<ArchitectureJson | DeploymentProfileJson> {
  const deployment = validateDeploymentProfileJson(input);
  if (deployment.valid && deployment.normalized) {
    return deployment as PlanningValidationResult<ArchitectureJson | DeploymentProfileJson>;
  }
  const architecture = validateArchitectureJson(input);
  if (architecture.valid && architecture.normalized) {
    return architecture as PlanningValidationResult<ArchitectureJson | DeploymentProfileJson>;
  }
  return {
    valid: false,
    errors: [...deployment.errors, ...architecture.errors],
  };
}

export type SecurityModuleId =
  | 'sast'
  | 'sca'
  | 'sbom'
  | 'secrets'
  | 'iac'
  | 'containers'
  | 'kubernetes'
  | 'cicd'
  | 'api'
  | 'dast'
  | 'cloud';

export type SecurityModuleStatus =
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED OUT'
  | 'SKIPPED';

export type FindingCategory = Exclude<SecurityModuleId, 'sbom'>;

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export type ResultsSurface =
  | 'overview'
  | 'findings'
  | 'secrets'
  | 'supply-chain'
  | 'infrastructure'
  | 'apis'
  | 'dynamic'
  | 'cloud'
  | 'risk'
  | 'assets'
  | 'attack-paths';

export interface SecurityModule {
  id: SecurityModuleId;
  status: SecurityModuleStatus;
  finding_count?: number;
  severity_breakdown?: Partial<Record<FindingSeverity, number>>;
  component_count?: number;
  reason?: string;
  error?: string;
}

export interface UnifiedFinding {
  id: string;
  category: FindingCategory | string;
  severity: string;
  title: string;
  asset: string;
  location: string;
  status?: string;
  scanner?: string;
  evidence_source?: string;
  risk?: number;
  metadata?: Record<string, unknown>;
}

export interface SecurityPosture {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

export interface SecurityRisk {
  score: number;
  level: FindingSeverity | string;
  reasons: string[];
}

export interface AttackPathHop {
  id: string;
  label: string;
  kind?: string;
  finding_id?: string;
}

export interface AttackPath {
  id: string;
  risk?: number;
  title?: string;
  hops: AttackPathHop[];
  finding_ids?: string[];
}

export interface FindingCorrelation {
  key: string;
  finding_ids: string[];
  categories: string[];
}

export interface SbomComponent {
  name: string;
  version?: string;
  type?: string;
  purl?: string | null;
}

export interface ScanResultsPayload {
  supply_chain?: unknown[];
  code_security?: unknown[];
  secrets?: unknown[];
  iac?: unknown[];
  containers?: unknown[];
  kubernetes?: unknown[];
  cicd?: unknown[];
  api?: unknown[];
  dast?: unknown[];
  cloud?: unknown[];
  sbom?: { component_count?: number; components?: SbomComponent[] };
  findings?: UnifiedFinding[];
  modules?: SecurityModule[];
  posture?: SecurityPosture;
  risk?: SecurityRisk;
  attack_paths?: AttackPath[];
  correlations?: FindingCorrelation[];
  completed_at?: string | null;
}

export const PIPELINE_MODULES: Array<{
  id: SecurityModuleId;
  label: string;
  summary: string;
  defaultEnabled: boolean;
  tabOnly?: boolean;
}> = [
  { id: 'sast', label: 'SAST', summary: 'Static code analysis', defaultEnabled: true },
  { id: 'sca', label: 'SCA', summary: 'Dependency vulnerabilities', defaultEnabled: true },
  { id: 'sbom', label: 'SBOM', summary: 'Software bill of materials', defaultEnabled: true },
  { id: 'secrets', label: 'Secrets', summary: 'Secret scanning', defaultEnabled: true },
  { id: 'iac', label: 'IaC', summary: 'Infrastructure as code', defaultEnabled: true },
  { id: 'containers', label: 'Containers', summary: 'Container configuration', defaultEnabled: true },
  { id: 'kubernetes', label: 'Kubernetes', summary: 'Workload and cluster manifests', defaultEnabled: true },
  { id: 'cicd', label: 'CI/CD', summary: 'Pipeline and workflow security', defaultEnabled: true },
  { id: 'api', label: 'API Security', summary: 'API specification analysis', defaultEnabled: true },
  { id: 'dast', label: 'DAST', summary: 'Dynamic application testing', defaultEnabled: false },
  { id: 'cloud', label: 'Cloud', summary: 'Live AWS account posture after deploy', defaultEnabled: false, tabOnly: true },
];

export const PHASE1_MODULES = PIPELINE_MODULES;

export const FINDING_CATEGORIES: Array<{ id: FindingCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'sast', label: 'SAST' },
  { id: 'sca', label: 'SCA' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'iac', label: 'IaC' },
  { id: 'containers', label: 'Containers' },
  { id: 'kubernetes', label: 'Kubernetes' },
  { id: 'cicd', label: 'CI/CD' },
  { id: 'api', label: 'APIs' },
  { id: 'dast', label: 'DAST' },
  { id: 'cloud', label: 'Cloud' },
];

export const RESULTS_SURFACES: Array<{ id: ResultsSurface; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'findings', label: 'Findings' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'supply-chain', label: 'Supply Chain' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'apis', label: 'APIs' },
  { id: 'dynamic', label: 'Dynamic Testing' },
  { id: 'risk', label: 'Risk' },
  { id: 'assets', label: 'Assets' },
  { id: 'attack-paths', label: 'Attack Paths' },
];

export const SAVED_FINDING_VIEWS: Array<{
  id: string;
  label: string;
  category: FindingCategory | 'all';
  severity: 'all' | FindingSeverity;
  query: string;
}> = [
  { id: 'all', label: 'All open', category: 'all', severity: 'all', query: '' },
  { id: 'critical', label: 'Critical', category: 'all', severity: 'critical', query: '' },
  { id: 'secrets', label: 'Secrets', category: 'secrets', severity: 'all', query: '' },
  { id: 'exploitable', label: 'Exploitable', category: 'all', severity: 'all', query: 'cve public unauthenticated' },
  { id: 'production-infra', label: 'Infrastructure', category: 'iac', severity: 'all', query: '' },
];

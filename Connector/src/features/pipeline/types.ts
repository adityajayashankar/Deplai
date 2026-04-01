export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Stage {
  id: number;
  key: string;
  label: string;
  group?: 'loop' | null;
  track?: 'shared' | 'security' | 'deployment';
  status: 'success' | 'active' | 'running' | 'pending';
  duration?: string;
  gate?: boolean;
}

export interface SastFinding {
  id: string;
  title: string;
  severity: Severity;
  count: number;
  file: string;
  line: number;
  desc: string;
}

export interface ScaFinding {
  cve: string;
  pkg: string;
  ver: string;
  fixed: string;
  severity: Severity;
  epss: string;
  desc: string;
}

export interface ArchNode {
  id: string;
  type: string;
  x: number;
  y: number;
  color: string;
}

export interface CostItem {
  service: string;
  type: string;
  monthly: number;
  note: string;
}

export interface FileNodeData {
  name: string;
  type: 'file' | 'dir';
  children?: FileNodeData[];
}

export interface Message {
  role: 'agent' | 'user';
  text: string;
}

export interface PipelineProject {
  id: string;
  name: string;
  type: 'local' | 'github';
  source?: string;
  owner?: string;
  repo?: string;
  installationId?: string;
}

export interface RuntimeScanOccurrence {
  filename: string;
  line_number: number;
}

export interface RuntimeCodeSecurityFinding {
  cwe_id: string;
  title: string;
  severity: Severity;
  count: number;
  occurrences?: RuntimeScanOccurrence[];
}

export interface RuntimeSupplyChainFinding {
  cve_id: string;
  name: string;
  version: string;
  fix_version: string | null;
  severity: Severity;
  epss_score: number | null;
}

export interface RuntimeScanResults {
  code_security?: RuntimeCodeSecurityFinding[];
  supply_chain?: RuntimeSupplyChainFinding[];
}

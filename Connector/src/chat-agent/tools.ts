// ── Tool registry: canonical definitions for all chat-agent tools ─────────────
import { ToolName } from './types';

export interface ToolDefinition {
  name: ToolName;
  description: string;
  required_params: string[];
  optional_params: string[];
  security_sensitive_params: string[];
  /** Max risk level of calling this tool without confirmation */
  risk_level: 'low' | 'medium' | 'high';
}

export const TOOL_REGISTRY: Record<ToolName, ToolDefinition> = {
  run_scan: {
    name: 'run_scan',
    description: 'Trigger a security scan (SAST/SCA/all) on a connected project.',
    required_params: ['project_id', 'project_name', 'scan_type'],
    optional_params: [],
    security_sensitive_params: [],
    risk_level: 'medium',
  },
  navigate_to_results: {
    name: 'navigate_to_results',
    description: 'Push the user to the security-analysis report page for a project.',
    required_params: ['project_id'],
    optional_params: ['project_name'],
    security_sensitive_params: [],
    risk_level: 'low',
  },
  start_remediation: {
    name: 'start_remediation',
    description: 'Kick off the AI-assisted auto-remediation pipeline for a project.',
    required_params: ['project_id', 'project_name'],
    optional_params: ['github_token'],
    security_sensitive_params: ['github_token'],
    risk_level: 'high',
  },
  plan_deployment: {
    name: 'plan_deployment',
    description: 'Launch the repository analyzer and open the deployment planning wizard for a project.',
    required_params: ['project_id', 'project_name'],
    optional_params: [],
    security_sensitive_params: [],
    risk_level: 'low',
  },
  create_github_repo: {
    name: 'create_github_repo',
    description: 'Create a new GitHub repository and push generated files to it.',
    required_params: ['repo_name', 'files'],
    optional_params: ['description', 'private'],
    security_sensitive_params: ['github_pat'],
    risk_level: 'high',
  },
  ask_for_github_pat: {
    name: 'ask_for_github_pat',
    description: 'Prompt the user to provide their GitHub personal access token.',
    required_params: [],
    optional_params: [],
    security_sensitive_params: [],
    risk_level: 'low',
  },
  generate_code: {
    name: 'generate_code',
    description: 'Generate source code files based on a specification.',
    required_params: ['spec'],
    optional_params: ['language', 'framework'],
    security_sensitive_params: [],
    risk_level: 'low',
  },
};

/** Returns true when all required params are present in the given payload */
export function hasRequiredParams(
  toolName: ToolName,
  params: Record<string, unknown>,
): { ok: boolean; missing: string[] } {
  const def = TOOL_REGISTRY[toolName];
  if (!def) return { ok: false, missing: [] };
  const missing = def.required_params.filter(
    p => params[p] === undefined || params[p] === null || params[p] === '',
  );
  return { ok: missing.length === 0, missing };
}

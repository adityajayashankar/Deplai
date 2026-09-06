export type DeploymentStatusTarget = 'iac_pipeline' | 'runtime_apply';

/**
 * Runtime Terraform applies are keyed by project in Agentic. IaC generation
 * runs are keyed by run_id, so a runtime run_id must never switch a status
 * poll to the IaC endpoint.
 */
export function resolveDeploymentStatusTarget(input: {
  runId?: string | null;
  mode?: string | null;
}): DeploymentStatusTarget {
  if (String(input.mode || '').trim().toLowerCase() === 'runtime_apply') {
    return 'runtime_apply';
  }
  return String(input.runId || '').trim() ? 'iac_pipeline' : 'runtime_apply';
}

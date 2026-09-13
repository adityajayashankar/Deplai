import { loadEnvConfig } from '@next/env';
import { readFileSync } from 'node:fs';

// Operator-only import of run identities exported from the trusted run store.
// Does not import source, credentials, logs, or model responses.
async function main() {
  loadEnvConfig(process.cwd());
  const { createSession, findLatestSession } = await import('../src/lib/sessions/store');
  const { query } = await import('../src/lib/db');
  const { requireOrganizationPermission } = await import('../src/lib/organizations/store');
  const runs = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  let linked = 0;
  for (const run of runs) {
    if (!run.run_id || !run.user_id || !run.organization_id || !run.project_id) continue;
    const existing = await findLatestSession({userId:run.user_id, projectId:run.project_id, service:'security_agent', externalId:run.run_id});
    if (existing) continue;
    const projects = await query<Array<{id:string}>>('SELECT id FROM projects WHERE id = ? AND user_id = ? AND organization_id = ?', [run.project_id, run.user_id, run.organization_id]);
    if (!projects.length) {
      const repos = await query<Array<{id:string}>>('SELECT r.id FROM github_repositories r JOIN github_installations i ON i.id = r.installation_id WHERE r.id = ? AND i.user_id = ?', [run.project_id, run.user_id]);
      if (!repos.length) continue;
    }
    try {
      await requireOrganizationPermission({userId:run.user_id,organizationId:run.organization_id,action:'project.read',resource:{scopeType:'PROJECT',scopeId:run.project_id,projectId:run.project_id}});
    } catch { continue; }
    const session = await createSession({userId:run.user_id,organizationId:run.organization_id,projectId:run.project_id,
      service:'security_agent',title:`Remediation - ${run.run_id.slice(0,8)}`,externalId:run.run_id,
      status:run.status==='completed'?'completed':run.status==='failed'||run.status==='cancelled'?'failed':'needs_review',
      metadata:{remediation_run_id:run.run_id,organization_id:run.organization_id,retention_days_minimum:30}});
    await query('UPDATE workspace_sessions SET started_at = ?, completed_at = ? WHERE id = ?', [new Date(run.created_at), ['completed','failed','cancelled'].includes(run.status)?new Date(run.updated_at):null, session.id]);
    linked++;
  }
  console.log(`Linked ${linked} saved remediation runs. No inference or billing actions.`);
}
main().then(()=>process.exit(0)).catch((error)=>{console.error('Session backfill failed:', String(error?.message || error?.name).replace(/mysql:\/\/[^ ]+/g, '[redacted]'));process.exit(1);});



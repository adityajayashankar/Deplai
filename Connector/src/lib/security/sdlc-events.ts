import { createHash } from 'node:crypto';
import { query, withNamedLock } from '@/lib/db';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { githubService } from '@/lib/github';
import { listAssets, resolveAuthorizedAsset, createScanRecord } from '@/lib/dast/store';
import { encryptSecret, decryptSecret } from '@/lib/ai-platform/crypto';
import { getOrganizationSubscription } from '@/lib/billing/credits';
import { planIncludesFeature } from '@/lib/billing/plan-features';
import { isBillingEnforced } from '@/lib/ai-platform/subscription-access';

export type SecurityTrigger = 'push' | 'pull_request' | 'build' | 'predeploy' | 'deployment' | 'schedule';
const modules: Record<SecurityTrigger, string[]> = {
  push: ['secrets', 'sast'], pull_request: ['secrets', 'sast'], build: ['sbom', 'sca', 'containers'],
  predeploy: ['iac', 'kubernetes', 'cicd', 'api'], deployment: ['dast', 'cloud'], schedule: ['cloud'],
};

export function modulesForAutomaticSecurityPlan(
  trigger: SecurityTrigger,
  hasSecurityAutomation: boolean,
): string[] | null {
  if (hasSecurityAutomation) return modules[trigger];
  // Free includes an automated basic source check when a revision changes.
  return trigger === 'push' || trigger === 'pull_request' ? ['sast'] : null;
}
let ready: Promise<void> | undefined;
async function schema() {
  return ready ??= query(`CREATE TABLE IF NOT EXISTS security_sdlc_events (
    id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(80) NOT NULL, trigger_name VARCHAR(32) NOT NULL,
    revision VARCHAR(64) NULL, status VARCHAR(32) NOT NULL DEFAULT 'queued',
    run_id VARCHAR(80) NULL, error_text TEXT NULL, artifacts_encrypted MEDIUMTEXT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).then(() => undefined).catch((error) => { ready = undefined; throw error; });
}
export async function enqueueSecurityEvent(projectId: string, trigger: SecurityTrigger, key: string, revision?: string, files?: Array<{ path: string; content: string }>) {
  if (process.env.SECURITY_SDLC_AUTOMATIC !== 'true') return { enabled: false };
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(projectId)) throw new Error('Invalid security project');
  if (revision && !/^[a-f0-9]{40,64}$/i.test(revision)) throw new Error('Invalid source revision');
  await schema();
  const id = createHash('sha256').update(JSON.stringify([projectId, trigger, key])).digest('hex');
  if (files?.length && !process.env.AI_CREDENTIAL_ENCRYPTION_KEY && !process.env.SESSION_SECRET) throw new Error('Artifact encryption key is required');
  await query('INSERT IGNORE INTO security_sdlc_events (id, project_id, trigger_name, revision, artifacts_encrypted) VALUES (?, ?, ?, ?, ?)',
    [id, projectId, trigger, revision || null, files?.length ? encryptSecret(JSON.stringify(files)) : null]);
  return { enabled: true, id };
}
export async function enqueueGithubSecurityEvent(repositoryId: number, trigger: SecurityTrigger, key: string, revision?: string) {
  if (process.env.SECURITY_SDLC_AUTOMATIC !== 'true') return;
  const rows = await query<Array<{ id: string }>>('SELECT id FROM github_repositories WHERE github_repo_id = ?', [repositoryId]);
  for (const row of rows) await enqueueSecurityEvent(row.id, trigger, key, revision);
}
type Event = { id: string; project_id: string; trigger_name: SecurityTrigger; revision: string | null; run_id: string | null; status: string; artifacts_encrypted: string | null };
type Repo = { full_name: string; installation_id: string; user_id: string; organization_id: string | null };
async function repoFor(projectId: string) {
  const rows = await query<Repo[]>(`SELECT r.full_name, r.installation_id, i.user_id, i.organization_id FROM github_repositories r
    JOIN github_installations i ON i.id = r.installation_id WHERE r.id = ? AND i.suspended_at IS NULL`, [projectId]);
  if (!rows[0]) throw new Error('No authorized GitHub repository is available for this automatic check');
  return rows[0];
}
export async function dispatchSecurityEvents() {
  if (process.env.SECURITY_SDLC_AUTOMATIC !== 'true') return { enabled: false };
  await schema();
  return withNamedLock('security-sdlc-dispatch', 1, async () => {
    const day = new Date().toISOString().slice(0, 10);
    const projects = await query<Array<{ project_id: string }>>(`SELECT DISTINCT project_id FROM security_sdlc_events WHERE trigger_name = 'deployment'`);
    for (const project of projects) await enqueueSecurityEvent(project.project_id, 'schedule', day);
    const events = await query<Event[]>(`SELECT * FROM security_sdlc_events WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT 10`);
    for (const event of events) {
      try {
        const repo = await repoFor(event.project_id);
        const token = await githubService.getInstallationToken(repo.installation_id);
        if (event.status === 'running') {
          const response = await fetch(`${AGENTIC_URL}/api/scan/status/${event.project_id}`, { headers: agenticHeaders(), signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error(`Security status HTTP ${response.status}`);
          const state = await response.json();
          if (state.status === 'running') continue;
          if (state.run_id && state.run_id !== event.run_id) throw new Error('Security result belongs to a different run');
          if (event.revision) {
            const publication = await fetch(`https://api.github.com/repos/${repo.full_name}/check-runs`, {
              method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: 'DeplAI security (advisory)', head_sha: event.revision, status: 'completed', conclusion: 'neutral',
                output: { title: `Security scan: ${state.status}`, summary: `Run ${event.run_id}. Advisory only. Review tool coverage and findings in DeplAI.` } }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!publication.ok) throw new Error(`GitHub check publication failed (${publication.status}); check checks:write permission`);
          }
          await query("UPDATE security_sdlc_events SET status = 'completed' WHERE id = ?", [event.id]);
          continue;
        }
        const subscription = repo.organization_id
          ? await getOrganizationSubscription(repo.organization_id).catch(() => null)
          : null;
        const hasSecurityAutomation = !isBillingEnforced()
          || planIncludesFeature(subscription?.planId || 'free', 'security_automation');
        const enabledModules = modulesForAutomaticSecurityPlan(event.trigger_name, hasSecurityAutomation);
        if (!enabledModules) {
          await query(
            "UPDATE security_sdlc_events SET status = 'not_applicable', error_text = ? WHERE id = ?",
            ['Starter plan required for this automatic security stage.', event.id],
          );
          continue;
        }
        const existing = await fetch(`${AGENTIC_URL}/api/scan/status/${event.project_id}`, { headers: agenticHeaders(), signal: AbortSignal.timeout(10_000) });
        if (existing.ok && (await existing.json()).status === 'running') continue;
        const payload: Record<string, unknown> = { project_id: event.project_id, project_name: repo.full_name.split('/')[1],
          project_type: 'github', user_id: repo.user_id, repository_url: `https://github.com/${repo.full_name}`, github_token: token,
          enabled_modules: enabledModules, trigger: event.trigger_name, source_revision: event.revision };
        if (event.artifacts_encrypted) payload.generated_files = JSON.parse(decryptSecret(event.artifacts_encrypted));
        if (event.trigger_name === 'deployment') {
          const asset = (await listAssets(repo.user_id, event.project_id)).find((item) => item.status === 'VERIFIED');
          if (asset) {
            const resolved = await resolveAuthorizedAsset({ userId: repo.user_id, projectId: event.project_id, assetId: asset.id });
            Object.assign(payload, { dast_target_url: resolved.targetUrl, dast_asset_id: asset.id, dast_authorization: resolved.grant,
              dast_scan_profile: 'BASELINE', dast_scan_intent: 'PASSIVE',
              dast_scan_id: await createScanRecord({ userId: repo.user_id, projectId: event.project_id, asset, targetUrl: resolved.targetUrl, profile: 'BASELINE', intent: 'PASSIVE' }) });
          }
        }
        const started = await fetch(`${AGENTIC_URL}/api/scan/start`, { method: 'POST', headers: agenticHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
        if (!started.ok) throw new Error(`Automatic scan could not start (${started.status})`);
        const result = await started.json();
        await query("UPDATE security_sdlc_events SET status = 'running', run_id = ? WHERE id = ?", [result.data.run_id, event.id]);
      } catch (error) {
        await query("UPDATE security_sdlc_events SET status = 'failed', error_text = ? WHERE id = ?", [error instanceof Error ? error.message : 'Security dispatch failed', event.id]);
      }
    }
    return { enabled: true, processed: events.length };
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership, verifyRepositoryOwnership } from '@/lib/auth';
import { githubService } from '@/lib/github';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';
import { query } from '@/lib/db';
import {
  resolveCustomizationSnapshot,
  SnapshotResolutionError,
} from '@/lib/customization-snapshot';
import { denyUnlessPlanFeature } from '@/lib/billing/plan-access-guard';
import { resolveAgenticBillingContext } from '@/lib/agentic-context';

interface ScanValidateBody {
  project_id?: string;
  project_name?: string;
  project_type?: 'local' | 'github';
  scan_type?: 'all' | 'sast' | 'sca';
  enabled_modules?: string[];
  dast_target_url?: string;
  dast_asset_id?: string;
  dast_scan_profile?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  aws_region?: string;
  owner?: string;
  repo?: string;
  customization_snapshot_id?: string;
  tenant_id?: string;
}

type ScanValidatePayload = {
  project_id: string;
  project_name: string;
  project_type: 'local' | 'github';
  scan_type: 'all' | 'sast' | 'sca';
  enabled_modules?: string[];
  dast_target_url?: string;
  dast_asset_id?: string;
  dast_scan_id?: string;
  dast_scan_profile?: string;
  dast_scan_intent?: string;
  dast_authorization?: Record<string, unknown>;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  aws_region?: string;
  user_id: string;
  organization_id: string;
  github_token?: string;
  repository_url?: string;
  source_override?: {
    kind: 'customization_snapshot';
    project_id: string;
    tenant_id: string;
    snapshot_id: string;
    source_root: string;
    source_tree_hash: string;
  };
};

interface ProjectRow {
  id: string;
  project_type: 'local' | 'github';
  user_id: string;
  repo_full_name: string | null;
  installation_uuid: string | null;
  suspended_at: string | null;
}

interface GitHubRepoRow {
  id: string;
  full_name: string;
  installation_uuid: string;
  user_id: string | null;
  suspended_at: string | null;
}

function formatBackendError(errorBody: { error?: unknown; detail?: unknown } | null): string {
  const error = errorBody?.error;
  if (typeof error === 'string' && error.trim()) return error;
  const detail = errorBody?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'msg' in item) {
          return String((item as { msg?: unknown }).msg || '');
        }
        return '';
      })
      .filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  return 'Backend scan validation failed';
}

function isBackendConnectivityError(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code
    || (error as { cause?: { code?: string } })?.cause?.code;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  return code === 'ECONNREFUSED'
    || code === 'ENOTFOUND'
    || code === 'EHOSTUNREACH'
    || code === 'ETIMEDOUT'
    || code === 'UND_ERR_SOCKET'
    || message.includes('other side closed')
    || message.includes('unable to connect to the remote server');
}

function isBackendTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  return (error instanceof Error && error.name === 'TimeoutError') || message.includes('aborted due to timeout') || message.includes('timed out');
}

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await request.json().catch(() => ({})) as ScanValidateBody;
    const billing = await resolveAgenticBillingContext({ request, user });
    const resolvedProjectId = String(body.project_id || '').trim();
    const resolvedProjectName = String(body.project_name || '').trim();
    const resolvedProjectType: 'local' | 'github' = body.project_type === 'github' ? 'github' : 'local';
    const resolvedScanType: 'all' | 'sast' | 'sca' =
      body.scan_type === 'sast' || body.scan_type === 'sca' ? body.scan_type : 'all';
    const customizationSnapshotId = String(body.customization_snapshot_id || '').trim();
    const tenantId = String(body.tenant_id || '').trim();

    if (!resolvedProjectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }
    if (!resolvedProjectName) {
      return NextResponse.json({ error: 'project_name is required' }, { status: 400 });
    }
    if (Boolean(customizationSnapshotId) !== Boolean(tenantId)) {
      return NextResponse.json(
        { error: 'customization_snapshot_id and tenant_id must be provided together' },
        { status: 400 },
      );
    }

    const backendPayload: ScanValidatePayload = {
      project_id: resolvedProjectId,
      project_name: resolvedProjectName,
      project_type: resolvedProjectType,
      scan_type: resolvedScanType,
      ...billing.fields,
    };
    if (Array.isArray(body.enabled_modules) && body.enabled_modules.length > 0) {
      backendPayload.enabled_modules = body.enabled_modules.map((item) => String(item));
    }
    const requestedModules = Array.isArray(body.enabled_modules)
      ? body.enabled_modules.map((item) => String(item).trim().toLowerCase())
      : [];
    // Free includes a focused source scan. The full SDLC scan, dependency
    // scanning, and every non-SAST module are Starter capabilities.
    const isBasicSecurityScan = resolvedScanType === 'sast'
      && requestedModules.every((module) => module === 'sast');
    if (!isBasicSecurityScan) {
      const denied = await denyUnlessPlanFeature(request, user, 'security_automation');
      if (denied) return denied;
    }
    const scanWarnings: Array<{ module: string; code: string; message: string }> = [];
    const dastTarget = String(body.dast_target_url || '').trim();
    const dastAssetId = String(body.dast_asset_id || '').trim();
    const dastOnly = requestedModules.length === 1 && requestedModules[0] === 'dast';
    if (dastTarget || dastAssetId || dastOnly) {
      try {
        const { createScanRecord, resolveAuthorizedAsset } = await import('@/lib/dast/store');
        const resolved = await resolveAuthorizedAsset({
          userId: String(user.id),
          projectId: resolvedProjectId,
          assetId: dastAssetId || undefined,
          targetUrl: dastTarget || undefined,
        });
        const profile = String(body.dast_scan_profile || 'BASELINE').toUpperCase();
        const intent = profile === 'FULL' ? 'ACTIVE' : profile === 'API' ? 'API_ACTIVE' : 'PASSIVE';
        const scanId = await createScanRecord({
          userId: String(user.id),
          projectId: resolvedProjectId,
          asset: resolved.asset,
          targetUrl: resolved.targetUrl,
          profile: profile === 'FULL' || profile === 'API' ? profile : 'BASELINE',
          intent,
        });
        backendPayload.dast_target_url = resolved.targetUrl;
        backendPayload.dast_asset_id = resolved.asset.id;
        backendPayload.dast_scan_id = scanId;
        backendPayload.dast_scan_profile = profile === 'FULL' || profile === 'API' ? profile : 'BASELINE';
        backendPayload.dast_scan_intent = intent;
        backendPayload.dast_authorization = resolved.grant;
      } catch (dastError) {
        const code = (dastError as { code?: string }).code || 'DAST_TARGET_NOT_AUTHORIZED';
        const status = Number((dastError as { status?: number }).status || 403);
        const message = dastError instanceof Error
          ? dastError.message
          : 'This target is not associated with the selected project and ownership has not been verified.';
        if (dastOnly) {
          return NextResponse.json({ error: message, code }, { status });
        }
        scanWarnings.push({ module: 'dast', code, message });
        if (Array.isArray(backendPayload.enabled_modules)) {
          backendPayload.enabled_modules = backendPayload.enabled_modules.filter(
            (module) => String(module).trim().toLowerCase() !== 'dast',
          );
        }
      }
    }
    if (requestedModules.includes('cloud')) {
      backendPayload.aws_access_key_id = String(body.aws_access_key_id || '').trim() || undefined;
      backendPayload.aws_secret_access_key = String(body.aws_secret_access_key || '').trim() || undefined;
      backendPayload.aws_session_token = String(body.aws_session_token || '').trim() || undefined;
      backendPayload.aws_region = String(body.aws_region || '').trim() || undefined;
    }

    if (customizationSnapshotId && tenantId) {
      const ownership = await verifyProjectOwnership(user.id, resolvedProjectId);
      if ('error' in ownership) {
        return NextResponse.json({ error: 'Project not found or access denied' }, { status: 403 });
      }
      try {
        const snapshot = await resolveCustomizationSnapshot({
          userId: String(user.id),
          projectId: resolvedProjectId,
          tenantId,
          snapshotId: customizationSnapshotId,
        });
        backendPayload.source_override = {
          kind: snapshot.kind,
          project_id: snapshot.project_id,
          tenant_id: snapshot.tenant_id,
          snapshot_id: snapshot.snapshot_id,
          source_root: snapshot.agentic_source_root,
          source_tree_hash: snapshot.source_tree_hash,
        };
      } catch (snapshotError) {
        const status = snapshotError instanceof SnapshotResolutionError ? snapshotError.status : 502;
        return NextResponse.json(
          { error: snapshotError instanceof Error ? snapshotError.message : 'Snapshot validation failed.' },
          { status },
        );
      }
    }

    if (resolvedProjectType === 'github') {
      const resolvedOwner = String(body.owner || '').trim();
      const resolvedRepo = String(body.repo || '').trim();

      let repoFullName: string | null = null;
      let installationUuid: string | null = null;
      let suspended = false;

      const projectRows = await query<ProjectRow[]>(
        `SELECT
          p.id,
          p.project_type,
          p.user_id,
          gr.full_name AS repo_full_name,
          gi.id AS installation_uuid,
          gi.suspended_at
        FROM projects p
        LEFT JOIN github_repositories gr ON p.repository_id = gr.id
        LEFT JOIN github_installations gi ON gr.installation_id = gi.id
        WHERE p.id = ?`,
        [resolvedProjectId],
      );
      const project = projectRows[0];

      if (project) {
        if (project.user_id !== user.id) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        if (project.project_type !== 'github') {
          return NextResponse.json({ error: 'Selected project is not a GitHub repository' }, { status: 400 });
        }
        repoFullName = project.repo_full_name;
        installationUuid = project.installation_uuid;
        suspended = Boolean(project.suspended_at);
      } else {
        const ghRepoRows = await query<GitHubRepoRow[]>(
          `SELECT
            r.id,
            r.full_name,
            i.id AS installation_uuid,
            i.user_id,
            i.suspended_at
          FROM github_repositories r
          JOIN github_installations i ON i.id = r.installation_id
          WHERE r.id = ?`,
          [resolvedProjectId],
        );
        const ghRepo = ghRepoRows[0];
        if (ghRepo) {
          // Installations can have NULL user_id on legacy rows; fallback to project ownership check.
          if (ghRepo.user_id && ghRepo.user_id !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
          }
          if (!ghRepo.user_id) {
            const ownershipByProject = await verifyProjectOwnership(user.id, resolvedProjectId);
            if ('error' in ownershipByProject) {
              return NextResponse.json({ error: 'Repository not found or access denied' }, { status: 403 });
            }
          }
          repoFullName = ghRepo.full_name;
          installationUuid = ghRepo.installation_uuid;
          suspended = Boolean(ghRepo.suspended_at);
        }
      }

      if ((!repoFullName || !installationUuid) && resolvedOwner && resolvedRepo) {
        const ownership = await verifyRepositoryOwnership(user.id, resolvedOwner, resolvedRepo);
        if (ownership) {
          repoFullName = `${resolvedOwner}/${resolvedRepo}`;
          installationUuid = ownership.installationId;
          suspended = ownership.suspended;
        }
      }

      if (!repoFullName || !installationUuid) {
        return NextResponse.json({ error: 'Repository not found or access denied' }, { status: 403 });
      }
      if (suspended) {
        return NextResponse.json(
          { error: 'GitHub App installation is suspended. Unsuspend before scanning.' },
          { status: 403 },
        );
      }

      try {
        const token = await githubService.getInstallationToken(installationUuid);
        backendPayload.github_token = token;
        backendPayload.repository_url = `https://github.com/${repoFullName}`;
      } catch (tokenError: unknown) {
        console.error('Failed to get GitHub token:', tokenError);
        return NextResponse.json(
          { error: 'Failed to authenticate with GitHub. The installation may be suspended or removed.' },
          { status: 403 },
        );
      }
    }

    const response = await fetch(`${AGENTIC_URL}/api/scan/start`, {
      method: 'POST',
      headers: agenticHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(backendPayload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json({
          error: 'The running scanner backend does not expose the scan-start endpoint. Restart or update the Agentic Layer service, then retry the scan.',
          code: 'SCAN_BACKEND_VERSION_MISMATCH',
        }, { status: 503 });
      }
      const raw = await response.text();
      let errorBody: { error?: unknown; detail?: unknown } | null = null;
      try {
        errorBody = raw ? JSON.parse(raw) : null;
      } catch {
        errorBody = { error: `Agentic Layer returned HTTP ${response.status}` };
      }
      console.error('Scan validate backend error:', response.status, errorBody);
      return NextResponse.json(
        { error: formatBackendError(errorBody) },
        { status: response.status },
      );
    }

    const data = await response.json();
    if (scanWarnings.length > 0) {
      data.warnings = [...(Array.isArray(data.warnings) ? data.warnings : []), ...scanWarnings];
    }
    return NextResponse.json(data);
  } catch (routeError: unknown) {
    if (isBackendTimeoutError(routeError)) {
      return NextResponse.json(
        { error: `Agentic Layer timed out at ${AGENTIC_URL}. The backend is likely paused or hung.` },
        { status: 504 },
      );
    }
    if (isBackendConnectivityError(routeError)) {
      return NextResponse.json(
        { error: `Agentic Layer is unreachable at ${AGENTIC_URL}. Start the service and retry.` },
        { status: 502 },
      );
    }
    console.error('Scan validation error:', routeError);
    return NextResponse.json({ error: 'Failed to validate scan' }, { status: 500 });
  }
}

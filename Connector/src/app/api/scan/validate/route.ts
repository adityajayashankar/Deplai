import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyRepositoryOwnership } from '@/lib/auth';
import { githubService } from '@/lib/github';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

interface ScanValidateBody {
  project_id?: string;
  project_name?: string;
  project_type?: 'local' | 'github';
  scan_type?: 'all' | 'sast' | 'sca';
  owner?: string;
  repo?: string;
}

type ScanValidatePayload = {
  project_id: string;
  project_name: string;
  project_type: 'local' | 'github';
  scan_type: 'all' | 'sast' | 'sca';
  user_id: string;
  github_token?: string;
  repository_url?: string;
};

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await request.json().catch(() => ({})) as ScanValidateBody;
    const resolvedProjectId = String(body.project_id || '').trim();
    const resolvedProjectName = String(body.project_name || '').trim();
    const resolvedProjectType: 'local' | 'github' = body.project_type === 'github' ? 'github' : 'local';
    const resolvedScanType: 'all' | 'sast' | 'sca' =
      body.scan_type === 'sast' || body.scan_type === 'sca' ? body.scan_type : 'all';

    if (!resolvedProjectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }
    if (!resolvedProjectName) {
      return NextResponse.json({ error: 'project_name is required' }, { status: 400 });
    }

    const backendPayload: ScanValidatePayload = {
      project_id: resolvedProjectId,
      project_name: resolvedProjectName,
      project_type: resolvedProjectType,
      scan_type: resolvedScanType,
      user_id: String(user.id),
    };

    if (resolvedProjectType === 'github') {
      const resolvedOwner = String(body.owner || '').trim();
      const resolvedRepo = String(body.repo || '').trim();
      if (!resolvedOwner || !resolvedRepo) {
        return NextResponse.json(
          { error: 'owner and repo are required for GitHub scans' },
          { status: 400 },
        );
      }

      const ownership = await verifyRepositoryOwnership(user.id, resolvedOwner, resolvedRepo);
      if (!ownership) {
        return NextResponse.json({ error: 'Repository not found or access denied' }, { status: 403 });
      }
      if (ownership.suspended) {
        return NextResponse.json(
          { error: 'GitHub App installation is suspended. Unsuspend before scanning.' },
          { status: 403 },
        );
      }

      try {
        // Always use installation metadata from the database.
        const token = await githubService.getInstallationToken(ownership.installationId);
        backendPayload.github_token = token;
        backendPayload.repository_url = `https://github.com/${resolvedOwner}/${resolvedRepo}`;
      } catch (tokenError: unknown) {
        console.error('Failed to get GitHub token:', tokenError);
        return NextResponse.json(
          { error: 'Failed to authenticate with GitHub. The installation may be suspended or removed.' },
          { status: 403 },
        );
      }
    }

    const response = await fetch(`${AGENTIC_URL}/api/scan/validate`, {
      method: 'POST',
      headers: agenticHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(backendPayload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ error: 'Backend request failed' }));
      console.error('Scan validate backend error:', response.status, errorBody);
      return NextResponse.json(
        { error: errorBody?.error || errorBody?.detail || 'Backend scan validation failed' },
        { status: response.status },
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (routeError: unknown) {
    console.error('Scan validation error:', routeError);
    return NextResponse.json({ error: 'Failed to validate scan' }, { status: 500 });
  }
}

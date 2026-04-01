import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyInstallationOwnership } from '@/lib/auth';
import { githubService } from '@/lib/github';

export async function GET(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const { searchParams } = new URL(request.url);
    const installationId = String(searchParams.get('installation_id') || '').trim();
    const owner = String(searchParams.get('owner') || '').trim();
    const repo = String(searchParams.get('repo') || '').trim();

    if (!installationId || !owner || !repo) {
      return NextResponse.json(
        { error: 'installation_id, owner, and repo are required' },
        { status: 400 },
      );
    }

    const hasAccess = await verifyInstallationOwnership(user.id, installationId);
    if (!hasAccess) {
      return NextResponse.json(
        { error: 'Forbidden: You do not own this installation' },
        { status: 403 },
      );
    }

    const octokit = await githubService.getInstallationClient(installationId);
    const branches = await octokit.paginate(octokit.repos.listBranches, {
      owner,
      repo,
      per_page: 100,
    });

    return NextResponse.json({
      branches: branches
        .map((branch) => String(branch.name || '').trim())
        .filter(Boolean),
    });
  } catch (error) {
    console.error('Error fetching repository branches:', error);
    return NextResponse.json(
      { error: 'Failed to fetch repository branches' },
      { status: 500 },
    );
  }
}

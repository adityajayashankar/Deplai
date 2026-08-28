import { NextRequest, NextResponse } from 'next/server';
import { githubService } from '@/lib/github';
import { requireAuth, verifyRepositoryOwnership } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const { searchParams } = new URL(request.url);
    const owner = searchParams.get('owner');
    const repo = searchParams.get('repo');
    const path = searchParams.get('path') || '';

    if (!owner || !repo) {
      return NextResponse.json(
        { error: 'owner and repo required' },
        { status: 400 }
      );
    }

    const repoAccess = await verifyRepositoryOwnership(user.id, owner, repo);
    if (!repoAccess) {
      return NextResponse.json(
        { error: 'Forbidden: You do not own this repository' },
        { status: 403 }
      );
    }

    if (repoAccess.suspended) {
      return NextResponse.json(
        { error: 'GitHub App installation is suspended. Unsuspend it from your GitHub settings to restore access.', suspended: true },
        { status: 403 }
      );
    }

    const contents = await githubService.getDirectoryContents(
      repoAccess.installationId,
      owner,
      repo,
      path
    );

    return NextResponse.json({ contents });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch contents';
    console.error('Error fetching contents:', error);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

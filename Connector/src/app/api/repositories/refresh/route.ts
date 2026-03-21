import { NextRequest, NextResponse } from 'next/server';
import { githubService } from '@/lib/github';
import { requireAuth, verifyRepositoryOwnership } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const { owner, repo } = await request.json();

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

    await githubService.forceRefresh(
      repoAccess.installationId,
      owner,
      repo
    );

    return NextResponse.json({ 
      success: true,
      message: 'Repository refreshed successfully' 
    });
  } catch (error: any) {
    console.error('Error refreshing repository:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to refresh repository' },
      { status: 500 }
    );
  }
}
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyLocalProjectAccess } from '@/lib/auth';
import { getDirectoryContents } from '@/lib/local-projects';

export async function GET(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    const path = searchParams.get('path') || '';

    if (!projectId) {
      return NextResponse.json(
        { error: 'project_id required' },
        { status: 400 }
      );
    }

    const access = await verifyLocalProjectAccess(user.id, projectId);
    if (access.error) return access.error;

    const contents = getDirectoryContents(user.id, projectId, path);

    return NextResponse.json({ contents });
  } catch (error: any) {
    console.error('Error fetching local project contents:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch contents' },
      { status: 500 }
    );
  }
}

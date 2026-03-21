import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyLocalProjectAccess } from '@/lib/auth';
import { getFileContents } from '@/lib/local-projects';

export async function GET(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    const filePath = searchParams.get('path');

    if (!projectId || !filePath) {
      return NextResponse.json(
        { error: 'project_id and path required' },
        { status: 400 }
      );
    }

    const access = await verifyLocalProjectAccess(user.id, projectId);
    if (access.error) return access.error;

    const content = getFileContents(user.id, projectId, filePath);

    return NextResponse.json({ content, path: filePath });
  } catch (error: any) {
    console.error('Error fetching local project file:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch file' },
      { status: 500 }
    );
  }
}

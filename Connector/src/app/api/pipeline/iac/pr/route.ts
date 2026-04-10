import { NextRequest, NextResponse } from 'next/server';

import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { persistIacToRepoPr, type IacRepoFile } from '@/lib/iac-pr';

interface CreateIacPrBody {
  project_id?: string;
  project_name?: string;
  files?: IacRepoFile[];
}

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const body = await request.json().catch(() => ({})) as CreateIacPrBody;
    const projectId = String(body.project_id || '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const owned = await verifyProjectOwnership(user.id, projectId);
    if ('error' in owned) return owned.error;

    const files = Array.isArray(body.files)
      ? body.files
        .filter((file) => file && typeof file === 'object')
        .map((file) => ({
          path: String(file.path || '').trim(),
          content: String(file.content || ''),
          encoding: file.encoding === 'base64' ? 'base64' : 'utf-8',
        }))
        .filter((file) => file.path)
      : [];

    if (files.length === 0) {
      return NextResponse.json({ error: 'files are required to create an IaC PR' }, { status: 400 });
    }

    const projectName = String(body.project_name || owned.project?.name || owned.project?.full_name || projectId)
      .split('/')
      .pop() || projectId;

    const result = await persistIacToRepoPr(String(user.id), projectId, projectName, files);
    const status = result.success || !result.attempted ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create IaC PR';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

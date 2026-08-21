import { NextRequest, NextResponse } from 'next/server';

import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import {
  createCustomizationSnapshotPr,
  CustomizationPrError,
} from '@/lib/customization-pr';
import { SnapshotResolutionError } from '@/lib/customization-snapshot';

interface CreateCustomizationPrBody {
  project_id?: string;
  tenant_id?: string;
  snapshot_id?: string;
}

const FORBIDDEN_BROWSER_INPUTS = [
  'files',
  'file_contents',
  'content',
  'snapshot_path',
  'base_repo_path',
  'source_repo_path',
];

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;

    const rawBody = await request.json().catch(() => null) as unknown;
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return NextResponse.json({ error: 'A JSON request body is required.' }, { status: 400 });
    }
    const bodyRecord = rawBody as Record<string, unknown>;
    if (FORBIDDEN_BROWSER_INPUTS.some((key) => Object.prototype.hasOwnProperty.call(bodyRecord, key))) {
      return NextResponse.json(
        { error: 'File contents and filesystem paths are resolved from the immutable snapshot server-side.' },
        { status: 400 },
      );
    }

    const body = bodyRecord as CreateCustomizationPrBody;
    const projectId = String(body.project_id || '').trim();
    const tenantId = String(body.tenant_id || '').trim();
    const snapshotId = String(body.snapshot_id || '').trim();
    if (!projectId || !tenantId || !snapshotId) {
      return NextResponse.json(
        { error: 'project_id, tenant_id, and snapshot_id are required.' },
        { status: 400 },
      );
    }

    const owned = await verifyProjectOwnership(String(user.id), projectId);
    if ('error' in owned) return owned.error;

    const result = await createCustomizationSnapshotPr({
      userId: String(user.id),
      projectId,
      tenantId,
      snapshotId,
    });
    return NextResponse.json(result, {
      status: result.success || !result.attempted ? 200 : 502,
    });
  } catch (error) {
    if (error instanceof SnapshotResolutionError || error instanceof CustomizationPrError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error instanceof CustomizationPrError ? error.code : 'snapshot_resolution_failed',
        },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create the customization PR.' },
      { status: 500 },
    );
  }
}

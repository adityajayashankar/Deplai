import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { query } from '@/lib/db';
import { extractZipToProject } from '@/lib/local-projects';
import { v4 as uuidv4 } from 'uuid';
import {
  ACTIVE_ORGANIZATION_COOKIE,
  requireOrganizationPermission,
  resolveActiveOrganization,
  writeOrganizationAudit,
} from '@/lib/organizations/store';
import { organizationApiError } from '@/lib/organizations/api';
import { planIncludesFeature } from '@/lib/billing/plan-features';
import { getOrganizationSubscription } from '@/lib/billing/credits';
import { isBillingEnforced } from '@/lib/ai-platform/subscription-access';

const MAX_FILE_SIZE = 1 * 1024 * 1024 * 1024; // 1GB limit

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await requireAuth();
    if (error) return error;
    const organization = await resolveActiveOrganization(
      user,
      request.cookies.get(ACTIVE_ORGANIZATION_COOKIE)?.value,
    );
    await requireOrganizationPermission({
      userId: user.id,
      organizationId: organization.id,
      action: 'project.create',
    });

    if (isBillingEnforced()) {
      const subscription = await getOrganizationSubscription(organization.id).catch(() => null);
      const planId = subscription?.planId || 'free';
      if (!planIncludesFeature(planId, 'multi_project')) {
        const existing = await query<Array<{ count: number }>>(
          `SELECT COUNT(*) AS count FROM projects WHERE organization_id = ?`,
          [organization.id],
        );
        if (Number(existing[0]?.count || 0) >= 1) {
          return NextResponse.json(
            {
              error: 'Free plan includes one project. Upgrade to Starter for unlimited projects.',
              code: 'plan_upgrade_required',
              upgrade_path: '/dashboard/billing',
            },
            { status: 403 },
          );
        }
      }
    }

    // Parse form data
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const projectName = formData.get('name') as string;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    if (!projectName?.trim()) {
      return NextResponse.json(
        { error: 'Project name is required' },
        { status: 400 }
      );
    }

    // Validate file type (only zip)
    if (!file.name.endsWith('.zip')) {
      return NextResponse.json(
        { error: 'Only .zip files are supported' },
        { status: 400 }
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File size exceeds ${MAX_FILE_SIZE / 1024 / 1024 / 1024}GB limit` },
        { status: 400 }
      );
    }

    // Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Generate project ID
    const projectId = uuidv4();

    // Extract zip to local storage
    const { path: localPath, fileCount, sizeBytes } = await extractZipToProject(
      buffer,
      user.id,
      projectId
    );

    const trimmedName = projectName.trim();

    await query(
      `INSERT INTO projects
       (id, name, project_type, local_path, file_count, size_bytes, user_id, organization_id, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [projectId, trimmedName, 'local', localPath, fileCount, sizeBytes, user.id, organization.id, user.id]
    );
    await writeOrganizationAudit({
      organizationId: organization.id,
      actorUserId: user.id,
      action: 'project.created',
      resourceType: 'project',
      resourceId: projectId,
      projectId,
      metadata: { name: trimmedName, type: 'local' },
    });

    return NextResponse.json({
      success: true,
      project: {
        id: projectId,
        name: trimmedName,
        type: 'local',
        localPath,
        fileCount,
        sizeBytes,
        organizationId: organization.id,
      },
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'OrganizationError') return organizationApiError(error);
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to upload project' },
      { status: 500 }
    );
  }
}

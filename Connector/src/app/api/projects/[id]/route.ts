import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyProjectOwnership } from '@/lib/auth';
import { query } from '@/lib/db';
import { deleteProject } from '@/lib/local-projects';
import { AGENTIC_URL, agenticHeaders } from '@/lib/agentic';

type ProjectRow = {
  id: string;
  name: string;
  project_type: string;
  local_path: string | null;
  file_count: number | null;
  size_bytes: number | null;
  created_at: string | Date;
  user_id: string;
  repository_id: string | null;
  repo_full_name: string | null;
  github_installation_id: string | null;
};

type GithubRepositoryRow = {
  id: string;
  full_name: string;
  default_branch: string;
  is_private: boolean | number;
  created_at: string | Date;
  installation_id: string;
  user_id: string | null;
};

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await context.params;

    const { user, error } = await requireAuth();
    if (error) return error;
    const access = await verifyProjectOwnership(user.id, projectId, 'project.delete');
    if (access.error) return access.error;

    const [project] = await query<ProjectRow[]>(
      `SELECT 
        id,
        name,
        project_type,
        local_path,
        user_id
       FROM projects
       WHERE id = ?`,
      [projectId]
    );

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    if (project.project_type !== 'local') {
      return NextResponse.json(
        { error: 'Cannot delete GitHub repositories through this endpoint' },
        { status: 400 }
      );
    }

    try {
      deleteProject(project.user_id, projectId);
    } catch (fsError: unknown) {
      console.error('Filesystem deletion error:', fsError);
    }

    await query(
      `DELETE FROM projects WHERE id = ?`,
      [projectId]
    );

    try {
      const cleanupRes = await fetch(`${AGENTIC_URL}/api/scan/results/${projectId}`, {
        method: 'DELETE',
        headers: agenticHeaders(),
      });
      if (!cleanupRes.ok) {
        console.error('Scan report cleanup returned', cleanupRes.status);
      }
    } catch (cleanupError) {
      console.error('Scan report cleanup failed (non-fatal):', cleanupError);
    }

    return NextResponse.json({
      success: true,
      message: 'Project deleted successfully',
      deletedProject: {
        id: project.id,
        name: project.name,
      },
    });
  } catch (error: unknown) {
    console.error('Delete project error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete project' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await context.params;

    const { user, error } = await requireAuth();
    if (error) return error;
    const access = await verifyProjectOwnership(user.id, projectId, 'project.read');
    if (access.error) return access.error;

    // Try local projects table first
    const [project] = await query<ProjectRow[]>(
      `SELECT
        p.id,
        p.name,
        p.project_type,
        p.local_path,
        p.file_count,
        p.size_bytes,
        p.created_at,
        p.user_id,
        p.repository_id,
        gr.full_name AS repo_full_name,
        gi.installation_id AS github_installation_id
       FROM projects p
       LEFT JOIN github_repositories gr ON p.repository_id = gr.id
       LEFT JOIN github_installations gi ON gr.installation_id = gi.id
       WHERE p.id = ?`,
      [projectId]
    );

    if (project) {
      const response = {
        id: project.id,
        name: project.name,
        type: project.project_type,
        localPath: project.local_path,
        fileCount: project.file_count,
        sizeBytes: project.size_bytes,
        createdAt: project.created_at,
        ...(project.project_type === 'github' && project.repo_full_name ? {
          owner: project.repo_full_name.split('/')[0],
          repo: project.repo_full_name.split('/')[1],
          installationId: project.github_installation_id,
        } : {}),
      };

      return NextResponse.json({ project: response });
    }

    // Fallback: check github_repositories (GitHub repo IDs are used as projectId)
    const [ghRepo] = await query<GithubRepositoryRow[]>(
      `SELECT
        r.id,
        r.full_name,
        r.default_branch,
        r.is_private,
        r.created_at,
        i.id AS installation_id,
        i.user_id
       FROM github_repositories r
       JOIN github_installations i ON i.id = r.installation_id
       WHERE r.id = ?`,
      [projectId]
    );

    if (!ghRepo) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const [owner, repoName] = ghRepo.full_name.split('/');
    const response = {
      id: ghRepo.id,
      name: repoName,
      type: 'github',
      owner,
      repo: repoName,
      branch: ghRepo.default_branch,
      access: ghRepo.is_private ? 'Private' : 'Public',
      installationId: ghRepo.installation_id,
      createdAt: ghRepo.created_at,
    };

    return NextResponse.json({ project: response });
  } catch (error: unknown) {
    console.error('Get project error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch project' },
      { status: 500 }
    );
  }
}

import path from 'path';
import fs from 'fs';

import { query } from './db';
import { githubService } from './github';

export interface ProjectMeta {
  project_type: 'local' | 'github';
  repo_full_name: string | null;
  installation_uuid: string | null;
}

export async function resolveProjectMeta(
  userId: string,
  projectId: string,
): Promise<ProjectMeta | null> {
  let rows = await query<ProjectMeta[]>(
    `SELECT
      p.project_type,
      gr.full_name AS repo_full_name,
      gi.id AS installation_uuid
    FROM projects p
    LEFT JOIN github_repositories gr ON p.repository_id = gr.id
    LEFT JOIN github_installations gi ON gr.installation_id = gi.id
    WHERE p.id = ?`,
    [projectId],
  );

  if (!rows[0]) {
    rows = await query<ProjectMeta[]>(
      `SELECT
        'github' AS project_type,
        gr.full_name AS repo_full_name,
        gi.id AS installation_uuid
      FROM github_repositories gr
      JOIN github_installations gi ON gr.installation_id = gi.id
      LEFT JOIN projects p ON p.repository_id = gr.id
      WHERE gr.id = ? AND (gi.user_id = ? OR p.user_id = ?)
      LIMIT 1`,
      [projectId, userId, userId],
    );
  }
  return rows[0] || null;
}

export async function resolveProjectSourceRoot(
  userId: string,
  projectId: string,
): Promise<string | null> {
  const meta = await resolveProjectMeta(userId, projectId);
  if (!meta) return null;

  if (meta.project_type === 'github' && meta.repo_full_name && meta.installation_uuid) {
    const [owner, repo] = meta.repo_full_name.split('/');
    if (!owner || !repo) return null;
    try {
      const repoRoot = await githubService.ensureRepoFresh(meta.installation_uuid, owner, repo);
      if (repoRoot && fs.existsSync(repoRoot) && fs.statSync(repoRoot).isDirectory()) {
        return repoRoot;
      }
    } catch {
      return null;
    }
    return null;
  }

  const localBase = path.join(process.cwd(), 'tmp', 'local-projects', userId, projectId);
  if (fs.existsSync(localBase) && fs.statSync(localBase).isDirectory()) {
    return localBase;
  }
  return null;
}

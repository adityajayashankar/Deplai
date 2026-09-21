import 'server-only';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyRepositoryOwnership } from '../auth';
import { githubService } from '../github';
import { requireProjectPermission } from '../organizations/store';
import { buildSessions } from './store';
import { createImportService } from './import-service';
import { githubReader } from './github-ingestion';
import { IMPORT_LIMITS, ImportError, validateGitSource } from './ingestion';

/** Internal orchestration entry; no browser URL or agent tool exposes workspace reads. */
export function buildImportStore() {
  const root = process.env.BUILD_IMPORT_ROOT;
  if (!root || !path.isAbsolute(root)) throw new ImportError('Configure an absolute private BUILD_IMPORT_ROOT before importing');
  const service = createImportService({
    privateRoot: root,
    authorizeSession: async (actor, scope) => {
      const session = await buildSessions.get(actor, scope);
      if (!['DRAFT', 'ANALYZING'].includes(session.state)) throw new ImportError('Session is not accepting source imports');
      await requireProjectPermission({ userId: actor, projectId: scope.project_id, action: 'agent.run' });
      await requireProjectPermission({ userId: actor, projectId: scope.project_id, action: 'repository.read' });
    },
    authorizedGitReader: async (actor, scope, source) => {
      const { owner, repository } = validateGitSource(source);
      const access = await verifyRepositoryOwnership(actor, owner, repository);
      if (!access || access.suspended) throw new ImportError('Repository access denied');
      const session = await buildSessions.get(actor, scope);
      const transport = githubReader(source, await githubService.getInstallationTokenForBuildImport(access.installationId));
      return { ...transport, resolve: async input => {
        const resolved = await transport.resolve(input);
        if (session.source_type !== 'IMPORT_REPOSITORY' || session.source_revision !== resolved.commit) throw new ImportError('Source revision differs from the approved BuildSession');
        return resolved;
      } };
    },
  });
  return {
    importGit: service.importGit,
    async importZip(actor: string, scope: Parameters<typeof service.importZip>[1], upload: Buffer) {
      if (!Buffer.isBuffer(upload) || upload.length > IMPORT_LIMITS.archiveBytes) throw new ImportError('Archive exceeds upload limit');
      const archive = Buffer.from(upload);
      const session = await buildSessions.get(actor, scope);
      if (session.source_type !== 'IMPORT_REPOSITORY' || session.source_revision !== createHash('sha256').update(archive).digest('hex')) throw new ImportError('Archive differs from the approved BuildSession');
      return service.importZip(actor, scope, archive);
    },
  };
}

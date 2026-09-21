import { assertScope, type BuildScope } from './contracts';
import { IMPORT_LIMITS, ImportError, materializeImport, readGit, readZip, validateGitSource, type GitReader, type GitSource } from './ingestion';

/** Internal API only. The caller fixes a private storage root; user inputs never choose it. */
export function createImportService(deps: {
  privateRoot: string;
  authorizeSession: (actor: string, scope: BuildScope) => Promise<void>;
  authorizedGitReader: (actor: string, scope: BuildScope, source: GitSource) => Promise<GitReader>;
}) {
  async function authorized(actor: string, scope: BuildScope) {
    assertScope(scope);
    if (actor !== scope.owner_user_id) throw new Error('Import access denied');
    await deps.authorizeSession(actor, scope);
  }
  return {
    async importGit(actor: string, requestedScope: BuildScope, requestedSource: GitSource) {
      const scope = { ...requestedScope }; const source = { ...requestedSource };
      validateGitSource(source); await authorized(actor, scope);
      const reader = await deps.authorizedGitReader(actor, scope, source);
      const { files, resolved } = await readGit(source, reader);
      await authorized(actor, scope);
      return materializeImport(deps.privateRoot, scope, files, { type: 'GIT', original: source, resolved });
    },
    async importZip(actor: string, requestedScope: BuildScope, upload: Buffer) {
      if (!Buffer.isBuffer(upload) || upload.length > IMPORT_LIMITS.archiveBytes) throw new ImportError('Archive exceeds upload limit');
      const archive = Buffer.from(upload);
      const scope = { ...requestedScope }; await authorized(actor, scope);
      const files = readZip(archive);
      await authorized(actor, scope);
      return materializeImport(deps.privateRoot, scope, files, { type: 'ZIP', archive });
    },
  };
}

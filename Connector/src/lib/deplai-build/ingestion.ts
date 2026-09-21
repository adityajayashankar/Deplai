import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mkdir, lstat, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { assertScope, type BuildScope } from './contracts';

export const IMPORT_LIMITS = { files: 20000, fileBytes: 8 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, archiveBytes: 32 * 1024 * 1024, depth: 32 } as const;
export class ImportError extends Error { constructor(message: string) { super(message); this.name = 'ImportError'; } }
export type ImportFile = { path: string; bytes: Buffer; executable: boolean };
export type GitSource = { url: string; ref: string };
export type GitResolution = { commit: string; tree: string };
export interface GitReader {
  resolve(source: GitSource): Promise<GitResolution>;
  tree(source: GitSource, resolved: GitResolution): Promise<Array<{ path: string; sha: string; mode: string; type: string; size?: number }>>;
  blob(source: GitSource, sha: string): Promise<Buffer>;
}
export type RepositoryMap = Record<'directories' | 'manifests' | 'package_manager_files' | 'config_files' | 'docker_files' | 'env_templates' | 'ci_files' | 'migrations' | 'test_directories' | 'likely_code_roots', string[]>;
export type ImportMetadata = {
  import_id: string; scope: BuildScope; source_type: 'GIT' | 'ZIP'; original_url: string | null; ref: string | null;
  resolved_commit_sha: string | null; content_sha256: string; archive_sha256: string | null;
  repository_root: string; imported_at: string; vcs: 'git' | 'none'; architecture_policy: 'PRESERVE_EXISTING';
};
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function validateGitSource(source: GitSource): { owner: string; repository: string } {
  let url: URL;
  try { url = new URL(source.url); } catch { throw new ImportError('Malformed repository URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new ImportError('Only credential-free GitHub HTTPS repository URLs are supported');
  const match = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!match || ['.', '..'].includes(match[2])) throw new ImportError('Invalid repository URL path');
  if (typeof source.ref !== 'string' || !source.ref || source.ref.length > 200 || source.ref.startsWith('-') || /[\s~^:?*\[\\\x00-\x1f]/.test(source.ref) || source.ref.includes('..') || source.ref.includes('@{') || source.ref.includes('//')) throw new ImportError('Invalid Git branch or ref');
  return { owner: match[1], repository: match[2] };
}
export function safeImportPath(name: string): string {
  if (!name || name.length > 512 || /[\\:\x00-\x1f]/.test(name) || name.startsWith('/') || name.split('/').length > IMPORT_LIMITS.depth) throw new ImportError('Unsafe repository path');
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || p.toLowerCase() === '.git')) throw new ImportError('Unsafe repository path');
  // Reject credential files rather than silently changing the imported application.
  const base = parts.at(-1)!;
  if ((/^\.env(?:\.|$)/i.test(base) && !/^\.env\.(?:example|template|sample)$/i.test(base)) || /\.(?:pem|p12|pfx|key)$/i.test(base) || /^(?:id_rsa|id_ed25519|credentials|\.netrc|\.npmrc|\.pypirc)$/i.test(base) || parts.some(p => ['.aws', '.ssh'].includes(p.toLowerCase()))) throw new ImportError('Import contains a credential-bearing file; supply a sanitized source revision');
  return name;
}
function checkFiles(files: ImportFile[]): void {
  if (!files.length || files.length > IMPORT_LIMITS.files) throw new ImportError('Invalid repository file count');
  let total = 0; const seen = new Set<string>();
  for (const file of files) {
    safeImportPath(file.path); const key = file.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new ImportError('Duplicate or case-colliding repository paths'); seen.add(key);
    if (file.bytes.length > IMPORT_LIMITS.fileBytes) throw new ImportError('Repository file exceeds size limit');
    total += file.bytes.length;
    if (total > IMPORT_LIMITS.totalBytes) throw new ImportError('Repository exceeds total size limit');
  }
  for (const name of seen) { const parts = name.split('/'); for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/'))) throw new ImportError('File/directory path collision'); }
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function readZip(bytes: Buffer): ImportFile[] {
  if (!Buffer.isBuffer(bytes) || bytes.length > IMPORT_LIMITS.archiveBytes) throw new ImportError('Archive exceeds upload limit');
  try {
    const entries = new AdmZip(bytes).getEntries();
    if (!entries.length || entries.length > IMPORT_LIMITS.files) throw new ImportError('Archive entry count exceeds limit');
    let declaredTotal = 0; const files: ImportFile[] = [];
    for (const entry of entries) {
      const name = entry.entryName.replace(/\/$/, ''); safeImportPath(name);
      const mode = (entry.attr >>> 16) & 0xffff; const kind = mode & 0xf000;
      if (kind && kind !== 0x8000 && kind !== 0x4000) throw new ImportError('Archive links and special files are forbidden');
      if (entry.header.flags & 1 || ![0, 8].includes(entry.header.method)) throw new ImportError('Encrypted or unsupported archive entry');
      if (entry.header.size > IMPORT_LIMITS.fileBytes || (declaredTotal += entry.header.size) > IMPORT_LIMITS.totalBytes) throw new ImportError('Archive expanded size exceeds limit');
      if (entry.isDirectory) continue;
      const compressed = entry.getCompressedData();
      const data = entry.header.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: IMPORT_LIMITS.fileBytes });
      if (data.length !== entry.header.size || crc32(data) !== (entry.header.crc >>> 0)) throw new ImportError('Archive size or checksum mismatch');
      files.push({ path: name, bytes: data, executable: Boolean(mode & 0o111) });
    }
    checkFiles(files); return files;
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('Invalid or oversized ZIP archive');
  }
}
export async function readGit(source: GitSource, reader: GitReader): Promise<{ files: ImportFile[]; resolved: GitResolution }> {
  validateGitSource(source);
  const resolved = await reader.resolve(source);
  if (![resolved.commit, resolved.tree].every(v => /^[a-f0-9]{40}$/.test(v))) throw new ImportError('Git transport did not resolve an exact revision');
  const tree = await reader.tree(source, resolved);
  if (!tree.length || tree.length > IMPORT_LIMITS.files) throw new ImportError('Git tree exceeds entry limit');
  const files: ImportFile[] = []; let total = 0;
  for (const entry of tree) {
    safeImportPath(entry.path);
    if (entry.type === 'tree' && entry.mode === '040000') continue;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new ImportError('Git symlinks and submodules are not supported');
    if (!/^[a-f0-9]{40}$/.test(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size! < 0 || entry.size! > IMPORT_LIMITS.fileBytes || (total += entry.size!) > IMPORT_LIMITS.totalBytes) throw new ImportError('Git blob metadata exceeds limits');
    const bytes = await reader.blob(source, entry.sha);
    if (bytes.length !== entry.size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha) throw new ImportError('Git blob integrity mismatch');
    files.push({ path: entry.path, bytes, executable: entry.mode === '100755' });
  }
  checkFiles(files); return { files, resolved };
}
export function repositoryMap(files: ImportFile[]): RepositoryMap {
  checkFiles(files);
  const map: RepositoryMap = { directories: [], manifests: [], package_manager_files: [], config_files: [], docker_files: [], env_templates: [], ci_files: [], migrations: [], test_directories: [], likely_code_roots: [] };
  const dirs = new Set<string>();
  for (const file of files) {
    const name = file.path; const base = name.split('/').at(-1)!; const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    if (/^(package.json|pyproject.toml|requirements.*\.txt|go.mod|Cargo.toml|pom.xml|Gemfile|composer.json)$/.test(base)) map.manifests.push(name);
    if (/(lock|pnpm-workspace|yarnrc)/i.test(base)) map.package_manager_files.push(name);
    if (/(config|\.toml$|\.ini$|tsconfig)/i.test(base)) map.config_files.push(name);
    if (/^(Dockerfile|docker-compose|compose\.)/i.test(base)) map.docker_files.push(name);
    if (/^\.env\.(example|template|sample)$/i.test(base)) map.env_templates.push(name);
    if (name.startsWith('.github/workflows/') || /^(\.gitlab-ci.yml|Jenkinsfile)$/.test(base)) map.ci_files.push(name);
    if (parts.some(p => /^(migrations?|alembic)$/i.test(p))) map.migrations.push(name);
  }
  map.directories = [...dirs];
  map.test_directories = [...dirs].filter(d => /(^|\/)(tests?|__tests__|spec)$/.test(d));
  map.likely_code_roots = [...dirs].filter(d => /(^|\/)(src|app|apps|lib|packages|services)$/.test(d));
  for (const values of Object.values(map)) values.sort();
  return map;
}

/** Trusted private base directory only. Existing parents must never be tenant-controlled. */
export async function materializeImport(baseDirectory: string, scope: BuildScope, files: ImportFile[], source: { type: 'GIT'; original: GitSource; resolved: GitResolution } | { type: 'ZIP'; archive: Buffer }) {
  assertScope(scope); checkFiles(files);
  const base = path.resolve(baseDirectory);
  // Reject symlink/reparse parents all the way to the filesystem root.
  let parent = base;
  while (true) { const info = await lstat(parent); if (info.isSymbolicLink() || !info.isDirectory()) throw new ImportError('Import base must use real private directories'); const next = path.dirname(parent); if (next === parent) break; parent = next; }
  if (await realpath(base) !== base) throw new ImportError('Import base is not canonical');
  const importId = randomUUID(); const root = path.join(base, importId);
  await mkdir(root, { mode: 0o700 });
  const sourceRoot = path.join(root, 'source'); await mkdir(sourceRoot, { mode: 0o700 });
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update(JSON.stringify([file.path, file.executable, sha256(file.bytes)]));
    const destination = path.join(sourceRoot, file.path);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.bytes, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
  }
  const metadata: ImportMetadata = { import_id: importId, scope: { ...scope }, source_type: source.type, original_url: source.type === 'GIT' ? source.original.url : null, ref: source.type === 'GIT' ? source.original.ref : null, resolved_commit_sha: source.type === 'GIT' ? source.resolved.commit : null, content_sha256: hash.digest('hex'), archive_sha256: source.type === 'ZIP' ? sha256(source.archive) : null, repository_root: 'source', imported_at: new Date().toISOString(), vcs: source.type === 'GIT' ? 'git' : 'none', architecture_policy: 'PRESERVE_EXISTING' };
  const map = repositoryMap(files);
  await writeFile(path.join(root, 'import.json'), JSON.stringify({ metadata, map }, null, 2), { flag: 'wx', mode: 0o600 });
  return { importId, metadata, map };
}

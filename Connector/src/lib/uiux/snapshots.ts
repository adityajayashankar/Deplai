import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { githubService } from '@/lib/github';
import { resolveProjectMeta } from '@/lib/project-meta';
import { isEditableUiPath, isSafeUiReadPath } from './presentation-policy';
import { indexGitSource } from './git-source-index';

export type Snapshot = {
  project: { id: string; name: string; type: string; owner?: string; repo?: string; branch?: string };
  source_sha: string; tree_sha?: string; installation_uuid?: string;
  owner_user_id?: string;
  files: { path: string; content: string; size?: number; blob_sha?: string; loaded?: boolean; modified?: number }[]; warnings: string[];
};
export class UiuxError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const MAX_FILE = 128 * 1024;
const secret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-or-v1-[A-Za-z0-9]{20,})|(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i;
export function editorPath(value: string) {
  return isEditableUiPath(value) && !value.split('/').some(p => p.startsWith('.') || /^(backend|middleware)$/i.test(p)) && !/(?:^|[./_-])use[A-Z]/.test(value);
}
/** Index immutable Git objects without downloading the repository archive. */
export async function snapshotRepository(userId: string, projectId: string, ownerUserId: string): Promise<Snapshot> {
  const meta = await resolveProjectMeta(userId, projectId);
  if (!meta) throw new UiuxError('Repository metadata is unavailable.', 404);
  const result: Snapshot = { project: { id: projectId, name: meta.repo_full_name || projectId, type: meta.project_type }, owner_user_id: ownerUserId, source_sha: '', files: [], warnings: [] };
  if (meta.project_type === 'github' && meta.repo_full_name && meta.installation_uuid) {
    const [owner, repo] = meta.repo_full_name.split('/');
    if (!owner || !repo) throw new UiuxError('Invalid connected repository.');
    const client = await githubService.getInstallationClient(meta.installation_uuid);
    const details = await client.repos.get({ owner, repo });
    const branch = details.data.default_branch;
    const ref = await client.git.getRef({ owner, repo, ref: `heads/${branch}` });
    const commit = await client.git.getCommit({ owner, repo, commit_sha: ref.data.object.sha });
    Object.assign(result.project, { owner, repo, branch });
    result.source_sha = ref.data.object.sha;
    result.tree_sha = commit.data.tree.sha;
    result.installation_uuid = meta.installation_uuid;
    result.files = await indexGitSource(result.tree_sha!, async (sha, recursive) => (await client.git.getTree({ owner, repo, tree_sha: sha, ...(recursive ? { recursive: 'true' } : {}) })).data);
  } else if (meta.project_type === 'local') {
    if (![ownerUserId, projectId].every(v => /^[a-zA-Z0-9_-]+$/.test(v))) throw new UiuxError('Invalid local project identifier.');
    const parent = await fs.realpath(path.join(process.cwd(), 'tmp', 'local-projects'));
    const root = await fs.realpath(path.join(parent, ownerUserId, projectId));
    if (!root.startsWith(parent + path.sep)) throw new UiuxError('Invalid local project path.');
    const walk = async (folder: string, prefix = ''): Promise<void> => {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || /^(node_modules|dist|build|vendor|coverage|venv)$/i.test(entry.name)) continue;
        const name = prefix + entry.name;
        const absolute = path.join(folder, entry.name);
        if (entry.isDirectory()) { await walk(absolute, name + '/'); continue; }
        if (!entry.isFile() || !isSafeUiReadPath(name)) continue;
        const stat = await fs.stat(absolute);
        result.files.push({ path: name, content: '', loaded: false, size: stat.size, modified: stat.mtimeMs });
      }
    };
    await walk(root);
    result.files.sort((a, b) => a.path.localeCompare(b.path));
    result.source_sha = createHash('sha1').update(JSON.stringify(result.files)).digest('hex');
  } else throw new UiuxError('Connect a GitHub repository or upload a ZIP first.', 409);
  const seen = new Set<string>();
  for (const file of result.files) {
    if (seen.has(file.path.toLowerCase())) throw new UiuxError('Repository contains ambiguous file names.');
    seen.add(file.path.toLowerCase());
  }
  return result;
}

export async function loadSnapshotFile(snapshot: Snapshot, name: string): Promise<{ path: string; content: string }> {
  const file = snapshot.files.find(entry => entry.path === name);
  if (!file || !isSafeUiReadPath(name)) throw new UiuxError('Source file not found.', 404);
  if (file.loaded !== false) return { path: name, content: file.content };
  if ((file.size || 0) > MAX_FILE) throw new UiuxError('This individual file exceeds the 128 KiB editing window. Other repository files remain available.', 413);
  let data: Buffer;
  if (snapshot.project.type === 'github' && snapshot.installation_uuid && snapshot.project.owner && snapshot.project.repo && file.blob_sha) {
    const client = await githubService.getInstallationClient(snapshot.installation_uuid);
    const blob = (await client.git.getBlob({ owner: snapshot.project.owner, repo: snapshot.project.repo, file_sha: file.blob_sha })).data;
    if (blob.encoding !== 'base64') throw new UiuxError('Unsupported GitHub source encoding.', 502);
    data = Buffer.from(blob.content, 'base64');
    if (createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') !== file.blob_sha) throw new UiuxError('GitHub source does not match the selected commit.', 409);
  } else if (snapshot.project.type === 'local' && snapshot.owner_user_id) {
    const parent = await fs.realpath(path.join(process.cwd(), 'tmp', 'local-projects'));
    const root = await fs.realpath(path.join(parent, snapshot.owner_user_id, snapshot.project.id));
    const absolute = await fs.realpath(path.join(root, ...name.split('/')));
    if (!root.startsWith(parent + path.sep) || !absolute.startsWith(root + path.sep)) throw new UiuxError('Invalid local project path.', 403);
    const stat = await fs.stat(absolute);
    if (stat.size !== file.size || stat.mtimeMs !== file.modified) throw new UiuxError('Local source changed. Reload the repository to start from the latest files.', 409);
    data = await fs.readFile(absolute);
  } else throw new UiuxError('Source metadata is unavailable. Reload the repository.', 409);
  if (data.length > MAX_FILE || data.includes(0)) throw new UiuxError('File is binary or exceeds the per-file editing window.', 413);
  const content = data.toString('utf8');
  if (secret.test(content)) throw new UiuxError('File contains a possible embedded credential and cannot be sent to the editor.', 403);
  return { path: name, content };
}

function stateFile(userId: string, projectId: string, key: string) {
  const owner = createHash('sha256').update(JSON.stringify([userId, projectId])).digest('hex');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new UiuxError('Run not found.', 404);
  return path.join(process.env.UIUX_CONNECTOR_STATE_DIR || path.join(process.cwd(), 'tmp', 'uiux-state'), owner, `${key}.json`);
}
export async function saveState(userId: string, projectId: string, key: string, value: unknown) {
  const file = stateFile(userId, projectId, key);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, file);
}
export async function readState<T>(userId: string, projectId: string, key: string): Promise<T> {
  try { return JSON.parse(await fs.readFile(stateFile(userId, projectId, key), 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UiuxError('Saved source was not found. Reload the repository and start a new task.', 404); throw error; }
}

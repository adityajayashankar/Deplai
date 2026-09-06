import { isSafeUiReadPath } from './presentation-policy';

type GitEntry = { path?: string; type?: string; mode?: string; size?: number; sha?: string };
type GitTree = { tree: GitEntry[]; truncated?: boolean };
export async function indexGitSource(rootSha: string, readTree: (sha: string, recursive: boolean) => Promise<GitTree>) {
  const files: { path: string; content: string; loaded: false; size?: number; blob_sha?: string }[] = [];
  const append = (entry: GitEntry, prefix = '') => {
    const name = prefix + (entry.path || '');
    if (entry.type === 'blob' && ['100644', '100755'].includes(entry.mode || '') && isSafeUiReadPath(name)) files.push({ path: name, content: '', loaded: false, size: entry.size, blob_sha: entry.sha });
  };
  const tree = await readTree(rootSha, true);
  if (!tree.truncated) tree.tree.forEach(entry => append(entry));
  else {
    const pending = [{ sha: rootSha, prefix: '' }];
    while (pending.length) {
      const item = pending.pop()!;
      const subtree = await readTree(item.sha, false);
      if (subtree.truncated) throw new Error('GitHub could not return a complete directory listing. Retry this repository.');
      for (const entry of subtree.tree) {
        if (entry.type === 'tree' && entry.sha && entry.path) pending.push({ sha: entry.sha, prefix: item.prefix + entry.path + '/' });
        else append(entry, item.prefix);
      }
    }
  }
  return files;
}

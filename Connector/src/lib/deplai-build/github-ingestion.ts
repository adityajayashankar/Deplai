import { IMPORT_LIMITS, ImportError, validateGitSource, type GitReader, type GitSource } from './ingestion';

/** A trusted caller must first authorize repository access and supply a read-only token. */
export function githubReader(authorizedSource: GitSource, installationToken: string, fetcher: typeof fetch = fetch): GitReader {
  const repo = validateGitSource(authorizedSource);
  const original = { ...authorizedSource }; const deadline = Date.now() + 120000;
  const prefix = `https://api.github.com/repos/${repo.owner}/${repo.repository}`;
  async function request(source: GitSource, suffix: string, limit: number): Promise<Record<string, unknown>> {
    if (source.url !== original.url || source.ref !== original.ref) throw new ImportError('Git reader is bound to a different source');
    if (Date.now() >= deadline) throw new ImportError('Git import time limit reached');
    try {
      const response = await fetcher(prefix + suffix, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${installationToken}`, 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(20000, deadline - Date.now()))) });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
      while (true) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > limit) { await reader.cancel(); throw new Error(); } chunks.push(next.value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new ImportError('GitHub read failed, timed out or exceeded limits; verify repository access and ref'); }
  }
  return {
    resolve: async source => {
      const data = await request(source, `/commits/${encodeURIComponent(source.ref)}`, 2 * 1024 * 1024);
      const commit = data.commit as { tree?: { sha?: string } } | undefined;
      if (typeof data.sha !== 'string' || typeof commit?.tree?.sha !== 'string') throw new ImportError('Invalid GitHub commit response');
      return { commit: data.sha, tree: commit.tree.sha };
    },
    tree: async (source, resolved) => {
      if (!/^[a-f0-9]{40}$/.test(resolved.tree)) throw new ImportError('Invalid tree revision');
      const data = await request(source, `/git/trees/${resolved.tree}?recursive=1`, 8 * 1024 * 1024);
      if (data.truncated !== false || data.sha !== resolved.tree || !Array.isArray(data.tree)) throw new ImportError('Incomplete Git tree; import refused');
      return data.tree;
    },
    blob: async (source, sha) => {
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new ImportError('Invalid blob revision');
      const data = await request(source, `/git/blobs/${sha}`, Math.ceil(IMPORT_LIMITS.fileBytes * 1.5));
      if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.sha !== sha) throw new ImportError('Invalid GitHub blob response');
      return Buffer.from(data.content, 'base64');
    },
  };
}

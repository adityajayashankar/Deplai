import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

interface GitHubFile {
  path: string;
  content: string;
}

interface RepoCreateBody {
  name: string;
  description?: string;
  is_private?: boolean;
  files?: GitHubFile[];
  enable_pages?: boolean;
  github_pat: string;
}

async function ghFetch(url: string, pat: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'deplai-app/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return {
    ok: res.ok,
    status: res.status,
    data: await res.json().catch(() => ({})) as Record<string, unknown>,
  };
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth();
  if (error) return error;

  let body: RepoCreateBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { name, description, is_private, files = [], enable_pages, github_pat } = body;

  // Enforce payload limits to prevent resource exhaustion
  const MAX_FILES = 50;
  const MAX_FILE_BYTES = 500_000;       // 500 KB per file
  const MAX_TOTAL_BYTES = 5_000_000;    // 5 MB total

  if (!github_pat?.trim()) {
    return NextResponse.json({ error: 'GitHub Personal Access Token is required' }, { status: 400 });
  }
  if (!name?.trim()) {
    return NextResponse.json({ error: 'Repository name is required' }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `Too many files — limit is ${MAX_FILES}` }, { status: 400 });
  }
  const totalBytes = files.reduce((sum: number, f: GitHubFile) => sum + (f.content?.length ?? 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: 'Total file content exceeds 5 MB limit' }, { status: 400 });
  }
  for (const f of files) {
    if ((f.content?.length ?? 0) > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: `File "${f.path}" exceeds the 500 KB per-file limit` },
        { status: 400 },
      );
    }
  }

  // Sanitize repo name: lowercase, replace spaces with hyphens, strip special chars
  const safeRepoName = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '');
  if (!safeRepoName) {
    return NextResponse.json({ error: 'Repository name contains no valid characters' }, { status: 400 });
  }

  // Validate PAT and get the authenticated user's login
  const meRes = await ghFetch('https://api.github.com/user', github_pat, 'GET');
  if (!meRes.ok) {
    const msg =
      meRes.status === 401
        ? 'Invalid GitHub token. Use classic PAT scope `repo`, or fine-grained token with Contents (RW), Pages (RW), and Metadata (Read).'
        : (meRes.data?.message as string) || 'Failed to authenticate with GitHub';
    return NextResponse.json({ error: msg }, { status: 401 });
  }
  const owner = meRes.data.login as string;

  // Create the repository
  const createRes = await ghFetch('https://api.github.com/user/repos', github_pat, 'POST', {
    name: safeRepoName,
    description: description?.trim() || `Created by DeplAI`,
    private: is_private ?? false,
    auto_init: false,
  });

  if (!createRes.ok) {
    const msg = (createRes.data?.message as string) || 'Failed to create repository';
    const errors = createRes.data?.errors as Array<{ message?: string }> | undefined;
    const detail = errors?.[0]?.message || msg;
    return NextResponse.json({ error: detail }, { status: 422 });
  }

  // Push each file via the GitHub Contents API
  const pushed: string[] = [];
  const failed: { path: string; reason: string }[] = [];

  for (const file of files) {
    if (!file?.path || typeof file.content !== 'string') continue;

    // Sanitize path: strip leading slashes, no ..
    const safePath = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!safePath || safePath.includes('..')) {
      failed.push({ path: file.path, reason: 'unsafe path' });
      continue;
    }

    try {
      const encoded = Buffer.from(file.content, 'utf-8').toString('base64');
      const pushRes = await ghFetch(
        `https://api.github.com/repos/${owner}/${safeRepoName}/contents/${safePath}`,
        github_pat,
        'PUT',
        { message: `feat: add ${safePath}`, content: encoded },
      );
      if (pushRes.ok) {
        pushed.push(safePath);
      } else {
        failed.push({ path: safePath, reason: (pushRes.data?.message as string) || 'unknown' });
      }
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : 'network error';
      failed.push({ path: safePath, reason });
    }
  }

  // Optionally enable GitHub Pages (only works for repos with an index.html)
  let pagesUrl: string | null = null;
  let pagesError: string | null = null;
  if (enable_pages) {
    const hasIndexHtml = files.some(f => {
      const p = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
      return p === 'index.html' || p.endsWith('/index.html');
    });
    if (hasIndexHtml) {
      try {
        const pageRes = await ghFetch(
          `https://api.github.com/repos/${owner}/${safeRepoName}/pages`,
          github_pat,
          'POST',
          { source: { branch: 'main', path: '/' } },
        );
        // 201 = created, 409 = already enabled
        if (pageRes.ok || pageRes.status === 409) {
          pagesUrl = `https://${owner}.github.io/${safeRepoName}`;
        } else {
          pagesError = (pageRes.data?.message as string) || 'GitHub Pages API rejected the request.';
        }
      } catch {
        pagesError = 'Network error while enabling GitHub Pages.';
      }
    } else {
      pagesError = 'No root index.html found, so GitHub Pages could not be enabled.';
    }
  }

  return NextResponse.json({
    repo_url: `https://github.com/${owner}/${safeRepoName}`,
    owner,
    repo_name: safeRepoName,
    pushed,
    failed,
    pages_url: pagesUrl,
    pages_error: pagesError,
  });
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronRight, Code2, FileCode2, Folder, GitBranch, GitPullRequest, Loader2, LockKeyhole, Search, Sparkles, Square } from 'lucide-react';
import type { UiuxFile, UiuxProject, UiuxRepository, UiuxRun } from './uiux-workspace-types';
import { clearUiuxMemory, readUiuxMemory, saveUiuxMemory } from './uiux-client-memory';

const activeRun = (run: UiuxRun | null) => run?.status === 'queued' || run?.status === 'running';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please retry.';
const wasAborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store' });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error || payload?.detail;
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${response.status}). Please retry.`);
  }
  return payload as T;
}

type TreeNode = { name: string; path: string; file?: UiuxFile; children: Map<string, TreeNode> };
function makeTree(files: UiuxFile[]) {
  const root: TreeNode = { name: '', path: '', children: new Map() };
  for (const file of files) {
    let node = root;
    const parts = file.path.split('/');
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join('/');
      if (!node.children.has(name)) node.children.set(name, { name, path, children: new Map() });
      node = node.children.get(name)!;
      if (index === parts.length - 1) node.file = file;
    });
  }
  return root;
}

function FileTree({ node, depth = 0, selected, changed, expanded, searching, onToggle, onSelect }: {
  node: TreeNode; depth?: number; selected: string; changed: Set<string>; expanded: Set<string>; searching: boolean;
  onToggle: (path: string) => void; onSelect: (path: string) => void;
}) {
  return <ul className={depth === 0 ? 'space-y-0.5' : ''}>
    {[...node.children.values()].sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name)).map((child) => {
      const isFolder = !child.file;
      const isOpen = searching || expanded.has(child.path);
      return <li key={child.path}>
        <button type="button" onClick={() => isFolder ? onToggle(child.path) : onSelect(child.path)}
          aria-expanded={isFolder ? isOpen : undefined} aria-current={!isFolder && selected === child.path ? 'true' : undefined}
          title={child.file ? `${child.path}${child.file.editable ? '' : ' · Protected from edits'}` : child.path}
          className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-xs transition-colors hover:bg-black/5 ${selected === child.path ? 'bg-black/7 font-medium text-black' : 'text-neutral-600'}`}
          style={{ paddingLeft: `${10 + depth * 14}px` }}>
          {isFolder ? <>{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Folder size={14} /></> : <FileCode2 size={14} className="ml-5 shrink-0" />}
          <span className="truncate">{child.name}</span>
          {changed.has(child.path) && <span className="ml-auto text-[10px] font-semibold" aria-label="Modified">M</span>}
          {child.file && !child.file.editable && <LockKeyhole size={10} className="ml-auto shrink-0 text-neutral-400" aria-label="Protected" />}
        </button>
        {isFolder && isOpen && <FileTree node={child} depth={depth + 1} selected={selected} changed={changed} expanded={expanded} searching={searching} onToggle={onToggle} onSelect={onSelect} />}
      </li>;
    })}
  </ul>;
}

// A bounded line diff: preserve common edges, then show the changed region explicitly.
function changedLines(before: string, after: string) {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  return {
    removed: oldLines.slice(prefix, oldLines.length - suffix),
    added: newLines.slice(prefix, newLines.length - suffix),
    leading: oldLines.slice(Math.max(0, prefix - 3), prefix),
    trailing: oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + 3),
    line: prefix + 1,
  };
}

function CodeView({ content }: { content: string }) {
  return <pre className="min-w-max p-5 text-[12px] leading-6"><code>{content.split('\n').map((line, index) => <span key={index} className="block"><span aria-hidden="true" className="mr-6 inline-block w-8 select-none text-right text-neutral-400">{index + 1}</span>{line || ' '}</span>)}</code></pre>;
}

export function UiuxWorkspace({ initialProjectId = '' }: { initialProjectId?: string }) {
  const [projects, setProjects] = useState<UiuxProject[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [projectsError, setProjectsError] = useState('');
  const [health, setHealth] = useState<{ available: boolean; detail?: string; user_id?: string } | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => { setProjectId(initialProjectId); }, [initialProjectId]);
  useEffect(() => {
    const controller = new AbortController();
    setProjectsError('');
    void request<{ projects: UiuxProject[] }>('/api/uiux/projects', { signal: controller.signal })
      .then((payload) => setProjects(payload.projects || []))
      .catch((error) => { if (!wasAborted(error)) setProjectsError(errorText(error)); });
    void request<{ available: boolean; detail?: string; user_id?: string }>('/api/uiux/health', { signal: controller.signal })
      .then(setHealth).catch((error) => { if (!wasAborted(error)) setHealth({ available: false, detail: errorText(error) }); });
    return () => controller.abort();
  }, [reload]);

  return <section className="flex h-full min-h-[640px] flex-col bg-[#faf9f6] font-sans text-neutral-950">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-200 bg-white px-5 py-4">
      <div className="flex min-w-0 flex-wrap items-center gap-3"><span className="flex size-8 items-center justify-center rounded-lg bg-black text-white"><Code2 size={17} /></span><h1 className="text-sm font-semibold">UI/UX Agent</h1><span className="text-neutral-300">/</span>
        <label className="sr-only" htmlFor="uiux-project">Repository</label><select id="uiux-project" value={projectId} onChange={(event) => setProjectId(event.target.value)} className="max-w-[300px] rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs focus:outline-2 focus:outline-black">
          <option value="">Select a repository</option>{projectId && !projects.some((item) => item.id === projectId) && <option value={projectId}>Selected repository</option>}{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-[#faf9f6] px-2.5 py-1 text-[10px] font-medium"><Sparkles size={11} /> Platform OpenRouter · Free models only</span>
    </header>
    {projectsError && <div role="alert" className="border-b border-neutral-200 px-5 py-3 text-xs">{projectsError} <button type="button" onClick={() => setReload((value) => value + 1)} className="underline">Retry</button></div>}
    {health && !health.available && <div role="status" className="border-b border-neutral-200 bg-[#f4efe5] px-5 py-3 text-xs">{health.detail || 'The UI/UX service is unavailable.'} <button type="button" className="underline" onClick={() => setReload((value) => value + 1)}>Check again</button></div>}
    {projectId ? health?.user_id ? <RepositoryWorkspace key={`${health.user_id}:${projectId}`} userId={String(health.user_id)} projectId={projectId} available={health.available === true} /> : <p role="status" className="m-auto p-6 text-sm text-neutral-500">{health ? 'Sign in to open your repository workspace.' : 'Loading your workspace…'}</p> : <div className="m-auto max-w-lg px-6 py-20 text-center"><Code2 size={32} className="mx-auto mb-5 text-neutral-400" /><h2 className="text-2xl font-semibold tracking-tight">A fresh look for your repository.</h2><p className="mt-3 text-sm leading-6 text-neutral-500">Select a connected codebase, describe the design you want, and review the proposed changes before creating a pull request.</p><a href="/dashboard" className="mt-6 inline-block rounded-md border border-neutral-200 bg-white px-4 py-2 text-xs font-medium">Connect a repository</a></div>}
  </section>;
}

function RepositoryWorkspace({ projectId, userId, available }: { projectId: string; userId: string; available: boolean }) {
  const [repository, setRepository] = useState<UiuxRepository | null>(null);
  const [repositoryLoading, setRepositoryLoading] = useState(true);
  const [run, setRun] = useState<UiuxRun | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [selected, setSelected] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(new Set(['src', 'app', 'components', 'pages', 'public', 'styles']));
  const [tab, setTab] = useState<'source' | 'changes'>('source');
  const [version, setVersion] = useState<'before' | 'after' | 'diff'>('diff');
  const [prompt, setPrompt] = useState('');
  const [scopeToFile, setScopeToFile] = useState(false);
  const [busy, setBusy] = useState<'start' | 'cancel' | 'pr' | null>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [reload, setReload] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [history, setHistory] = useState<UiuxRun[]>([]);
  const [memoryError, setMemoryError] = useState('');
  const [clearingMemory, setClearingMemory] = useState(false);
  const memoryWrites = useRef<Promise<unknown>>(Promise.resolve());
  const memoryGeneration = useRef(0);
  const actionRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const locked = useRef(false);
  const running = activeRun(run);
  const changes = useMemo(() => run?.changes || [], [run?.changes]);
  const changedPaths = useMemo(() => new Set(changes.map((change) => change.path)), [changes]);
  const selectedChange = changes.find((change) => change.path === selected);
  const selectedFile = repository?.files.find((file) => file.path === selected);
  const tree = useMemo(() => makeTree((repository?.files || []).filter((file) => file.path.toLowerCase().includes(search.toLowerCase()))), [repository, search]);
  const diff = useMemo(() => selectedChange ? changedLines(selectedChange.before, selectedChange.after) : null, [selectedChange]);

  useEffect(() => () => { generation.current++; actionRef.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setRepositoryLoading(true);
    void request<UiuxRepository>(`/api/uiux/repository?project_id=${encodeURIComponent(projectId)}`, { signal: controller.signal }).then((payload) => {
      setRepository(payload);
      setError('');
    }).catch((failure) => { if (!wasAborted(failure)) setError(errorText(failure)); }).finally(() => { if (!controller.signal.aborted) setRepositoryLoading(false); });
    return () => controller.abort();
  }, [projectId, reload]);

  useEffect(() => {
    const controller = new AbortController();
    void readUiuxMemory(userId, projectId).then((memory) => {
      if (!memory || controller.signal.aborted) return;
      setPrompt(memory.prompt || ''); setSelected(memory.selected || ''); setHistory(memory.history || []);
      const remembered = memory.history.find(item => item.run_id === memory.latestRunId) || null;
      setRun(remembered);
      if (remembered?.changes?.length) setTab('changes');
      // The normal progress poll reconciles active runs only. Completed history
      // is browser-owned and remains readable without an operational server run.
    }).catch((failure) => { if (!controller.signal.aborted) setMemoryError(errorText(failure)); }).finally(() => { if (!controller.signal.aborted) setRestoring(false); });
    return () => controller.abort();
  }, [projectId, userId]);

  useEffect(() => {
    if (restoring || clearingMemory) return;
    const currentGeneration = memoryGeneration.current;
    let disposed = false;
    const persist = () => {
      memoryWrites.current = memoryWrites.current.catch(() => undefined).then(async () => {
        if (currentGeneration !== memoryGeneration.current) return;
        const savedHistory = await saveUiuxMemory(userId, projectId, { prompt, selected, run });
        if (!disposed && currentGeneration === memoryGeneration.current) { setHistory(savedHistory); setMemoryError(''); }
      }).catch((failure) => { if (!disposed) setMemoryError(errorText(failure)); });
    };
    const timer = window.setTimeout(persist, 300);
    return () => { disposed = true; window.clearTimeout(timer); persist(); };
  }, [projectId, userId, prompt, selected, run, restoring, clearingMemory]);

  async function clearMemory() {
    if (running || busy || clearingMemory) return;
    setClearingMemory(true); memoryGeneration.current++;
    try {
      await memoryWrites.current;
      await clearUiuxMemory(userId, projectId);
      setHistory([]); setRun(null); setPrompt(''); setSelected(''); setReviewed(false); setTab('source'); setMemoryError('');
    } catch (failure) { setMemoryError(errorText(failure)); }
    finally { setClearingMemory(false); }
  }

  useEffect(() => {
    if (!run?.run_id || !running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const runId = run.run_id;
    const poll = async () => {
      const currentGeneration = generation.current;
      try {
        const payload = await request<UiuxRun>(`/api/uiux/runs/${encodeURIComponent(runId)}?project_id=${encodeURIComponent(projectId)}`, { signal: controller.signal });
        if (controller.signal.aborted || generation.current !== currentGeneration) return;
        setRun(payload); setPollError('');
        if (!activeRun(payload)) {
          if (payload.changes?.length) { setTab('changes'); setSelected(payload.changes[0].path); }
          return;
        }
      } catch (failure) { if (!controller.signal.aborted) setPollError(`Progress connection interrupted. Reconnecting… ${errorText(failure)}`); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 800);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, run?.run_id, running, busy]);

  useEffect(() => {
    if (!selected || tab !== 'source') return;
    const controller = new AbortController();
    setFileLoading(true); setFileError(''); setFileContent('');
    void request<{ content: string }>(`/api/uiux/file?project_id=${encodeURIComponent(projectId)}&path=${encodeURIComponent(selected)}`, { signal: controller.signal })
      .then((payload) => { if (!controller.signal.aborted) setFileContent(payload.content); })
      .catch((failure) => { if (!wasAborted(failure)) setFileError(errorText(failure)); })
      .finally(() => { if (!controller.signal.aborted) setFileLoading(false); });
    return () => controller.abort();
  }, [projectId, selected, tab]);

  async function act(action: 'start' | 'cancel' | 'pr') {
    if (locked.current) return;
    locked.current = true;
    const controller = new AbortController();
    actionRef.current = controller;
    const actionGeneration = ++generation.current;
    setBusy(action); setError('');
    try {
      if (action === 'pr' && run) {
        const payload = await request<{ url: string }>(`/api/uiux/runs/${encodeURIComponent(run.run_id)}/pr`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: projectId }), signal: controller.signal });
        if (generation.current === actionGeneration) setRun((previous) => previous ? { ...previous, pr_url: payload.url } : previous);
      } else {
        const payload = await request<UiuxRun>(action === 'start' ? '/api/uiux/runs' : `/api/uiux/runs/${encodeURIComponent(run!.run_id)}?project_id=${encodeURIComponent(projectId)}`, {
          method: action === 'start' ? 'POST' : 'DELETE', headers: { 'Content-Type': 'application/json' },
          ...(action === 'start' ? { body: JSON.stringify({ project_id: projectId, prompt: prompt.trim(), ...(scopeToFile && selectedFile?.editable ? { scope: [selected] } : {}) }) } : {}), signal: controller.signal,
        });
        if (generation.current !== actionGeneration) return;
        const nextRun = { ...payload, prompt: payload.prompt || (action === 'start' ? prompt.trim() : run?.prompt) };
        setRun(nextRun); setReviewed(false); setPollError('');
        setHistory(previous => [nextRun, ...(run && run.run_id !== nextRun.run_id ? [run] : []), ...previous.filter(item => item.run_id !== nextRun.run_id && item.run_id !== run?.run_id)]);
        if (action === 'start') { setPrompt(''); setTab('source'); }
      }
    } catch (failure) { if (!wasAborted(failure) && generation.current === actionGeneration) setError(errorText(failure)); }
    finally { if (generation.current === actionGeneration) { setBusy(null); locked.current = false; } }
  }

  function selectFile(path: string) { setSelected(path); if (!changedPaths.has(path)) setTab('source'); }
  const notifications = [...(repository?.warnings || []), ...(run?.warnings || []), ...(run?.conflicts || [])];
  const isGitHubRepository = Boolean(repository?.project.owner && repository.project.repo);
  const canCreatePr = isGitHubRepository && run?.status === 'completed' && changes.length > 0 && !(run.conflicts?.length) && reviewed && !busy;

  if (restoring) return <div role="status" className="m-auto p-6 text-xs text-neutral-500">Restoring browser workspace memory…</div>;

  return <>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-5 py-2 text-[11px] text-neutral-500"><span className="inline-flex items-center gap-1.5"><GitBranch size={12} />{repository?.project.branch || 'Repository branch'}{repository?.source_sha && <span className="ml-2 font-mono">{repository.source_sha.slice(0, 7)}</span>}</span><span>Presentation changes · Review before publishing</span></div>
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[210px_minmax(0,1fr)_320px] xl:grid-cols-[230px_minmax(0,1fr)_350px]">
      <aside aria-label="Repository files" className="flex max-h-64 min-h-0 flex-col border-b border-neutral-200 bg-[#f8f7f4] lg:max-h-none lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between px-4 pt-4 text-xs font-medium"><h2>Files</h2><span className="font-normal text-neutral-400">{repository?.files.length ?? 0}</span></div>
        <div className="relative m-3"><Search size={13} className="absolute top-2.5 left-2.5 text-neutral-400" /><input aria-label="Search repository files" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a file…" className="w-full rounded-md border border-neutral-200 bg-white py-2 pr-2 pl-8 text-xs outline-black" /></div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-4">{repositoryLoading ? <p className="p-3 text-xs text-neutral-500">Loading repository…</p> : repository ? <FileTree node={tree} selected={selected} changed={changedPaths} expanded={expanded} searching={Boolean(search)} onSelect={selectFile} onToggle={(path) => setExpanded((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; })} /> : <button type="button" onClick={() => setReload((value) => value + 1)} className="m-2 text-xs underline">Retry repository</button>}</div>
        <p className="border-t border-neutral-200 px-4 py-3 text-[10px] leading-4 text-neutral-500"><LockKeyhole size={10} className="mr-1 inline" /> Protected files can be inspected. Editing is limited to presentation code.</p>
      </aside>
      <main className="flex min-h-[380px] min-w-0 flex-col overflow-hidden bg-white">
        <div className="flex shrink-0 items-center gap-5 border-b border-neutral-200 px-5" aria-label="File view">
          {(['source', 'changes'] as const).map((item) => <button key={item} type="button" onClick={() => { setTab(item); if (item === 'changes' && !selectedChange && changes[0]) setSelected(changes[0].path); }} aria-pressed={tab === item} className={`border-b-2 py-3 text-xs capitalize ${tab === item ? 'border-black font-medium text-black' : 'border-transparent text-neutral-500'}`}>{item}{item === 'changes' && <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px]">{changes.length}</span>}</button>)}
        </div>
        {tab === 'changes' && changes.length > 0 && <div className="flex flex-wrap gap-2 border-b border-neutral-100 p-3">{changes.map((change) => <button key={change.path} type="button" onClick={() => setSelected(change.path)} className={`max-w-full truncate rounded border px-2 py-1 text-[10px] ${selected === change.path ? 'border-black bg-neutral-100' : 'border-neutral-200'}`}>{change.path}</button>)}</div>}
        {selected && (tab === 'source' || selectedChange) && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 bg-neutral-50 px-5 py-2"><span className="min-w-0 break-all font-mono text-[11px] text-neutral-500">{selected}</span>{tab === 'changes' && <div className="flex gap-1">{(['diff', 'before', 'after'] as const).map((item) => <button type="button" key={item} aria-pressed={version === item} onClick={() => setVersion(item)} className={`rounded px-2 py-1 text-[10px] capitalize ${version === item ? 'bg-black text-white' : 'text-neutral-500'}`}>{item}</button>)}</div>}</div>}
        <div className="min-h-0 flex-1 overflow-auto">
          {tab === 'source' ? selected ? fileLoading ? <p role="status" className="p-5 text-xs text-neutral-500">Loading file…</p> : fileError ? <p role="alert" className="p-5 text-xs">{fileError}</p> : <CodeView content={fileContent} /> : <EmptyEditor title="Your code, a new perspective." text="Explore the repository on the left. Tell the agent what should look or feel different to start a design task." /> : selectedChange && diff ? version === 'diff' ? <div className="font-mono text-[12px] leading-6"><p className="border-b border-neutral-100 px-5 py-2 text-[10px] text-neutral-500">Changed region near line {diff.line} · {diff.removed.length} removed / {diff.added.length} added</p><pre className="min-w-max py-3">{diff.leading.map((line, i) => <div key={`l${i}`} className="px-5 text-neutral-400">  {line}</div>)}{diff.removed.map((line, i) => <div key={`r${i}`} className="bg-rose-50 px-5 text-rose-900">− {line}</div>)}{diff.added.map((line, i) => <div key={`a${i}`} className="bg-emerald-50 px-5 text-emerald-900">+ {line}</div>)}{diff.trailing.map((line, i) => <div key={`t${i}`} className="px-5 text-neutral-400">  {line}</div>)}</pre></div> : <CodeView content={selectedChange[version]} /> : <EmptyEditor title="Changes will appear here." text="The agent prepares a proposal against the repository snapshot. Review each changed file before creating a pull request." />}
        </div>
        <div className="border-t border-neutral-200 px-5 py-2 text-[10px] text-neutral-400">Source review available. Live preview requires an isolated build environment.</div>
      </main>
      <aside aria-label="Design conversation" className="flex min-h-[480px] min-w-0 flex-col border-t border-neutral-200 bg-[#faf9f6] lg:min-h-0 lg:border-t-0 lg:border-l">
        <div className="space-y-2 border-b border-neutral-200 px-4 py-2">
          <div className="flex items-center justify-between gap-2 text-[10px] text-neutral-500"><span>Memory saved in this browser</span><button type="button" disabled={running || Boolean(busy) || clearingMemory} onClick={() => void clearMemory()} className="underline disabled:opacity-40">{clearingMemory ? 'Clearing…' : 'Clear memory'}</button></div>
          {history.length > 0 && <><label htmlFor="uiux-history" className="sr-only">Browser run history</label><select id="uiux-history" value={run?.run_id || ''} disabled={running || Boolean(busy) || clearingMemory} onChange={(event) => { const previous = history.find(item => item.run_id === event.target.value); if (previous) { setRun(previous); setReviewed(false); setTab(previous.changes?.length ? 'changes' : 'source'); if (previous.changes?.[0]) setSelected(previous.changes[0].path); } }} className="w-full rounded border border-neutral-200 bg-white p-2 text-[10px]"><option value="">Previous tasks</option>{history.map(item => <option value={item.run_id} key={item.run_id}>{item.status} · {item.prompt?.slice(0, 65) || item.run_id}</option>)}</select></>}
          {memoryError && <p role="alert" className="text-xs leading-5 text-rose-900">{memoryError}</p>}
        </div>
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3"><h2 className="flex items-center gap-2 text-xs font-medium"><Sparkles size={14} /> Design assistant</h2><span role="status" className="flex items-center gap-1 text-[10px] text-neutral-500">{running && <Loader2 size={11} className="animate-spin" />}{restoring ? 'Restoring…' : run?.status || 'Ready'}</span></div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          {history.filter(item => item.run_id !== run?.run_id).slice().reverse().map(item => <article key={item.run_id} className="space-y-2 border-b border-neutral-200 pb-4" aria-label="Previous design task">
            <p className="rounded-xl border border-neutral-200 bg-white p-3 text-xs leading-5 whitespace-pre-wrap">{item.prompt || 'Previous design task'}</p>
            <p className="text-[10px] text-neutral-500">{item.status}</p>
            {(item.summary || item.error) && <p className="text-xs leading-5 whitespace-pre-wrap">{item.error || item.summary}</p>}
          </article>)}
          {!run && <div><p className="text-sm leading-6">What would you like to change?</p><p className="mt-2 text-xs leading-5 text-neutral-500">Describe the screen, the style, and what should stay the same. The agent explores the codebase and checks proposed edits for behavior changes.</p><div className="mt-5 space-y-2">{['Make the dashboard cleaner with better spacing and typography.', 'Improve the navigation for mobile screens.', 'Give the landing page a warm, minimal visual style.'].map((suggestion) => <button key={suggestion} type="button" onClick={() => setPrompt(suggestion)} className="w-full rounded-lg border border-neutral-200 bg-white p-3 text-left text-xs leading-5 text-neutral-600 hover:border-neutral-400">{suggestion}</button>)}</div></div>}
          {run?.prompt && <div className="rounded-xl border border-neutral-200 bg-white p-3 text-xs leading-5 whitespace-pre-wrap">{run.prompt}</div>}
          {run && <ol aria-label="Agent progress" className="space-y-3">{run.events?.map((event) => <li key={`${event.sequence}-${event.type}`} className="flex gap-2 text-xs leading-5"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-neutral-400" /><span className="break-words">{event.message}</span></li>)}</ol>}
          {run?.summary && <p className="text-xs leading-5 whitespace-pre-wrap">{run.summary}</p>}
          {pollError && <p role="status" className="text-xs leading-5 text-neutral-600">{pollError}</p>}
          {(error || run?.error) && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-900">{error || run?.error}</div>}
          {notifications.length > 0 && <details className="rounded-lg border border-neutral-200 bg-white p-3" open={Boolean(run?.conflicts?.length)}><summary className="cursor-pointer text-xs font-medium">Constraints & conflicts ({notifications.length})</summary><ul className="mt-2 space-y-2 text-xs leading-5 text-neutral-600">{notifications.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
          {run?.status === 'completed' && changes.length > 0 && <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-3"><p className="flex items-center gap-2 text-xs font-medium"><Check size={14} />{changes.length} files ready for review</p>{run.pr_url ? <a href={run.pr_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-xs underline"><GitPullRequest size={13} />View pull request</a> : <><label className="flex items-start gap-2 text-[11px] leading-5 text-neutral-600"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} className="mt-1 accent-black" />I reviewed the changes and want to open a pull request.</label><button type="button" disabled={!canCreatePr} onClick={() => void act('pr')} className="flex w-full items-center justify-center gap-2 rounded-md bg-black px-3 py-2 text-xs text-white disabled:opacity-40"><GitPullRequest size={13} />{busy === 'pr' ? 'Creating pull request…' : 'Create pull request'}</button></>}</div>}
          {run?.status === 'completed' && changes.length > 0 && !isGitHubRepository && <p className="text-xs leading-5 text-neutral-500">This project has no connected GitHub repository. Download the patch to apply these changes locally.</p>}
          {run?.status === 'completed' && changes.length > 0 && <a href={`/api/uiux/runs/${encodeURIComponent(run.run_id)}/patch?project_id=${encodeURIComponent(projectId)}`} className="inline-block text-xs text-neutral-600 underline" download>Download patch</a>}
          {run?.usage && <p className="text-[10px] text-neutral-400">{run.usage.requests ?? 0} model requests · {(run.usage.input_tokens ?? 0) + (run.usage.output_tokens ?? 0)} tokens · Free models</p>}
        </div>
        <form className="border-t border-neutral-200 p-3" onSubmit={(event) => { event.preventDefault(); if (prompt.trim() && !busy && !running && !restoring && repository && available) void act('start'); }}>
          <label htmlFor="uiux-prompt" className="sr-only">Describe your UI/UX change</label><textarea id="uiux-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={6000} rows={4} placeholder={running ? 'You can draft your next task while the agent works…' : 'Describe your design change…'} className="w-full resize-y rounded-lg border border-neutral-200 bg-white p-3 text-xs leading-5 outline-black" />
          {selectedFile?.editable && <label className="mt-2 flex items-start gap-2 text-[10px] leading-4 text-neutral-500"><input type="checkbox" checked={scopeToFile} onChange={(event) => setScopeToFile(event.target.checked)} className="mt-0.5 accent-black" /><span className="break-all">Limit edits to {selected}</span></label>}
          <div className="mt-3 flex items-center justify-between gap-2"><span className="text-[10px] text-neutral-400">{run && !running ? 'New tasks start from the repository branch.' : 'Design → Edit → Review'}</span>{running ? <button type="button" disabled={Boolean(busy)} onClick={() => void act('cancel')} className="inline-flex items-center gap-2 rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs disabled:opacity-40"><Square size={11} />{busy === 'cancel' ? 'Stopping…' : 'Stop'}</button> : <button type="submit" disabled={!prompt.trim() || Boolean(busy) || restoring || !repository || !available} className="flex size-8 shrink-0 items-center justify-center rounded-md bg-black text-white disabled:opacity-30" aria-label={busy === 'start' ? 'Starting design task' : 'Start design task'}>{busy === 'start' ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={16} />}</button>}</div>
        </form>
      </aside>
    </div>
  </>;
}

function EmptyEditor({ title, text }: { title: string; text: string }) {
  return <div className="flex h-full min-h-[300px] items-center justify-center p-8"><div className="max-w-sm text-center"><div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-xl border border-neutral-200 bg-[#faf9f6]"><Code2 size={22} className="text-neutral-400" /></div><h2 className="text-lg font-medium tracking-tight">{title}</h2><p className="mt-3 text-xs leading-6 text-neutral-500">{text}</p></div></div>;
}

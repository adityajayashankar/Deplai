'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLLM } from '@/lib/llm-context';
import { useScan } from '@/lib/scan-context';
import { 
  Shield, Send, ChevronDown, ChevronRight, Github, 
  ExternalLink, Code, Copy, Check, Trash2, Plus, 
  MessageSquare, Menu, Activity
} from 'lucide-react';

export type ScanType = 'sast' | 'sca' | 'all';

export interface AgentChatProject {
  id: string;
  name?: string;
  repo?: string;
  owner?: string;
  installationId?: string;
  type: 'local' | 'github';
}

// Alias for drop-in compatibility with the previous ScanChat import
export type ScanChatProject = AgentChatProject;

interface AgentChatProps {
  initialPrompt?: string;
  initialProject?: AgentChatProject;
  projects: AgentChatProject[];
  activeScanIds: string[];
  onStart: (projectId: string, projectName: string, scanType: ScanType) => void;
  onDismiss: () => void;
  /** Called when the user starts a brand-new session (clears history) */
  onSessionClear?: () => void;
  /** Accepted for API compatibility; agent handles both types */
  githubOnly?: boolean;
  /** When provided, the parent controls the sessions sidebar visibility */
  isSidebarOpen?: boolean;
  /** When provided, load this session on mount (e.g. clicked from the left sidebar) */
  initialSessionId?: string;
  /** Called whenever the active session ID changes (including null for new/cleared sessions) */
  onCurrentSessionIdChange?: (id: string | null) => void;
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface ChatSession {
  id: string;
  title: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

interface ApiMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface GeneratedFile {
  path: string;
  content: string;
}

interface RepoResult {
  repo_url: string;
  pages_url: string | null;
  pages_error?: string | null;
  pushed: string[];
  failed: { path: string; reason: string }[];
}

type DisplayRole = 'user' | 'assistant' | 'progress' | 'repo_result' | 'scan_started' | 'scan_completed' | 'remediation_started';

interface DisplayMessage {
  id: number;
  role: DisplayRole;
  content: string;
  generatedFiles?: GeneratedFile[];
  repoResult?: RepoResult;
  scanProjectId?: string;
}

interface ActivityEntry {
  id: number;
  timestamp: Date;
  type: 'thinking' | 'tool_start' | 'tool_done' | 'error' | 'info';
  icon: React.ReactNode;
  label: string;
}

// ── Helper: file icon by extension ────────────────────────────────────────────

function FileIcon({ path, className = "w-4 h-4" }: { path: string, className?: string }) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['py', 'js', 'jsx', 'ts', 'tsx'].includes(ext)) return <Code className={`${className} text-blue-400`} />;
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return <Code className={`${className} text-amber-400`} />;
  if (['md', 'txt'].includes(ext)) return <Code className={`${className} text-zinc-400`} />;
  return <Code className={`${className} text-zinc-400`} />;
}

// ── File tree card ─────────────────────────────────────────────────────────────

function FilePreview({ files }: { files: GeneratedFile[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  function copyFile(path: string, content: string) {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(path);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  return (
    <div className="mt-3 rounded-xl border border-white/8 bg-zinc-900 shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-white/8 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Code className="w-3.5 h-3.5 text-indigo-400" />
          <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
            {files.length} file{files.length !== 1 ? 's' : ''} generated
          </span>
        </div>
        <span className="text-[10px] text-zinc-600">click to expand</span>
      </div>
      <ul className="divide-y divide-white/5 max-h-80 overflow-y-auto custom-scrollbar">
        {files.map(file => (
          <li key={file.path}>
            <button
              className="w-full flex items-center gap-2.5 px-4 py-2.5 hover:bg-white/5 transition text-left"
              onClick={() => setExpanded(expanded === file.path ? null : file.path)}
            >
              <span className="shrink-0"><FileIcon path={file.path} /></span>
              <span className="font-mono text-xs text-zinc-200 flex-1 truncate">{file.path}</span>
              <span className="text-zinc-600 text-xs shrink-0">
                {file.content.split('\n').length}L
              </span>
              {expanded === file.path
                ? <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                : <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />}
            </button>
            {expanded === file.path && (
              <div className="relative border-t border-white/5 bg-[#0d1117]">
                <button
                  onClick={() => copyFile(file.path, file.content)}
                  className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 transition text-zinc-400 text-[10px]"
                  title="Copy"
                >
                  {copied === file.path ? <><Check className="w-3 h-3 text-emerald-400" /> <span className="text-emerald-400">Copied</span></> : <><Copy className="w-3 h-3" /> Copy</>}
                </button>
                <pre className="p-4 pr-16 text-[11px] font-mono text-zinc-300 overflow-x-auto max-h-64 leading-relaxed whitespace-pre">
                  {file.content}
                </pre>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Repo result card ───────────────────────────────────────────────────────────

function RepoResultCard({ result }: { result: RepoResult }) {
  return (
    <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Github className="w-4 h-4 text-emerald-400" />
        <a
          href={result.repo_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-semibold text-emerald-400 hover:text-emerald-300 hover:underline flex items-center gap-1"
        >
          {result.repo_url.replace('https://', '')}
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
      {result.pages_url && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400">GitHub Pages:</span>
          <a
            href={result.pages_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-sky-400 hover:underline flex items-center gap-1"
          >
            {result.pages_url.replace('https://', '')}
            <ExternalLink className="w-3 h-3" />
          </a>
          <span className="text-[10px] text-zinc-500">(may take ~30s to go live)</span>
        </div>
      )}
      {!result.pages_url && result.pages_error && (
        <div className="text-xs text-amber-300">
          GitHub Pages not enabled: {result.pages_error}
        </div>
      )}
      <div className="text-xs text-zinc-400">
        {result.pushed.length} file{result.pushed.length !== 1 ? 's' : ''} pushed
        {result.failed.length > 0 && (
          <span className="text-amber-400 ml-2">
            · {result.failed.length} failed
          </span>
        )}
      </div>
    </div>
  );
}

// ── Inline text renderer (bold, italic, inline code) ────────────────────────────

function InlineContent({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**'))
          return <strong key={i} className="font-semibold text-white">{p.slice(2, -2)}</strong>;
        if (p.startsWith('`') && p.endsWith('`'))
          return <code key={i} className="px-1 py-0.5 rounded bg-white/10 text-[11px] font-mono text-indigo-300">{p.slice(1, -1)}</code>;
        if (p.startsWith('*') && p.endsWith('*') && p.length > 2)
          return <em key={i} className="italic text-zinc-300">{p.slice(1, -1)}</em>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

// ── Markdown message renderer ─────────────────────────────────────────────────

function MessageContent({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={`cb-${i}`} className="my-2 p-3 rounded-lg bg-black/50 border border-white/5 overflow-x-auto text-[11px] font-mono text-zinc-300 leading-relaxed whitespace-pre">
          {codeLines.join('\n')}
        </pre>
      );
      i++; // skip closing ```
      continue;
    }

    // H2
    if (line.startsWith('## ')) {
      elements.push(
        <p key={`h2-${i}`} className="text-sm font-bold text-white mt-3 mb-1 first:mt-0">
          <InlineContent text={line.slice(3)} />
        </p>
      );
      i++; continue;
    }

    // H3
    if (line.startsWith('### ')) {
      elements.push(
        <p key={`h3-${i}`} className="text-[13px] font-semibold text-zinc-200 mt-2 mb-0.5">
          <InlineContent text={line.slice(4)} />
        </p>
      );
      i++; continue;
    }

    // Bullet list
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`} className="my-1 space-y-0.5 pl-1">
          {items.map((item, j) => (
            <li key={j} className="text-sm text-zinc-300 leading-relaxed flex gap-1.5">
              <span className="text-zinc-600 shrink-0 mt-0.5 select-none">•</span>
              <span><InlineContent text={item} /></span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Numbered list
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s*/, ''));
        i++;
      }
      elements.push(
        <ol key={`ol-${i}`} className="my-1 space-y-0.5 pl-1">
          {items.map((item, j) => (
            <li key={j} className="text-sm text-zinc-300 leading-relaxed flex gap-1.5">
              <span className="text-zinc-600 shrink-0 font-mono text-xs mt-0.5 select-none w-4">{j + 1}.</span>
              <span><InlineContent text={item} /></span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
      elements.push(<hr key={`hr-${i}`} className="my-2 border-white/10" />);
      i++; continue;
    }

    // Blank line — small spacer
    if (line.trim() === '') {
      elements.push(<div key={`sp-${i}`} className="h-1.5" />);
      i++; continue;
    }

    // Regular paragraph
    elements.push(
      <p key={`p-${i}`} className="text-sm text-zinc-200 leading-relaxed">
        <InlineContent text={line} />
      </p>
    );
    i++;
  }

  return <div className="space-y-0.5">{elements}</div>;
}

// ── Sessions panel ────────────────────────────────────────────────────────────

interface SessionsPanelProps {
  sessions: ChatSession[];
  activeId: string | null;
  loading: boolean;
  onSelect: (session: ChatSession) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

function SessionsPanel({ sessions, activeId, loading, onSelect, onNew, onDelete }: SessionsPanelProps) {
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  // Close context menu on outside click or scroll
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, [ctxMenu]);

  return (
    <div className="flex flex-col h-full" style={{ minHeight: 0 }}>
      <div className="shrink-0 p-3 border-b border-white/8 space-y-2.5">
        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider px-0.5 select-none">Conversations</p>
        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-xs font-semibold transition-all shadow-sm shadow-indigo-900/40"
        >
          <Plus className="w-3.5 h-3.5" />
          New Chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1" style={{ minHeight: 0 }}>
        {loading ? (
          <p className="text-[10px] text-zinc-700 text-center mt-6">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-[10px] text-zinc-700 text-center mt-6 px-3">No chats yet — start one!</p>
        ) : (
          sessions.map(s => (
            <div
              key={s.id}
              className={`group relative flex items-start gap-2 px-3 py-2 cursor-pointer transition ${
                s.id === activeId ? 'bg-indigo-500/15' : 'hover:bg-white/5'
              }`}
              onClick={() => onSelect(s)}
              onContextMenu={e => { e.preventDefault(); setCtxMenu({ id: s.id, x: e.clientX, y: e.clientY }); }}
            >
              <MessageSquare className={`w-3 h-3 mt-0.5 shrink-0 ${
                s.id === activeId ? 'text-indigo-400' : 'text-zinc-600'
              }`} />
              <div className="flex-1 min-w-0">
                <p className={`text-[11px] leading-snug truncate ${
                  s.id === activeId ? 'text-white font-medium' : 'text-zinc-400'
                }`}>
                  {s.title}
                </p>
                <p className="text-[9px] text-zinc-700 mt-0.5">
                  {new Date(s.updated_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                  {s.message_count > 0 && ` · ${s.message_count} msgs`}
                </p>
              </div>
              <button
                onClick={e => { e.stopPropagation(); onDelete(s.id); }}
                title="Delete"
                className="shrink-0 p-0.5 rounded hover:text-red-400 text-zinc-600 hover:bg-red-400/10 transition"
              >
                <Trash2 className="w-2.5 h-2.5" />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          className="fixed z-9999 min-w-35 rounded-lg border border-white/10 bg-[#1a1a1d] shadow-xl py-1 text-sm"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          <button
            className="w-full flex items-center gap-2.5 px-3 py-2 text-red-400 hover:bg-red-500/10 transition text-left text-[12px]"
            onClick={() => { onDelete(ctxMenu.id); setCtxMenu(null); }}
          >
            <Trash2 className="w-3.5 h-3.5 shrink-0" />
            Delete chat
          </button>
        </div>
      )}

      <div className="shrink-0 border-t border-white/8 px-3 py-2">
        <p className="text-[9px] text-zinc-700">Max 50 sessions · 200 msgs each</p>
      </div>
    </div>
  );
}

// ── PAT input modal ────────────────────────────────────────────────────────────

interface PatInputProps {
  onSubmit: (pat: string) => void;
  onDismiss: () => void;
}

function PatInput({ onSubmit, onDismiss }: PatInputProps) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <span className="text-base shrink-0 mt-0.5">🔑</span>
        <div>
          <p className="text-sm font-semibold text-amber-300">GitHub Personal Access Token required</p>
          <p className="text-xs text-zinc-400 mt-1">
            To create the repo and deploy GitHub Pages, use either:
            {' '}<code className="bg-white/10 px-1 rounded text-xs">repo</code> (classic PAT) or fine-grained permissions for
            {' '}<code className="bg-white/10 px-1 rounded text-xs">Contents: RW</code>,{' '}
            <code className="bg-white/10 px-1 rounded text-xs">Pages: RW</code>,{' '}
            <code className="bg-white/10 px-1 rounded text-xs">Metadata: Read</code>.{' '}
            <a
              href="https://github.com/settings/tokens/new?scopes=repo&description=DeplAI"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:underline"
            >
              Generate one here ↗
            </a>
          </p>
        </div>
      </div>
      <input
        ref={ref}
        type="password"
        placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && value.trim()) onSubmit(value.trim()); }}
        className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/50"
      />
      <div className="flex gap-2">
        <button
          disabled={!value.trim()}
          onClick={() => { if (value.trim()) onSubmit(value.trim()); }}
          className="px-4 py-2 rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-semibold hover:bg-amber-500/30 transition disabled:opacity-40"
        >
          Use Token
        </button>
        <button
          onClick={onDismiss}
          className="px-4 py-2 rounded-lg bg-white/5 border border-white/8 text-zinc-400 text-xs font-semibold hover:bg-white/10 transition"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Workspace Preview Panel ────────────────────────────────────────────────────

interface WorkspacePreviewProps {
  activity: ActivityEntry[];
  files: GeneratedFile[];
  repoResult: RepoResult | null;
  busy: boolean;
  currentStep: string | null;
}

function WorkspacePreview({ activity, files, repoResult, busy, currentStep }: WorkspacePreviewProps) {
  const [tab, setTab] = useState<'files' | 'activity'>('files');
  const [selectedFile, setSelectedFile] = useState<GeneratedFile | null>(null);
  const [copied, setCopied] = useState(false);
  const activityBottomRef = useRef<HTMLDivElement>(null);

  const filePathsKey = files.map(f => f.path).join('|');
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (files.length > 0) {
      setSelectedFile(files[0]);
      setTab('files');
    } else {
      setSelectedFile(null);
    }
  }, [filePathsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    activityBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activity.length]);

  const statusColor: Record<ActivityEntry['type'], string> = {
    thinking: 'text-zinc-500',
    tool_start: 'text-indigo-400',
    tool_done: 'text-emerald-400',
    error: 'text-red-400',
    info: 'text-zinc-400',
  };

  return (
    <div className="flex flex-col h-full" style={{ minHeight: 0 }}>
      {/* Header */}
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-white/8">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Activity className="w-3 h-3 text-zinc-500" />
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Workspace</span>
          </div>
          {busy && (
            <span className="flex items-center gap-1 text-[10px] text-indigo-400 font-medium">
              <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-30" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              Working
            </span>
          )}
        </div>
        {currentStep && (
          <p className="text-[11px] text-zinc-500 mb-2 truncate leading-snug">{currentStep}</p>
        )}
        <div className="flex gap-1">
          {(['files', 'activity'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-1 rounded-md text-[11px] font-medium transition ${
                tab === t ? 'bg-white/10 text-white' : 'text-zinc-600 hover:text-zinc-400'
              }`}
            >
              {t === 'files' ? `Files${files.length ? ` (${files.length})` : ''}` : 'Activity'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Files tab ── */}
      {tab === 'files' && (
        <div className="flex flex-col flex-1 overflow-hidden" style={{ minHeight: 0 }}>
          {files.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
              {busy ? (
                <>
                  <svg className="w-8 h-8 text-indigo-500/40 animate-spin mb-3" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  <p className="text-xs text-zinc-600">Agent is working…</p>
                </>
              ) : (
                <>
                  <Code className="w-8 h-8 text-zinc-700 mb-3" />
                  <p className="text-xs text-zinc-600">No files yet</p>
                  <p className="text-[10px] text-zinc-700 mt-1">Ask the agent to build an app</p>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-1 overflow-hidden" style={{ minHeight: 0 }}>
              {/* File tree sidebar */}
              <div className="w-28 shrink-0 border-r border-white/5 overflow-y-auto py-1">
                {files.map(f => (
                  <button
                    key={f.path}
                    onClick={() => setSelectedFile(f)}
                    title={f.path}
                    className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-left transition ${
                      selectedFile?.path === f.path
                        ? 'bg-indigo-500/15 text-white'
                        : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                    }`}
                  >
                    <span className="text-xs shrink-0 leading-none"><FileIcon path={f.path} /></span>
                    <span className="text-[10px] font-mono truncate">{f.path.split('/').pop()}</span>
                  </button>
                ))}
              </div>
              {/* Code viewer */}
              <div className="flex flex-col flex-1 overflow-hidden" style={{ minHeight: 0 }}>
                {selectedFile && (
                  <>
                    <div className="shrink-0 flex items-center justify-between px-2 py-1.5 border-b border-white/5 bg-black/20">
                      <span className="text-[10px] font-mono text-zinc-500 truncate">{selectedFile.path}</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(selectedFile.content).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          });
                        }}
                        className="shrink-0 p-1 rounded hover:bg-white/10 text-zinc-600 hover:text-zinc-300 transition ml-1"
                      >
                        {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      </button>
                    </div>
                    <pre className="flex-1 overflow-auto p-3 text-[10px] font-mono text-zinc-300 leading-relaxed bg-[#0d1117] whitespace-pre">
                      {selectedFile.content}
                    </pre>
                  </>
                )}
              </div>
            </div>
          )}
          {/* Repo result strip */}
          {repoResult && (
            <div className="shrink-0 border-t border-white/8 p-3 space-y-1">
              <a
                href={repoResult.repo_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400 hover:text-emerald-300 hover:underline"
              >
                <Github className="w-3 h-3 shrink-0" />
                <span className="truncate">{repoResult.repo_url.replace('https://github.com/', '')}</span>
                <ExternalLink className="w-2.5 h-2.5 shrink-0" />
              </a>
              {repoResult.pages_url && (
                <a
                  href={repoResult.pages_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-[11px] text-sky-400 hover:underline"
                >
                  <span className="text-xs">🌐</span>
                  <span className="truncate">{repoResult.pages_url.replace('https://', '')}</span>
                  <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                </a>
              )}
              {!repoResult.pages_url && repoResult.pages_error && (
                <p className="text-[10px] text-amber-300">{repoResult.pages_error}</p>
              )}
              <p className="text-[10px] text-zinc-600">
                {repoResult.pushed.length} pushed{repoResult.failed.length > 0 ? ` · ${repoResult.failed.length} failed` : ''}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Activity tab ── */}
      {tab === 'activity' && (
        <div className="flex-1 overflow-y-auto py-2 px-3 space-y-2.5" style={{ minHeight: 0 }}>
          {activity.length === 0 ? (
            <p className="text-[11px] text-zinc-700 text-center mt-8">No activity yet</p>
          ) : (
            activity.map((entry, idx) => (
              <div key={entry.id} className="flex items-start gap-2">
                <div className="flex flex-col items-center shrink-0">
                  <span className={`mt-0.5 text-xs ${statusColor[entry.type]}`}>{entry.icon}</span>
                  {idx < activity.length - 1 && (
                    <div className="w-px flex-1 bg-white/8 mt-1" style={{ minHeight: 14 }} />
                  )}
                </div>
                <div className={`flex-1 min-w-0 pb-1 ${statusColor[entry.type]}`}>
                  <p className="text-[11px] leading-snug">{entry.label}</p>
                  <p className="text-[9px] text-zinc-700 mt-0.5">
                    {entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={activityBottomRef} />
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

const CHAT_MEMORY_KEY = 'deplai-chat-v1';

let _msgId = 0;
function nextId() { return Date.now() + (++_msgId); }

export default function AgentChat({
  initialPrompt = '',
  initialProject,
  projects,
  activeScanIds,
  onStart,
  onDismiss,
  onSessionClear,
  isSidebarOpen,
  initialSessionId,
  onCurrentSessionIdChange,
}: AgentChatProps) {
  const router = useRouter();
  const { provider, currentKey, currentModel } = useLLM();
  // startRemediationWS is the scan-context function that handles POST + WS token + WS connection.
  // triggerRemediation delegates to it so the pipeline actually runs.
  const { startRemediation: startRemediationWS } = useScan();
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const initialized = useRef(false);

  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>(() => {
    try {
      const stored = localStorage.getItem(CHAT_MEMORY_KEY);
      if (stored) {
        const mem = JSON.parse(stored) as { displayMessages: DisplayMessage[] };
        if (Array.isArray(mem.displayMessages) && mem.displayMessages.length > 0)
          return mem.displayMessages;
      }
    } catch { /* ignore */ }
    return [];
  });
  const [apiHistory, setApiHistory] = useState<ApiMessage[]>(() => {
    try {
      const stored = localStorage.getItem(CHAT_MEMORY_KEY);
      if (stored) {
        const mem = JSON.parse(stored) as { apiHistory: ApiMessage[] };
        if (Array.isArray(mem.apiHistory) && mem.apiHistory.length > 0)
          return mem.apiHistory;
      }
    } catch { /* ignore */ }
    return [];
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<GeneratedFile[]>([]);
  // Ref mirrors pendingFiles so async tool callbacks always read the latest value
  // without waiting for React to re-render (state updates are async).
  const pendingFilesRef = useRef<GeneratedFile[]>([]);
  const [githubPat, setGithubPat] = useState('');
  const [showPatInput, setShowPatInput] = useState(false);
  const [queuedRepoParams, setQueuedRepoParams] = useState<Record<string, unknown> | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [latestRepoResult, setLatestRepoResult] = useState<RepoResult | null>(null);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [trackedScans, setTrackedScans] = useState<Record<string, { projectName: string; completedNotified: boolean }>>({});
  const [manualRemediationInFlight, setManualRemediationInFlight] = useState<Record<string, boolean>>({});
  const scanStatusInFlightRef = useRef<Set<string>>(new Set());
  const scanCompletionNotifiedRef = useRef<Set<string>>(new Set());
  // Last architecture JSON generated — shared between generate_architecture and estimate_cost tools
  const lastArchitectureJsonRef = useRef<Record<string, unknown> | null>(null);

  // Sessions
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    try { return localStorage.getItem(CHAT_MEMORY_KEY + '-sid') ?? null; } catch { return null; }
  });
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // When parent passes isSidebarOpen, it takes precedence over internal state
  const showSidebar = isSidebarOpen !== undefined ? isSidebarOpen : sidebarOpen;

  // ── Sessions: fetch list from DB ──────────────────────────────────────────────
  const fetchSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await fetch('/api/chat/sessions');
      if (res.ok) {
        const data = await res.json() as { sessions: ChatSession[] };
        setSessions(data.sessions);
      }
    } catch { /* ignore */ }
    finally { setSessionsLoading(false); }
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  // Auto-load a session when the parent specifies one (e.g. clicked from left sidebar)
  useEffect(() => {
    if (!initialSessionId || initialSessionId === activeSessionId) return;
    loadSession({ id: initialSessionId, title: '', message_count: 0, created_at: '', updated_at: '' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once on mount

  // Persist active session ID to localStorage
  useEffect(() => {
    try {
      if (activeSessionId) localStorage.setItem(CHAT_MEMORY_KEY + '-sid', activeSessionId);
      else localStorage.removeItem(CHAT_MEMORY_KEY + '-sid');
    } catch { /* ignore */ }
  }, [activeSessionId]);

  // Notify parent of active session ID changes
  useEffect(() => {
    onCurrentSessionIdChange?.(activeSessionId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // ── Sessions: load a session ──────────────────────────────────────────────────
  const loadSession = useCallback(async (session: ChatSession) => {
    if (session.id === activeSessionId) return;
    try {
      const res = await fetch(`/api/chat/sessions/${session.id}`);
      if (!res.ok) return;
      const data = await res.json() as {
        messages: { role: string; content: string; metadata: Record<string, unknown> | null }[];
      };
      const rows = data.messages.filter(m => m.role === 'user' || m.role === 'assistant');
      const apiMsgs: ApiMessage[] = rows.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const display: DisplayMessage[] = [];
      for (const msg of rows) {
        if (msg.role === 'user') {
          display.push({
            id: nextId(),
            role: 'user',
            content: msg.content,
          });
          continue;
        }

        const text = (msg.content || '').trim();
        if (text) {
          display.push({
            id: nextId(),
            role: 'assistant',
            content: text,
          });
        }

        const metadata = msg.metadata && typeof msg.metadata === 'object'
          ? msg.metadata as Record<string, unknown>
          : null;
        const toolRaw = metadata?.tool_call;
        const toolCall = toolRaw && typeof toolRaw === 'object'
          ? toolRaw as { name?: unknown; params?: unknown }
          : null;
        const toolName = typeof toolCall?.name === 'string' ? toolCall.name : null;
        const toolParams = toolCall?.params && typeof toolCall.params === 'object'
          ? toolCall.params as Record<string, unknown>
          : null;

        if (toolName === 'run_scan' && toolParams) {
          const pid = typeof toolParams.project_id === 'string' ? toolParams.project_id : null;
          const pname = typeof toolParams.project_name === 'string' ? toolParams.project_name : 'project';
          if (pid) {
            display.push({
              id: nextId(),
              role: 'scan_started',
              content: pname,
              scanProjectId: pid,
            });
          }
        } else if (toolName === 'start_remediation' && toolParams) {
          const pid = typeof toolParams.project_id === 'string' ? toolParams.project_id : null;
          const pname = typeof toolParams.project_name === 'string' ? toolParams.project_name : 'project';
          if (pid) {
            display.push({
              id: nextId(),
              role: 'remediation_started',
              content: pname,
              scanProjectId: pid,
            });
          }
        }
      }

      setApiHistory(apiMsgs);
      setDisplayMessages(display);
      setActiveSessionId(session.id);
      pendingFilesRef.current = [];
      setPendingFiles([]);
      setLatestRepoResult(null);
      setActivity([]);
      setTrackedScans({});
      setManualRemediationInFlight({});
      scanStatusInFlightRef.current.clear();
      scanCompletionNotifiedRef.current.clear();

      // Sync to localStorage
      try {
        localStorage.setItem(CHAT_MEMORY_KEY, JSON.stringify({
          apiHistory: apiMsgs,
          displayMessages: display.map(m => ({ ...m, generatedFiles: undefined })),
        }));
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }, [activeSessionId]);

  // ── Sessions: start a new session ───────────────────────────────────────────
  const startNewSession = useCallback(() => {
    setActiveSessionId(null);
    setApiHistory([]);
    setDisplayMessages([]);
    setActivity([]);
    pendingFilesRef.current = [];
    setPendingFiles([]);
    setLatestRepoResult(null);
    setTrackedScans({});
    setManualRemediationInFlight({});
    scanStatusInFlightRef.current.clear();
    scanCompletionNotifiedRef.current.clear();
    try { localStorage.removeItem(CHAT_MEMORY_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(CHAT_MEMORY_KEY + '-sid'); } catch { /* ignore */ }
    onSessionClear?.();
  }, [onSessionClear]);

  // ── Sessions: delete a session ────────────────────────────────────────────────
  const deleteSession = useCallback(async (id: string) => {
    try {
      await fetch(`/api/chat/sessions/${id}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(s => s.id !== id));
      if (id === activeSessionId) startNewSession();
    } catch { /* ignore */ }
  }, [activeSessionId, startNewSession]);

  // Auto-scroll chat
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [displayMessages]);

  // Clear step indicator when agent goes idle
  useEffect(() => {
    if (!busy) setCurrentStep(null);
  }, [busy]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  const addDisplay = useCallback((msg: Omit<DisplayMessage, 'id'>) => {
    setDisplayMessages(prev => [...prev, { ...msg, id: nextId() }]);
  }, []);

  const replaceLastProgress = useCallback((updates: Partial<DisplayMessage>) => {
    setDisplayMessages(prev => {
      const idx = [...prev].reverse().findIndex(m => m.role === 'progress');
      if (idx === -1) return prev;
      const realIdx = prev.length - 1 - idx;
      const updated = [...prev];
      updated[realIdx] = { ...updated[realIdx], ...updates };
      return updated;
    });
  }, []);

  const addActivity = useCallback((entry: Omit<ActivityEntry, 'id' | 'timestamp'>) => {
    setActivity(prev => [...prev, { ...entry, id: nextId(), timestamp: new Date() }]);
  }, []);

  // Watch chat-started scans and notify when results are ready.
  useEffect(() => {
    const pending = Object.entries(trackedScans).filter(([, meta]) => !meta.completedNotified);
    if (!pending.length) return;

    let cancelled = false;

    const checkScanCompletion = async () => {
      for (const [projectId, meta] of pending) {
        if (cancelled) return;
        if (activeScanIds.includes(projectId)) continue;
        if (scanStatusInFlightRef.current.has(projectId)) continue;

        scanStatusInFlightRef.current.add(projectId);
        try {
          const res = await fetch(`/api/scan/status?project_id=${encodeURIComponent(projectId)}`);
          if (!res.ok) continue;
          const data = await res.json() as { status?: string };
          const status = String(data?.status || 'not_initiated');
          if (status === 'running' || status === 'not_initiated') continue;

          if (!scanCompletionNotifiedRef.current.has(projectId)) {
            scanCompletionNotifiedRef.current.add(projectId);
            const noFindings = status === 'not_found';

            addActivity({
              type: 'tool_done',
              icon: '✅',
              label: noFindings
                ? `Scan completed for "${meta.projectName}" (no findings persisted).`
                : `Scan completed for "${meta.projectName}".`,
            });
            addDisplay({
              role: 'scan_completed',
              content: meta.projectName,
              scanProjectId: projectId,
            });
            addDisplay({
              role: 'assistant',
              content: noFindings
                ? `Scan completed for **${meta.projectName}**. No persisted findings were detected. You can still open the report.`
                : `Scan completed for **${meta.projectName}**. Click **View Report** to review findings now.`,
            });
          }

          setTrackedScans(prev => {
            const current = prev[projectId];
            if (!current) return prev;
            return {
              ...prev,
              [projectId]: { ...current, completedNotified: true },
            };
          });
        } catch {
          // keep polling
        } finally {
          scanStatusInFlightRef.current.delete(projectId);
        }
      }
    };

    checkScanCompletion();
    const timer = window.setInterval(checkScanCompletion, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [trackedScans, activeScanIds, addActivity, addDisplay]);

  // ── Stable ref for executeTool — avoids stale closure in callChatApi ────────
  // executeTool depends on pendingFiles/githubPat which change during a multi-step flow;
  // keeping a ref ensures callChatApi always calls the freshest version.
  const executeToolRef = useRef<
    ((tc: { name: string; params: Record<string, unknown> }, gf: GeneratedFile[] | null, hist: ApiMessage[]) => Promise<void>) | null
  >(null);

  // ── Core: call /api/chat and process response ──────────────────────────────

  const callChatApi = useCallback(async (history: ApiMessage[]) => {
    const isNew = !activeSessionId;
    addActivity({ type: 'thinking', icon: '🤔', label: 'Thinking…' });
    setCurrentStep('Thinking…');
    setBusy(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history,
          session_id: activeSessionId,
          is_new_session: isNew,
          llm_config: currentKey?.trim()
            ? { provider, model: currentModel, api_key: currentKey.trim() }
            : null,
          context: {
            projects: projects.map(p => ({
              id: p.id,
              name: p.name || p.repo || 'Unknown',
              type: p.type,
            })),
          },
        }),
      });

      if (!res.ok) {
        addDisplay({ role: 'assistant', content: 'Something went wrong. Please try again.' });
        setBusy(false);
        return;
      }

      const data = await res.json();
      const { thought, message, tool_call, generated_files, observations, session_id: returnedSessionId } = data as {
        thought: string;
        message: string;
        tool_call: { name: string; params: Record<string, unknown> } | null;
        generated_files: GeneratedFile[] | null;
        observations: string[];
        session_id: string | null;
      };

      // Sync session ID returned from server (handles new-session creation)
      if (returnedSessionId && returnedSessionId !== activeSessionId) {
        setActiveSessionId(returnedSessionId);
        // Refresh session list so the new session shows up in the panel
        fetchSessions();
      } else if (returnedSessionId) {
        // Update title/count in local list
        fetchSessions();
      }

      // Surface thought to activity panel first
      if (thought) {
        addActivity({ type: 'thinking', icon: '💭', label: `Thought: ${thought}` });
      }
      // Surface any server-side ReAct observation steps
      if (observations?.length) {
        for (const obs of observations) {
          addActivity({ type: 'info', icon: '🔍', label: obs });
        }
      }

      const assistantMsg: ApiMessage = { role: 'assistant', content: message || '' };
      const newHistory: ApiMessage[] = [...history, assistantMsg];
      setApiHistory(newHistory);

      if (message) {
        // Strip any raw TOOL:{...} metadata the LLM may have included in its text
        // Strip raw TOOL:{} blocks and any stray THOUGHT: lines the LLM left in the body
        const cleanedMessage = message
          .replace(/\n*TOOL:\{[\s\S]*?\}(?:\n|$)/g, '')
          .replace(/^THOUGHT:.*$/gim, '')
          .trim();
        if (cleanedMessage) {
          addDisplay({
            role: 'assistant',
            content: cleanedMessage,
            generatedFiles: tool_call?.name === 'generate_code' ? (generated_files ?? []) : undefined,
          });
        } else if (tool_call?.name === 'navigate_to_results') {
          // LLM emitted only TOOL: with no visible message — show a fallback so chat isn't silent
          const pn = (tool_call.params as Record<string, string>).project_name || 'your project';
          addDisplay({ role: 'assistant', content: `Opening the security report for **${pn}**…` });
        }
      }

      if (tool_call) {
        await executeToolRef.current!(tool_call, generated_files, newHistory);
      } else {
        setBusy(false);
      }
    } catch {
      addDisplay({ role: 'assistant', content: 'Network error. Please try again.' });
      setBusy(false);
    }
  }, [projects, addDisplay, addActivity, activeSessionId, fetchSessions, provider, currentModel, currentKey]);

  // ── Tool execution ─────────────────────────────────────────────────────────

  const continueWithResult = useCallback(async (toolResult: string, history: ApiMessage[]) => {
    const withResult: ApiMessage[] = [...history, { role: 'user', content: toolResult }];
    setApiHistory(withResult);
    await callChatApi(withResult);
  }, [callChatApi]);

  const executeCreateRepo = useCallback(async (
    params: Record<string, unknown>,
    pat: string,
    history: ApiMessage[],
    files: GeneratedFile[],
  ) => {
    // Update the in-progress spinner already shown (from generate_code step) rather than stacking a second one
    replaceLastProgress({ content: `Creating repository **${params.name}**…` });
    addActivity({ type: 'tool_start', icon: '🔗', label: `Creating repo "${String(params.name)}"…` });
    setCurrentStep(`Creating GitHub repo: ${String(params.name)}…`);
    try {
      const res = await fetch('/api/github/create-repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: params.name,
          description: params.description || '',
          is_private: params.is_private ?? false,
          files,
          enable_pages: params.enable_pages ?? true,
          github_pat: pat,
        }),
      });
      const data = await res.json() as RepoResult & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Failed to create repo');

      setLatestRepoResult(data);
      addActivity({ type: 'tool_done', icon: '✅', label: `Pushed ${data.pushed.length} files → ${data.repo_url.replace('https://github.com/', '')}` });
      replaceLastProgress({
        role: 'repo_result',
        content: `Repository created`,
        repoResult: data,
      });
      addDisplay({
        role: 'assistant',
        content:
          `Your repository is ready at **${data.repo_url}**.\n` +
          `${data.pages_url ? `GitHub Pages: **${data.pages_url}**.\n` : ''}` +
          `${!data.pages_url && data.pages_error ? `GitHub Pages could not be enabled automatically: ${data.pages_error}\n` : ''}` +
          `I can continue with deployment hardening, CI checks, or app security improvements next.`,
      });
      // ✅ Done — don't call continueWithResult here. Doing so triggers another LLM turn which
      // mistakes the success observation for an intermediate step and calls create_github_repo again,
      // causing an infinite loop. The repo_result card already shows URL + pages link.
      setBusy(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown repository error';
      addActivity({ type: 'error', icon: '❌', label: `Repo error: ${msg}` });
      replaceLastProgress({ role: 'assistant', content: `❌ Repo creation failed: ${msg}` });
      // On failure we DO want the LLM to explain what went wrong
      await continueWithResult(`[Repo creation failed: ${msg}]`, history);
    }
  }, [replaceLastProgress, continueWithResult, addActivity, addDisplay]);

  const triggerRemediation = useCallback(async (
    remProjectId: string,
    remProjectName: string,
    options?: { history?: ApiMessage[]; githubToken?: string; setBusyState?: boolean },
  ) => {
    const history = options?.history;
    const githubToken = options?.githubToken;
    const shouldSetBusy = options?.setBusyState ?? false;

    if (shouldSetBusy) setBusy(true);
    setManualRemediationInFlight(prev => ({ ...prev, [remProjectId]: true }));
    addActivity({ type: 'tool_start', icon: '🔧', label: `Starting remediation for "${remProjectName}"...` });

    try {
      const r = await fetch('/api/remediate/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: remProjectId,
          github_token: githubToken || null,
        }),
      });

      if (r.ok) {
        // Delegate to scan-context which handles WS token fetch + WebSocket connection.
        // The second POST it makes internally is harmless — Python just overwrites the context.
        await startRemediationWS(remProjectId, undefined, githubToken || undefined);
        addActivity({ type: 'tool_done', icon: '✅', label: `Remediation started for "${remProjectName}"` });
        addDisplay({ role: 'remediation_started', content: remProjectName, scanProjectId: remProjectId });
        addDisplay({
          role: 'assistant',
          content:
            `Remediation started for **${remProjectName}**.\n` +
            `I can help you review proposed fixes, explain why each change is needed, and verify the results before merge.`,
        });
        setBusy(false);
      } else {
        const err = await r.json().catch(() => ({ error: 'unknown error' }));
        addActivity({ type: 'error', icon: '❌', label: `Remediation failed: ${err.error}` });
        if (history) {
          await continueWithResult(`[Remediation failed: ${err.error}]`, history);
        } else {
          addDisplay({ role: 'assistant', content: `Remediation failed: ${err.error}` });
          setBusy(false);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown remediation error';
      addActivity({ type: 'error', icon: '❌', label: `Remediation error: ${msg}` });
      if (history) {
        await continueWithResult(`[Remediation error: ${msg}]`, history);
      } else {
        addDisplay({ role: 'assistant', content: `Remediation error: ${msg}` });
        setBusy(false);
      }
    } finally {
      setManualRemediationInFlight(prev => {
        const next = { ...prev };
        delete next[remProjectId];
        return next;
      });
    }
  }, [addActivity, addDisplay, continueWithResult, startRemediationWS]);

  const handleManualRemediate = useCallback(async (projectId: string, projectName: string) => {
    if (!projectId || busy || manualRemediationInFlight[projectId]) return;
    addDisplay({ role: 'user', content: `Start remediation for **${projectName}**.` });
    setApiHistory(prev => [...prev, { role: 'user', content: `Start remediation for project "${projectName}" (id: ${projectId}).` }]);
    await triggerRemediation(projectId, projectName, { setBusyState: true });
  }, [busy, manualRemediationInFlight, addDisplay, triggerRemediation]);

  const executeTool = useCallback(async (
    toolCall: { name: string; params: Record<string, unknown> },
    generatedFiles: GeneratedFile[] | null,
    history: ApiMessage[],
  ) => {
    switch (toolCall.name) {
      case 'run_scan': {
        const { project_id, project_name, scan_type } = toolCall.params as { project_id: string; project_name: string; scan_type: ScanType };
        const project = projects.find(p => p.id === project_id);
        if (!project) {
          addActivity({ type: 'error', icon: '❌', label: `Project "${project_id}" not found` });
          await continueWithResult(`[Scan failed: project "${project_id}" not found in workspace]`, history);
          break;
        }


        addActivity({ type: 'tool_start', icon: '🛡️', label: `Scanning "${project_name}"…` });
        setCurrentStep(`Running ${scan_type || 'all'} scan on "${project_name}"…`);
        try {
          const r = await fetch('/api/scan/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project_id,
              project_name: project_name || project.name || project.repo,
              project_type: project.type,
              installation_id: project.installationId,
              owner: project.owner,
              repo: project.repo,
              scan_type: scan_type || 'all',
            }),
          });
          if (r.ok) {
            onStart(project_id, project_name, scan_type || 'all');
            addActivity({ type: 'tool_done', icon: '✅', label: `Scan started for "${project_name}"` });
            addDisplay({ role: 'scan_started', content: project_name, scanProjectId: project_id });
            setTrackedScans(prev => ({
              ...prev,
              [project_id]: {
                projectName: project_name,
                completedNotified: false,
              },
            }));
            scanCompletionNotifiedRef.current.delete(project_id);
            addDisplay({
              role: 'assistant',
              content:
                `Started a **${scan_type || 'all'}** scan for **${project_name}**.\n` +
                `I can stay with you in chat while it runs. Ask me to summarize findings, explain risk, or trigger remediation as soon as results are available.`,
            });
            // Scan card is now visible — no second LLM turn needed. Calling
            // continueWithResult here causes an unnecessary round-trip that
            // frequently exhausts the ReAct loop and shows the error message.
            setBusy(false);
          } else {
            const err = await r.json().catch(() => ({ error: 'unknown error' }));
            addActivity({ type: 'error', icon: '❌', label: `Scan failed: ${err.error}` });
            await continueWithResult(`[Scan failed: ${err.error}]`, history);
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Unknown scan error';
          addActivity({ type: 'error', icon: '❌', label: `Scan error: ${msg}` });
          await continueWithResult(`[Scan error: ${msg}]`, history);
        }
        break;
      }

      case 'start_remediation': {
        const { project_id: rem_project_id, project_name: rem_project_name, github_token } = toolCall.params as { project_id: string; project_name: string; github_token?: string };
        // Fall back to the PAT the user entered via ask_for_github_pat if the LLM
        // omitted github_token (which it can't know — it was collected client-side).
        const resolvedToken = github_token || githubPat || undefined;
        await triggerRemediation(rem_project_id, rem_project_name, {
          history,
          githubToken: resolvedToken,
        });
        break;
      }

      case 'navigate_to_results': {
        const { project_id, project_name } = toolCall.params as { project_id: string; project_name?: string };
        addActivity({ type: 'tool_done', icon: '📊', label: `Opening security analysis for "${project_name || project_id}"…` });
        addDisplay({ role: 'assistant', content: `Opening the security analysis page for **${project_name || 'your project'}**…` });
        setBusy(false);
        router.push(`/dashboard/security-analysis/${encodeURIComponent(project_id)}`);
        break;
      }

      case 'generate_code': {
        const files = generatedFiles ?? [];
        if (files.length > 0) {
          addActivity({ type: 'tool_done', icon: '📁', label: `Generated ${files.length} file${files.length !== 1 ? 's' : ''}` });
          pendingFilesRef.current = files; // sync update so create_github_repo sees them immediately
          setPendingFiles(files);
          setCurrentStep(`Generated ${files.length} files — preparing repository…`);
          const names = files.map(f => f.path).join(', ');
          // Show a progress message so the user has visibility while we make the next LLM call
          addDisplay({ role: 'progress', content: `✅ Generated **${files.length}** files. Setting up the GitHub repository…` });
          await continueWithResult(`[Generated ${files.length} files: ${names}]`, history);
        } else {
          addActivity({ type: 'error', icon: '⚠️', label: 'Code generation returned no files' });
          await continueWithResult('[Code generation returned no files — please try again with more details]', history);
        }
        break;
      }

      case 'ask_for_github_pat': {
        addActivity({ type: 'info', icon: '🔑', label: 'Requesting GitHub Personal Access Token…' });
        setShowPatInput(true);
        setBusy(false);
        break;
      }

      case 'create_github_repo': {
        const currentPat = githubPat;
        // Always read from the ref — React state may not have flushed yet if this
        // is called in the same async chain as setPendingFiles (generate_code → create_github_repo).
        const currentFiles = pendingFilesRef.current;
        if (!currentPat) {
          addActivity({ type: 'info', icon: '🔑', label: 'GitHub PAT required to create repo' });
          setQueuedRepoParams(toolCall.params);
          setShowPatInput(true);
          setBusy(false);
          break;
        }
        await executeCreateRepo(toolCall.params, currentPat, history, currentFiles);
        break;
      }

      case 'generate_architecture': {
        const { prompt, provider } = toolCall.params as { prompt: string; provider?: string };
        const prov = (provider || 'aws').toUpperCase();
        addActivity({ type: 'tool_start', icon: '🏗️', label: `Generating ${prov} architecture…` });
        setCurrentStep(`Generating architecture: ${String(prompt || '').slice(0, 60)}…`);
        try {
          const r = await fetch('/api/architecture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, provider: provider || 'aws' }),
          });
          const data = await r.json() as { success?: boolean; architecture_json?: Record<string, unknown>; provider?: string; error?: string };
          if (r.ok && data.architecture_json) {
            lastArchitectureJsonRef.current = data.architecture_json;
            const nodeCount = Array.isArray((data.architecture_json as { nodes?: unknown[] }).nodes)
              ? (data.architecture_json as { nodes: unknown[] }).nodes.length : 0;
            const title = String((data.architecture_json as { title?: string }).title || 'Untitled');
            addActivity({ type: 'tool_done', icon: '✅', label: `Architecture generated: ${nodeCount} service(s)` });
            await continueWithResult(
              `[Architecture generated: "${title}" with ${nodeCount} service(s) for ${(data.provider || prov)}. JSON: ${JSON.stringify(data.architecture_json)}]`,
              history,
            );
          } else {
            addActivity({ type: 'error', icon: '❌', label: `Architecture failed: ${data.error || 'unknown'}` });
            await continueWithResult(`[Architecture generation failed: ${data.error || 'unknown error'}]`, history);
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Unknown error';
          addActivity({ type: 'error', icon: '❌', label: `Architecture error: ${msg}` });
          await continueWithResult(`[Architecture generation error: ${msg}]`, history);
        }
        break;
      }

      case 'estimate_cost': {
        const { provider } = toolCall.params as { provider?: string };
        const archJson = lastArchitectureJsonRef.current;
        if (!archJson) {
          addActivity({ type: 'error', icon: '⚠️', label: 'No architecture for cost estimation' });
          await continueWithResult('[Cost estimation skipped: no architecture available. Generate an architecture first.]', history);
          break;
        }
        const prov = (provider || 'aws').toUpperCase();
        addActivity({ type: 'tool_start', icon: '💰', label: `Estimating ${prov} costs…` });
        setCurrentStep(`Estimating monthly costs for ${prov}…`);
        try {
          const r = await fetch('/api/cost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ architecture_json: archJson, provider: provider || 'aws' }),
          });
          const data = await r.json() as { success?: boolean; total_monthly_usd?: number; currency?: string; provider?: string; breakdown?: unknown[]; note?: string; error?: string };
          if (r.ok && data.success) {
            const total = data.total_monthly_usd?.toFixed(2) ?? 'N/A';
            addActivity({ type: 'tool_done', icon: '✅', label: `Est. $${total}/month` });
            await continueWithResult(
              `[Cost estimate: $${total}/month (${data.currency || 'USD'}) for ${data.provider?.toUpperCase() || prov}. Breakdown: ${JSON.stringify(data.breakdown)}${data.note ? `. Note: ${data.note}` : ''}]`,
              history,
            );
          } else {
            addActivity({ type: 'error', icon: '❌', label: `Cost estimation failed: ${data.error || 'unknown'}` });
            await continueWithResult(`[Cost estimation failed: ${data.error || 'unknown error'}]`, history);
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Unknown error';
          addActivity({ type: 'error', icon: '❌', label: `Cost estimation error: ${msg}` });
          await continueWithResult(`[Cost estimation error: ${msg}]`, history);
        }
        break;
      }

      default:
        setBusy(false);
        break;
    }
  }, [projects, onStart, router, githubPat, continueWithResult, executeCreateRepo, addActivity, addDisplay, triggerRemediation]);

  // Keep the ref pointing at the latest executeTool (must be after executeTool definition)
  executeToolRef.current = executeTool;

  // ── PAT submission ─────────────────────────────────────────────────────────

  const handlePatSubmit = useCallback((pat: string) => {
    setGithubPat(pat);
    setShowPatInput(false);
    addDisplay({ role: 'user', content: '🔑 GitHub Personal Access Token provided' });

    const toolResult = '[GitHub PAT provided by user]';
    const queued = queuedRepoParams;
    setQueuedRepoParams(null);

    if (queued) {
      const withPat: ApiMessage[] = [...apiHistory, { role: 'user', content: toolResult }];
      setApiHistory(withPat);
      setBusy(true);
      executeCreateRepo(queued, pat, withPat, pendingFilesRef.current);
    } else {
      // LLM called ask_for_github_pat standalone — re-prompt it to resume its original intent.
      // Do NOT hard-code create_github_repo here: the PAT could be needed for start_remediation too.
      // The LLM will pick the right tool based on its own conversation context.
      continueWithResult(
        '[GitHub PAT provided. Now resume the action you were planning BEFORE requesting the token. ' +
        'If you were going to remediate a project, call start_remediation with the project params ' +
        '(omit github_token — it will be injected automatically). ' +
        'If you were going to create a repository, call create_github_repo with the repo params. ' +
        'Do NOT describe what you will do — call the correct tool now.]',
        apiHistory,
      );
    }
  }, [apiHistory, queuedRepoParams, addDisplay, continueWithResult, executeCreateRepo]);

  // ── Send a user message ────────────────────────────────────────────────────

  const handleSend = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    addDisplay({ role: 'user', content: trimmed });
    const newHistory: ApiMessage[] = [...apiHistory, { role: 'user', content: trimmed }];
    setApiHistory(newHistory);
    setInput('');
    await callChatApi(newHistory);
  }, [busy, apiHistory, addDisplay, callChatApi]);

  // ── Memory: persist conversation to localStorage ───────────────────────────
  useEffect(() => {
    if (apiHistory.length === 0) return;
    try {
      localStorage.setItem(CHAT_MEMORY_KEY, JSON.stringify({
        apiHistory: apiHistory.slice(-80),
        // Strip generated file contents from stored display messages to stay within quota
        displayMessages: displayMessages.slice(-80).map(m => ({ ...m, generatedFiles: undefined })),
      }));
    } catch { /* localStorage quota exceeded — ignore */ }
  }, [apiHistory, displayMessages]);

  // ── Clear chat history ─────────────────────────────────────────────────────
  const clearHistory = useCallback(() => {
    try { localStorage.removeItem(CHAT_MEMORY_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(CHAT_MEMORY_KEY + '-sid'); } catch { /* ignore */ }
    setActiveSessionId(null);
    pendingFilesRef.current = [];
    setApiHistory([]);
    setDisplayMessages([{
      id: nextId(),
      role: 'assistant',
      content: "Chat history cleared. What would you like to do?",
    }]);
    setActivity([]);
    setPendingFiles([]);
    setLatestRepoResult(null);
    setTrackedScans({});
    setManualRemediationInFlight({});
    scanStatusInFlightRef.current.clear();
    scanCompletionNotifiedRef.current.clear();
  }, []);

  // ── Init ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // If state was already hydrated from localStorage (lazy init), skip the greeting
    if (displayMessages.length > 0) return;

    if (initialProject) {
      const pName = initialProject.name || initialProject.repo || 'your project';
      const greeting = `I can see you've selected **${pName}**. What would you like to do? I can run a security scan, explain previous findings, remediate vulnerabilities, or something else entirely.`;
      addDisplay({ role: 'assistant', content: greeting });
      // Inject project context into the history
      setApiHistory([{
        role: 'user',
        content: `I've selected project "${pName}" (id: ${initialProject.id}, type: ${initialProject.type}). ${initialPrompt || 'What can you help me with?'}`,
      }]);
    } else if (initialPrompt.trim()) {
      handleSend(initialPrompt.trim());
    } else {
      addDisplay({
        role: 'assistant',
        content:
          "Hi! I'm DeplAI. I can **scan repos** for vulnerabilities, **build apps** from scratch and push them to GitHub, **explain** security findings, or just chat. What would you like to do?",
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-row h-full gap-0" style={{ minHeight: 0 }}>
      {/* ── Far-left: Sessions sidebar ── */}
      {showSidebar && (
        <div className="w-64 shrink-0 border-r border-white/8 bg-black/20 flex flex-col" style={{ minHeight: 0 }}>
          <SessionsPanel
            sessions={sessions}
            activeId={activeSessionId}
            loading={sessionsLoading}
            onSelect={loadSession}
            onNew={startNewSession}
            onDelete={deleteSession}
          />
        </div>
      )}

      {/* Toggle sidebar button — only shown when parent is not controlling it */}
      {isSidebarOpen === undefined && (
        <button
          onClick={() => setSidebarOpen(o => !o)}
          title={showSidebar ? 'Hide chats' : 'Show chats'}
          className="shrink-0 self-start mt-3 mx-1 p-1.5 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-white/8 transition"
        >
          <Menu className="w-3.5 h-3.5" />
        </button>
      )}

      {/* ── Middle: Chat messages + input ── */}
      <div className="flex flex-col flex-1 min-w-0 px-1" style={{ minHeight: 0 }}>
      {/* Message thread */}
      <div className="flex-1 overflow-y-auto space-y-3 px-4 pt-5 pb-4" style={{ minHeight: 0 }}>
        {displayMessages.map(msg => {
          if (msg.role === 'user') {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="px-4 py-2.5 rounded-2xl rounded-tr-sm bg-indigo-600 text-white text-sm leading-relaxed max-w-[82%]">
                  <MessageContent content={msg.content} />
                </div>
              </div>
            );
          }

          if (msg.role === 'progress') {
            return (
              <div key={msg.id} className="flex items-start gap-2.5">
                <div className="w-7 h-7 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0 mt-0.5">
                  <svg className="w-3.5 h-3.5 text-indigo-400 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                </div>
                <div className="px-4 py-2.5 rounded-2xl rounded-tl-sm bg-white/5 border border-white/10 text-zinc-300 text-sm max-w-[82%]">
                  <MessageContent content={msg.content} />
                </div>
              </div>
            );
          }

          if (msg.role === 'repo_result' && msg.repoResult) {
            return (
              <div key={msg.id} className="flex items-start gap-2.5">
                <div className="w-7 h-7 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shrink-0 mt-0.5">
                  <Github className="w-3.5 h-3.5 text-emerald-400" />
                </div>
                <div className="flex-1 max-w-[82%]">
                  <RepoResultCard result={msg.repoResult} />
                </div>
              </div>
            );
          }

          if (msg.role === 'remediation_started' && msg.scanProjectId) {
            return (
              <div key={msg.id} className="flex items-start gap-2.5">
                <div className="w-7 h-7 rounded-full bg-violet-500/20 border border-violet-500/30 flex items-center justify-center shrink-0 mt-0.5">
                  <Shield className="w-3.5 h-3.5 text-violet-400" />
                </div>
                <div className="flex-1 max-w-[82%]">
                  <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-white/5 border border-white/10 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="flex h-2 w-2 relative shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-violet-500"></span>
                      </span>
                      <span className="text-sm text-zinc-300 truncate">
                        Remediation running for <strong className="text-white font-semibold">{msg.content}</strong>
                      </span>
                    </div>
                    <button
                      onClick={() => router.push(`/dashboard/security-analysis/${encodeURIComponent(msg.scanProjectId!)}`)}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/20 border border-violet-500/30 text-violet-300 text-xs font-semibold hover:bg-violet-500/30 transition-all"
                    >
                      View Progress
                    </button>
                  </div>
                </div>
              </div>
            );
          }

          if (msg.role === 'scan_started' && msg.scanProjectId) {
            return (
              <div key={msg.id} className="flex items-start gap-2.5">
                <div className="w-7 h-7 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0 mt-0.5">
                  <Shield className="w-3.5 h-3.5 text-indigo-400" />
                </div>
                <div className="flex-1 max-w-[82%]">
                  <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-white/5 border border-white/10 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="flex h-2 w-2 relative shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
                      </span>
                      <span className="text-sm text-zinc-300 truncate">
                        Scan running for <strong className="text-white font-semibold">{msg.content}</strong>
                      </span>
                    </div>
                    <button
                      onClick={() => router.push(`/dashboard/security-analysis/${encodeURIComponent(msg.scanProjectId!)}`)}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-xs font-semibold hover:bg-indigo-500/30 transition-all"
                    >
                      View Report
                    </button>
                  </div>
                </div>
              </div>
            );
          }

          if (msg.role === 'scan_completed' && msg.scanProjectId) {
            return (
              <div key={msg.id} className="flex items-start gap-2.5">
                <div className="w-7 h-7 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shrink-0 mt-0.5">
                  <Shield className="w-3.5 h-3.5 text-emerald-400" />
                </div>
                <div className="flex-1 max-w-[82%]">
                  <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-white/5 border border-white/10 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="inline-flex rounded-full h-2 w-2 bg-emerald-500 shrink-0" />
                      <span className="text-sm text-zinc-300 truncate">
                        Scan completed for <strong className="text-white font-semibold">{msg.content}</strong>
                      </span>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      <button
                        onClick={() => router.push(`/dashboard/security-analysis/${encodeURIComponent(msg.scanProjectId!)}`)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-xs font-semibold hover:bg-emerald-500/30 transition-all"
                      >
                        View Report
                      </button>
                      <button
                        disabled={busy || !!manualRemediationInFlight[msg.scanProjectId]}
                        onClick={() => handleManualRemediate(msg.scanProjectId!, msg.content)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/20 border border-violet-500/30 text-violet-300 text-xs font-semibold hover:bg-violet-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {manualRemediationInFlight[msg.scanProjectId] ? 'Starting...' : 'Remediate'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          // assistant
          return (
            <div key={msg.id} className="flex items-start gap-2.5">
              <div className="w-7 h-7 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0 mt-0.5">
                <Shield className="w-3.5 h-3.5 text-indigo-400" />
              </div>
              <div className="flex-1 max-w-[82%]">
                <div className="px-4 py-2.5 rounded-2xl rounded-tl-sm bg-white/5 border border-white/10 text-zinc-200 text-sm leading-relaxed">
                  <MessageContent content={msg.content} />
                </div>
                {msg.generatedFiles && msg.generatedFiles.length > 0 && (
                  <FilePreview files={msg.generatedFiles} />
                )}
              </div>
            </div>
          );
        })}

        {/* Thinking indicator */}
        {busy && (
          <div className="flex items-start gap-2.5">
            <div className="w-7 h-7 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
              <Shield className="w-3.5 h-3.5 text-indigo-400" />
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex items-center gap-1.5">
                {[0, 160, 320].map(delay => (
                  <span
                    key={delay}
                    className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* PAT input */}
        {showPatInput && !busy && (
          <div className="flex items-start gap-2.5">
            <div className="w-7 h-7 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-xs">🔑</span>
            </div>
            <div className="flex-1 max-w-[90%]">
              <PatInput
                onSubmit={handlePatSubmit}
                onDismiss={() => { setShowPatInput(false); setQueuedRepoParams(null); }}
              />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input bar — always visible */}
      <div className="px-4 pb-4 pt-2 shrink-0">
        <div className="flex items-end gap-2 bg-[#1C1C1E] border border-white/8 rounded-xl px-3 py-2 focus-within:border-indigo-500/40 transition">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend(input);
              }
            }}
            placeholder={busy ? 'Working on it…' : 'Ask anything — scan, build, deploy, explain…'}
            disabled={busy}
            rows={1}
            className="flex-1 bg-transparent text-white placeholder:text-zinc-600 resize-none outline-none text-sm leading-relaxed disabled:opacity-50"
            style={{ maxHeight: 120 }}
          />
          <button
            onClick={() => handleSend(input)}
            disabled={busy || !input.trim()}
            className="p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-white/8 disabled:text-zinc-600 text-white transition shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center justify-between mt-1 px-0.5">
          <p className="text-[10px] text-zinc-700">Shift+Enter for new line</p>
          <button
            onClick={clearHistory}
            title="Clear chat history"
            className="flex items-center gap-1 text-[10px] text-zinc-700 hover:text-red-400 transition"
          >
            <Trash2 className="w-2.5 h-2.5" />
            clear
          </button>
        </div>
      </div>
      </div>{/* end chat column */}

      {/* ── Right: Workspace preview panel ── */}
      <div className="w-80 shrink-0 border-l border-white/8 bg-black/20 overflow-hidden flex flex-col" style={{ minHeight: 0 }}>
        <WorkspacePreview
          activity={activity}
          files={pendingFiles}
          repoResult={latestRepoResult}
          busy={busy}
          currentStep={currentStep}
        />
      </div>
    </div>
  );
}


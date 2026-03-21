'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePopup } from '@/components/popup';
import { FiShield, FiCode, FiPackage, FiGlobe, FiX, FiChevronRight, FiExternalLink } from 'react-icons/fi';

export type ScanType = 'sast' | 'sca' | 'all';

type Phase = 'project' | 'scan_type' | 'launching' | 'done';

interface ChatMessage {
  id: number;
  from: 'bot' | 'user';
  content: string;
}

export interface ScanChatProject {
  id: string;
  name?: string;
  repo?: string;
  owner?: string;
  installationId?: string;
  type: 'local' | 'github';
}

interface ScanChatProps {
  initialPrompt?: string;
  // When set, skips project selection and goes straight to scan type
  initialProject?: ScanChatProject;
  projects: ScanChatProject[];
  activeScanIds: string[];
  onStart: (projectId: string, projectName: string, scanType: ScanType) => void;
  onDismiss: () => void;
  /** If true, project picker only shows GitHub repos */
  githubOnly?: boolean;
}

const SCAN_TYPE_OPTIONS = [
  {
    id: 'sast' as ScanType,
    label: 'SAST',
    sublabel: 'Static Code Analysis',
    desc: 'Scans source code for vulnerabilities and secrets using Bearer.',
    colorCls: 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400',
    Icon: FiCode,
  },
  {
    id: 'sca' as ScanType,
    label: 'SCA',
    sublabel: 'Dependency Audit',
    desc: 'Checks open-source packages for known CVEs via Syft + Grype.',
    colorCls: 'bg-violet-500/15 border-violet-500/30 text-violet-400',
    Icon: FiPackage,
  },
  {
    id: 'all' as ScanType,
    label: 'Full Scan',
    sublabel: 'SAST + SCA combined',
    desc: 'Runs both analyzers in parallel for complete coverage.',
    colorCls: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400',
    Icon: FiShield,
    recommended: true,
  },
] as const;

function detectScanTypeFromPrompt(prompt: string): ScanType | null {
  const lower = prompt.toLowerCase();
  if (/\b(full|all|complete|everything|both)\b/.test(lower)) return 'all';
  if (/\b(sast|static|code|secret|bearer)\b/.test(lower)) return 'sast';
  if (/\b(sca|dependency|dependencies|package|packages|cve|grype|syft|audit)\b/.test(lower)) return 'sca';
  return null;
}

function detectViewResultsIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  if (/i did a scan|already scanned|previous scan|scan results/.test(lower)) return true;
  if (/what (was|were) (detected|found)|what vulns|show.*results|see.*results|view.*results/.test(lower)) return true;
  if (/want to know/.test(lower) && /\b(vulns?|vulnerabilit|findings?|results?|detected|found)\b/.test(lower)) return true;
  return false;
}

function detectProjectFromPrompt(prompt: string, projects: ScanChatProject[]): ScanChatProject | null {
  const lower = prompt.toLowerCase();
  for (const p of projects) {
    const name = (p.name || p.repo || '').toLowerCase();
    if (name.length > 2 && lower.includes(name)) return p;
  }
  return null;
}

export default function ScanChat({
  initialPrompt = '',
  initialProject,
  projects,
  activeScanIds,
  onStart,
  onDismiss,
  githubOnly = false,
}: ScanChatProps) {
  const { showPopup } = usePopup();
  const [phase, setPhase] = useState<Phase>('project');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedProject, setSelectedProject] = useState<ScanChatProject | null>(initialProject ?? null);
  const [launchedProjectId, setLaunchedProjectId] = useState<string | null>(null);
  const [botTyping, setBotTyping] = useState(false);
  const msgIdRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  const addBotMessage = (content: string, delay = 400): Promise<void> =>
    new Promise(resolve => {
      setBotTyping(true);
      setTimeout(() => {
        setBotTyping(false);
        setMessages(prev => [...prev, { id: ++msgIdRef.current, from: 'bot', content }]);
        resolve();
      }, delay);
    });

  const addUserMessage = (content: string) => {
    setMessages(prev => [...prev, { id: ++msgIdRef.current, from: 'user', content }]);
  };

  // Bootstrap: runs once on mount
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const run = async () => {
      if (initialProject) {
        // Came from a project card — skip project selection
        const pName = initialProject.name || initialProject.repo || 'your project';
        await addBotMessage(`What type of analysis should I run on **${pName}**?`, 300);
        setPhase('scan_type');
        return;
      }

      // Came from the omnibar with a free-text prompt
      if (initialPrompt.trim()) {
        addUserMessage(initialPrompt);
      }

      const filteredProjects = githubOnly ? projects.filter(p => p.type === 'github') : projects;
      const detectedProject = detectProjectFromPrompt(initialPrompt, filteredProjects);
      const isViewIntent = detectViewResultsIntent(initialPrompt);

      if (detectedProject) {
        setSelectedProject(detectedProject);
        const pName = detectedProject.name || detectedProject.repo;
        if (isViewIntent) {
          // User wants to see existing scan results, not start a new scan
          await addBotMessage(
            `Got it — pulling up the latest findings for **${pName}**. Click the link below to open the full report.`,
            300,
          );
          setLaunchedProjectId(detectedProject.id);
          setPhase('done');
        } else {
          await addBotMessage(`Great — I found **${pName}** in your workspace. Which analysis should I run?`, 300);
          setPhase('scan_type');
        }
      } else if (filteredProjects.length === 0) {
        await addBotMessage(
          githubOnly
            ? "You don't have any connected GitHub repos yet. Use the GitHub button in the toolbar to connect one."
            : "You don't have any projects yet. Use the upload button or connect a GitHub repo to get started.",
          300,
        );
        setPhase('done');
      } else {
        await addBotMessage(
          githubOnly
            ? 'Which GitHub repository would you like me to analyze?'
            : 'Sure! Which project would you like me to analyze?',
          300,
        );
        setPhase('project');
      }
    };

    run();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, botTyping, phase]);

  const handleProjectSelect = async (project: ScanChatProject) => {
    const pName = project.name || project.repo || 'Project';
    addUserMessage(pName);
    setSelectedProject(project);
    await addBotMessage(`Got it! What type of scan should I run on **${pName}**?`, 400);
    setPhase('scan_type');
  };

  const handleTypeSelect = async (type: ScanType) => {
    const opt = SCAN_TYPE_OPTIONS.find(o => o.id === type)!;
    const project = selectedProject ?? initialProject;
    if (!project) return;

    const pName = project.name || project.repo || 'project';
    addUserMessage(`${opt.label} — ${opt.sublabel}`);
    setPhase('launching');

    await addBotMessage(`Kicking off the **${opt.label}** scan on **${pName}**…`, 400);

    try {
      const response = await fetch('/api/scan/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: project.id,
          project_name: pName,
          project_type: project.type,
          installation_id: project.installationId,
          owner: project.owner,
          repo: project.repo,
          scan_type: type,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.error || 'Backend request failed');
      }

      await response.json();
      setLaunchedProjectId(project.id);
      onStart(project.id, pName, type);

      await addBotMessage(
        `Scan launched! Monitor live output in the results view or stay here — I'll update when it completes.`,
        500,
      );
      setPhase('done');
    } catch (err: any) {
      showPopup({ type: 'error', message: err?.message || 'Failed to start scan' });
      setPhase('scan_type');
    }
  };

  const renderMessageContent = (content: string) =>
    content.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={i} className="text-white font-semibold">{part.slice(2, -2)}</strong>
      ) : (
        <span key={i}>{part}</span>
      ),
    );

  return (
    <div className="w-full">
      {/* Chat thread */}
      <div className="space-y-3 mb-4">
        {messages.map(msg => (
          <div key={msg.id} className={`flex ${msg.from === 'user' ? 'justify-end' : 'items-start gap-3'}`}>
            {msg.from === 'bot' && (
              <div className="w-7 h-7 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0 mt-0.5">
                <FiShield className="w-3.5 h-3.5 text-indigo-400" />
              </div>
            )}
            <div
              className={`px-4 py-2.5 rounded-2xl max-w-[80%] text-sm leading-relaxed ${
                msg.from === 'user'
                  ? 'bg-indigo-600 text-white rounded-tr-sm'
                  : 'bg-white/5 border border-white/10 text-zinc-200 rounded-tl-sm'
              }`}
            >
              {renderMessageContent(msg.content)}
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {botTyping && (
          <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
              <FiShield className="w-3.5 h-3.5 text-indigo-400" />
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '160ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '320ms' }} />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Project selection */}
      {!botTyping && phase === 'project' && (
        <div className="pl-10 space-y-2">
          {(githubOnly ? projects.filter(p => p.type === 'github') : projects).map(p => {
            const name = p.name || p.repo || 'Project';
            const isActive = activeScanIds.includes(p.id);
            return (
              <button
                key={p.id}
                onClick={() => !isActive && handleProjectSelect(p)}
                disabled={isActive}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all ${
                  isActive
                    ? 'border-white/5 bg-white/2 opacity-40 cursor-not-allowed'
                    : 'border-white/10 bg-white/3 hover:bg-white/7 hover:border-indigo-500/30'
                }`}
              >
                <div className="w-8 h-8 rounded-lg bg-black/40 border border-white/10 flex items-center justify-center shrink-0">
                  {p.type === 'github' ? (
                    <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.379.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-white truncate">{name}</p>
                  <p className="text-xs text-zinc-500 capitalize">{p.type}{isActive ? ' · scanning…' : ''}</p>
                </div>
                <FiChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />
              </button>
            );
          })}
        </div>
      )}

      {/* Scan type selection */}
      {!botTyping && phase === 'scan_type' && (
        <div className="pl-10 space-y-2">
          {SCAN_TYPE_OPTIONS.map(({ id, label, sublabel, desc, colorCls, Icon, ...rest }) => (
            <button
              key={id}
              onClick={() => handleTypeSelect(id)}
              className="w-full flex items-start gap-3 px-4 py-3.5 rounded-xl border border-white/10 bg-white/3 hover:bg-white/7 hover:border-indigo-500/30 transition-all text-left"
            >
              <div className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${colorCls}`}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-white">{label}</span>
                  <span className="text-xs text-zinc-500">{sublabel}</span>
                  {(rest as any).recommended && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                      Recommended
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 mt-0.5">{desc}</p>
              </div>
            </button>
          ))}

          {/* DAST placeholder */}
          <div className="w-full flex items-start gap-3 px-4 py-3.5 rounded-xl border border-white/5 bg-white/2 opacity-50 cursor-not-allowed">
            <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-700/30 flex items-center justify-center shrink-0 text-zinc-600">
              <FiGlobe className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-zinc-500">DAST</span>
                <span className="text-xs text-zinc-600">Dynamic Testing</span>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700">
                  Coming Soon
                </span>
              </div>
              <p className="text-xs text-zinc-600 mt-0.5">Live traffic analysis against a running app.</p>
            </div>
          </div>
        </div>
      )}

      {/* Post-launch / view-results link */}
      {phase === 'done' && launchedProjectId && (
        <div className="pl-10">
          <Link
            href={`/dashboard/security-analysis/${launchedProjectId}`}
            className="inline-flex items-center gap-2 text-sm font-medium text-indigo-400 hover:text-indigo-300 transition"
          >
            <FiExternalLink className="w-4 h-4" />
            Open security findings
          </Link>
        </div>
      )}

      {/* Dismiss button */}
      {phase !== 'done' && phase !== 'launching' && !botTyping && (
        <div className="pl-10 mt-3">
          <button
            onClick={onDismiss}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition flex items-center gap-1"
          >
            <FiX className="w-3 h-3" /> Cancel
          </button>
        </div>
      )}
    </div>
  );
}

import React, { useState } from 'react';
import { SEVERITY_CFG } from './data';
import type { FileNodeData, PipelineProject, Severity, Stage } from './types';

export interface PipelineRunOptions {
  autopilot: boolean;
  skipRemediation: boolean;
  skipScan: boolean;
}

export function colorize(code: string) {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/(resource|module|variable|output|provider|terraform|data)\b/g, '<span style="color:#93c5fd">$1</span>')
    .replace(/"([^"]+)"\s*=/g, '"<span style="color:#6ee7b7">$1</span>" =')
    .replace(/=\s*"([^"]+)"/g, '= "<span style="color:#fcd34d">$1</span>"')
    .replace(/#.*/g, '<span style="color:#6b7280">$&</span>');
}

export const GlobalStyles = () => (
  <style>{`
    .custom-scrollbar::-webkit-scrollbar { width: 5px; height: 5px; }
    .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
    .custom-scrollbar::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 3px; }
    .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #52525b; }
    .fade-in { animation: fadeIn 0.18s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    .pulse-dot { animation: pulseDot 1.4s ease-in-out infinite; }
    @keyframes pulseDot { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    .spin { animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .shimmer { background: linear-gradient(90deg, #18181b 25%, #27272a 50%, #18181b 75%); background-size: 200% 100%; animation: shimmer 1.4s infinite; }
    @keyframes shimmer { to { background-position: -200% 0; } }
  `}</style>
);

export const SeverityBadge: React.FC<{ s: string }> = ({ s }) => {
  const c = SEVERITY_CFG[s as Severity] || SEVERITY_CFG.low;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${c.bg} ${c.text} ${c.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </span>
  );
};

export const StageIcon: React.FC<{ status: string; gate?: boolean }> = ({ status, gate }) => {
  if (status === 'success') {
    return (
      <svg className="w-4 h-4 text-emerald-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (status === 'active') {
    return (
      <svg className="w-4 h-4 text-amber-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
    );
  }
  if (status === 'running') {
    return (
      <svg className="w-4 h-4 text-cyan-400 flex-shrink-0 spin" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity=".25" />
        <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }
  if (gate) {
    return (
      <svg className="w-4 h-4 text-zinc-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4 text-zinc-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <circle cx="12" cy="12" r="9" strokeWidth={1.5} strokeDasharray="4 2" />
    </svg>
  );
};

interface HeaderProps {
  title: string;
  subtitle?: string;
  badge?: { text: string; cls: string };
  actions?: React.ReactNode;
}

export const Header: React.FC<HeaderProps> = ({ title, subtitle, badge, actions }) => (
  <div className="flex items-start justify-between px-7 py-5 border-b border-white/5 flex-shrink-0">
    <div>
      {badge && (
        <div className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full mb-2 ${badge.cls}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          {badge.text}
        </div>
      )}
      <h1 className="text-xl font-semibold text-zinc-100">{title}</h1>
      {subtitle && <p className="text-sm text-zinc-500 mt-1">{subtitle}</p>}
    </div>
    {actions && <div className="flex items-center gap-2 mt-1">{actions}</div>}
  </div>
);

interface StatProps {
  label: string;
  value: React.ReactNode;
  sub?: string;
  color?: string;
}

export const Stat: React.FC<StatProps> = ({ label, value, sub, color = 'text-zinc-100' }) => (
  <div className="bg-zinc-900 rounded-xl border border-white/5 p-4">
    <p className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5">{label}</p>
    <p className={`text-3xl font-bold font-mono ${color}`}>{value}</p>
    {sub && <p className="text-[11px] text-zinc-600 mt-1">{sub}</p>}
  </div>
);

interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'success' | 'ghost' | 'indigo';
  size?: 'sm' | 'md' | 'lg';
}

export const Btn: React.FC<BtnProps> = ({ children, onClick, variant = 'default', size = 'md', disabled, className = '', ...rest }) => {
  const base = 'inline-flex items-center justify-center gap-2 font-semibold rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed';
  const sizes = { md: 'px-4 py-2 text-sm', sm: 'px-3 py-1.5 text-xs', lg: 'px-5 py-2.5 text-sm' };
  const variants = {
    default: 'bg-white/5 hover:bg-white/10 border border-white/10 text-zinc-200',
    primary: 'bg-cyan-500 hover:bg-cyan-400 text-zinc-950',
    danger: 'bg-red-500/10 hover:bg-red-500/20 border border-red-500/25 text-red-400',
    success: 'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/25 text-emerald-400',
    ghost: 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5',
    indigo: 'bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/25 text-indigo-300',
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
};

export const Tag: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color = 'zinc' }) => {
  const colors: Record<string, string> = {
    zinc: 'bg-zinc-800 text-zinc-400',
    cyan: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
    amber: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
    red: 'bg-red-500/10 text-red-400 border border-red-500/20',
    indigo: 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20',
    purple: 'bg-purple-500/10 text-purple-400 border border-purple-500/20',
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${colors[color] || colors.zinc}`}>{children}</span>;
};

interface StageRowProps {
  stage: Stage;
  active: boolean;
  onClick: () => void;
}

const StageRow: React.FC<StageRowProps> = ({ stage, active, onClick }) => {
  const statusColors: Record<string, string> = {
    success: 'text-zinc-300',
    active: 'text-amber-300',
    running: 'text-cyan-300',
    pending: 'text-zinc-600',
  };
  return (
    <button onClick={onClick} className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all text-left group ${active ? 'bg-cyan-500/10 border border-cyan-500/20' : 'hover:bg-white/4 border border-transparent'}`}>
      <StageIcon status={stage.status} gate={stage.gate} />
      <div className="flex-1 min-w-0">
        <p className={`text-[11.5px] font-medium truncate leading-tight ${statusColors[stage.status] || 'text-zinc-600'} ${active ? '!text-cyan-300' : ''}`}>{stage.label}</p>
        {stage.duration && <p className="text-[10px] text-zinc-600 font-mono mt-0.5">{stage.duration}</p>}
        {stage.gate && stage.status !== 'success' && <p className="text-[10px] text-amber-500/70 mt-0.5">Requires approval</p>}
      </div>
      <span className={`text-[10px] font-mono text-zinc-700 group-hover:text-zinc-500 ${active ? 'text-zinc-500' : ''}`}>{stage.id}</span>
    </button>
  );
};

interface SidebarProps {
  current: string;
  setCurrent: (v: string) => void;
  stages: Stage[];
  githubAccounts?: string[];
  githubInstallUrl?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  current,
  setCurrent,
  stages,
  githubAccounts = [],
  githubInstallUrl = 'https://github.com/apps/deplai-gitapp-aj/installations/new',
}) => {
  const loopStages = stages.filter((s) => s.group === 'loop');
  const preStages = stages.filter((s) => s.id === 0);
  const postStages = stages.filter((s) => s.group !== 'loop' && s.id !== 0);
  const successCount = stages.filter((s) => s.status === 'success').length;
  const pct = Math.round((successCount / stages.length) * 100);
  const githubConnected = githubAccounts.length > 0;
  const githubLabel = githubConnected ? githubAccounts.join(', ') : 'Not connected';

  return (
    <aside className="w-72 flex-shrink-0 bg-[#09090b] border-r border-white/5 flex flex-col overflow-hidden">
      <div className="px-4 py-4 border-b border-white/5">
        <div className="flex items-center gap-2.5 mb-4">
          <div className="w-7 h-7 rounded-lg bg-cyan-500/15 border border-cyan-500/25 flex items-center justify-center">
            <svg viewBox="0 0 28 28" className="w-4 h-4" fill="none">
              <polygon points="14,2 25,8 25,20 14,26 3,20 3,8" stroke="#06b6d4" strokeWidth="1.5" />
              <circle cx="14" cy="14" r="3" fill="#06b6d4" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-zinc-100 leading-none">DeplAI</p>
            <p className="text-[10px] text-zinc-500 mt-0.5">Enterprise Pipeline</p>
          </div>
        </div>
        <div className="bg-zinc-900 rounded-lg p-3 border border-white/5">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[11px] text-zinc-400 font-medium">Pipeline progress</span>
            <span className="text-[11px] font-semibold text-cyan-400 font-mono">{pct}%</span>
          </div>
          <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-cyan-500 to-indigo-500 rounded-full transition-all duration-700" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex justify-between mt-2">
            <span className="text-[10px] text-zinc-500">{successCount}/{stages.length} complete</span>
            <span className="text-[10px] text-amber-400">Merge gate</span>
          </div>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5 custom-scrollbar">
        {preStages.map((s) => <StageRow key={s.key} stage={s} active={current === s.key} onClick={() => setCurrent(s.key)} />)}
        <div className="mx-2 my-2">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[9px] uppercase tracking-widest text-zinc-600 font-semibold flex-shrink-0">Remediation Loop ×2</span>
            <div className="flex-1 h-px bg-zinc-800" />
          </div>
          <div className="ml-3 space-y-0.5 border-l border-zinc-800 pl-3">
            {loopStages.map((s) => <StageRow key={s.key} stage={s} active={current === s.key} onClick={() => setCurrent(s.key)} />)}
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex-1 h-px bg-zinc-800" />
            <span className="text-[9px] uppercase tracking-widest text-zinc-600 font-semibold flex-shrink-0">End Loop</span>
          </div>
        </div>
        {postStages.map((s) => <StageRow key={s.key} stage={s} active={current === s.key} onClick={() => setCurrent(s.key)} />)}
      </nav>
      <div className="px-3 py-3 border-t border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center text-[10px] font-bold text-indigo-300">AJ</div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-zinc-300 truncate">aj@deplai.io</p>
            <p className="text-[10px] text-zinc-500">Admin</p>
          </div>
          <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-sm" />
        </div>
        <div className="mt-2.5 pt-2.5 border-t border-white/5 flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0112 6.844c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" /></svg>
          <div className="flex-1 min-w-0">
            <p className={`text-[11px] truncate ${githubConnected ? 'text-zinc-300' : 'text-zinc-500'}`}>{githubLabel}</p>
            <p className={`text-[10px] ${githubConnected ? 'text-emerald-400' : 'text-amber-400'}`}>{githubConnected ? 'GitHub connected' : 'GitHub connector required'}</p>
          </div>
          {!githubConnected && (
            <a href={githubInstallUrl} target="_blank" rel="noreferrer" className="text-[10px] px-2 py-1 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25">
              Connect
            </a>
          )}
        </div>
      </div>
    </aside>
  );
};

interface ProjectSelectorProps {
  projects: PipelineProject[];
  selectedProjectId: string | null;
  onSelect: (projectId: string) => void;
}

export function ProjectSelector({ projects, selectedProjectId, onSelect }: ProjectSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = projects.find((project) => project.id === selectedProjectId) || null;

  return (
    <div className="relative flex items-center h-full">
      {isOpen && <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />}
      <div className="relative flex items-center bg-zinc-900 border border-white/10 rounded-md z-50">
        <button onClick={() => setIsOpen(!isOpen)} className="flex items-center justify-center pl-2.5 pr-1.5 py-1 hover:bg-white/5 transition-colors border-r border-white/10 rounded-l-md focus:outline-none">
          {selected?.type === 'github' ? (
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-zinc-400" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0112 6.844c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
          )}
          <svg className="w-3 h-3 text-zinc-500 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
        </button>

        {isOpen && (
          <div className="absolute top-full right-0 mt-1 w-64 max-h-72 overflow-y-auto custom-scrollbar bg-[#141417] border border-white/10 rounded-lg shadow-xl z-50 py-1">
            {projects.length === 0 && <div className="px-3 py-2 text-[11px] text-zinc-500">No projects found</div>}
            {projects.map((project) => {
              const isSelected = project.id === selectedProjectId;
              const isGithub = project.type === 'github';
              return (
                <button
                  key={project.id}
                  onClick={() => { onSelect(project.id); setIsOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] hover:bg-white/5 transition-colors ${isSelected ? 'text-emerald-400' : 'text-zinc-300'}`}
                >
                  {isGithub ? (
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0112 6.844c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                  )}
                  <span className="truncate">{project.name}</span>
                </button>
              );
            })}
          </div>
        )}

        <input type="text" value={selected?.name || ''} readOnly className="bg-transparent border-none text-[11px] text-zinc-300 w-44 focus:outline-none placeholder-zinc-600 px-2 py-1 rounded-r-md" placeholder="Select project" />
      </div>
    </div>
  );
}

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-start gap-3 cursor-pointer group" onClick={() => onChange(!checked)}>
      <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-sm flex items-center justify-center border transition-colors ${checked ? 'bg-blue-600 border-blue-600' : 'bg-transparent border-zinc-500 group-hover:border-zinc-400'}`}>
        {checked && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
      </div>
      <span className="text-sm text-zinc-200 group-hover:text-white transition-colors flex-1 select-none">{label}</span>
    </div>
  );
}

export function RunOptionsModal({
  onClose,
  options,
  onChange,
}: {
  onClose: () => void;
  options: PipelineRunOptions;
  onChange: (next: PipelineRunOptions) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#141417] border border-white/10 rounded-xl w-full max-w-[540px] shadow-2xl relative flex flex-col overflow-hidden fade-in">
        <div className="p-5 border-b border-white/5 flex justify-between items-center bg-[#1a1a1c]">
          <h2 className="text-[12px] uppercase tracking-widest text-zinc-400 font-bold">Run Options</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="p-6 space-y-4">
          <Checkbox checked={options.autopilot} onChange={(v) => onChange({ ...options, autopilot: v })} label="Autopilot mode: auto-answer Q/A, auto-approve policy gates, and auto-trigger deployment when AWS credentials are present." />
          <Checkbox checked={options.skipRemediation} onChange={(v) => onChange({ ...options, skipRemediation: v })} label="Skip remediation loop and continue to Q/A after scan (recommended for large repositories)." />
          <Checkbox checked={options.skipScan} onChange={(v) => onChange({ ...options, skipScan: v })} label="Skip scan and remediation entirely, then continue directly to Q/A, IaC generation, and deployment." />
        </div>
        <div className="px-6 py-5 bg-zinc-950/50 border-t border-white/5 space-y-3">
          <p className="text-[12px] text-zinc-500 leading-relaxed">Free-tier deployment guardrails are always enforced for runtime apply (EC2 micro family only).</p>
          <p className="text-[12px] text-zinc-500 leading-relaxed">When remediation bypass is enabled, stages 2 through 4.6 are skipped and deployment planning continues with current scan findings.</p>
          <p className="text-[12px] text-zinc-500 leading-relaxed">When scan bypass is enabled, stages 1 through 4.6 are skipped and no security findings are collected for this run.</p>
        </div>
      </div>
    </div>
  );
}

interface FileNodeProps {
  node: FileNodeData;
  selected: string;
  setSelected: (v: string) => void;
  depth?: number;
}

export const FileNode: React.FC<FileNodeProps> = ({ node, selected, setSelected, depth = 0 }) => {
  const [open, setOpen] = useState(true);
  const isFile = node.type === 'file';
  const fname = node.name.split('/').pop() || '';
  const isActive = selected === fname;

  if (isFile) {
    return (
      <button onClick={() => setSelected(fname)} className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-mono transition-colors ${isActive ? 'bg-cyan-500/10 text-cyan-300' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/3'}`} style={{ paddingLeft: `${8 + depth * 12}px` }}>
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
        {fname}
      </button>
    );
  }

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors" style={{ paddingLeft: `${8 + depth * 12}px` }}>
        <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
        <svg className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M2 6a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" /></svg>
        {node.name}
      </button>
      {open && node.children && <div>{node.children.map((c, i) => <FileNode key={i} node={c} selected={selected} setSelected={setSelected} depth={depth + 1} />)}</div>}
    </div>
  );
};

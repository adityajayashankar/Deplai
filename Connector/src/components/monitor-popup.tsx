'use client';

import { useEffect, useRef, useMemo } from 'react';
import { useScan, type ScanMessage } from '@/lib/scan-context';

interface MonitorPopupProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
}

const MESSAGE_STYLES: Record<string, { color: string; prefix: string }> = {
  success:          { color: 'text-green-400',                    prefix: '[+]'         },
  warning:          { color: 'text-yellow-400',                   prefix: '[!]'         },
  phase:            { color: 'text-blue-400 font-bold',           prefix: ''            },
  error:            { color: 'text-red-500',                      prefix: '[ERR]'       },
  info:             { color: 'text-gray-300',                     prefix: '[*]'         },
  kg_phase:         { color: 'text-violet-400 font-medium',       prefix: '[KG]'        },
  planner_phase:    { color: 'text-orange-400 font-medium',       prefix: '[PLANNER]'   },
  supervisor_phase: { color: 'text-sky-400 font-bold',            prefix: '[SUPERVISOR]'},
  proposer_phase:   { color: 'text-amber-400 font-medium',        prefix: '[PROPOSER]'  },
  critic_phase:     { color: 'text-rose-400 font-medium',         prefix: '[CRITIC]'    },
  synthesizer_phase:{ color: 'text-emerald-400 font-medium',      prefix: '[SYNTH]'     },
};

const STATUS_CONFIG: Record<string, { dot: string; label: string }> = {
  running:   { dot: 'bg-green-500', label: 'Running' },
  waiting_decision: { dot: 'bg-amber-500', label: 'Waiting Decision' },
  waiting_approval: { dot: 'bg-yellow-500', label: 'Waiting Approval' },
  completed: { dot: 'bg-blue-500', label: 'Completed' },
  error:     { dot: 'bg-red-500', label: 'Error' },
};

export default function MonitorPopup({ projectId, isOpen, onClose }: MonitorPopupProps) {
  const { getScanState, getRemediationState } = useScan();
  const { state: scanState, messages: scanMessages } = getScanState(projectId);
  const { state: remState, messages: remMessages } = getRemediationState(projectId);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Determine active state — remediation takes priority if active
  const isRemediating =
    remState === 'running' ||
    remState === 'waiting_decision' ||
    remState === 'waiting_approval' ||
    remState === 'completed' ||
    remState === 'error';
  const activeState = isRemediating ? remState : scanState;

  // Combine scan + remediation messages so the monitor continues from where scan left off
  const messages = useMemo<ScanMessage[]>(() => {
    if (!isRemediating) return scanMessages;
    return [...scanMessages, ...remMessages];
  }, [isRemediating, scanMessages, remMessages]);

  // Auto-scroll terminal when new messages arrive
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [messages.length]);

  if (!isOpen) return null;

  const { dot: statusDotColor, label: statusLabel } = STATUS_CONFIG[activeState] || { dot: 'bg-gray-400', label: 'Idle' };

  // Measure header bottom for layout
  const headerEl = typeof document !== 'undefined' ? document.querySelector('header') : null;
  const headerBottom = headerEl ? headerEl.getBoundingClientRect().bottom : 0;

  return (
    <div
      className="fixed z-50 flex flex-col"
      style={{ top: headerBottom, left: 0, right: 0, bottom: 0 }}
    >
      {/* Scoped scrollbar styles for the terminal */}
      <style>{`
        .monitor-terminal::-webkit-scrollbar {
          width: 6px;
        }
        .monitor-terminal::-webkit-scrollbar-track {
          background: transparent;
        }
        .monitor-terminal::-webkit-scrollbar-thumb {
          background: #3b3b4f;
          border-radius: 3px;
        }
        .monitor-terminal::-webkit-scrollbar-thumb:hover {
          background: #555570;
        }
      `}</style>

      {/* Header bar */}
      <div
        className="flex items-center justify-between px-4 py-2.5 bg-surface border border-border select-none"
      >
        <div className="flex items-center gap-2.5">
          <div className={`w-2 h-2 rounded-full ${statusDotColor} ${activeState === 'running' ? 'animate-pulse' : ''}`} />
          <span className="text-xs font-medium text-foreground">
            {isRemediating && activeState === 'running' ? 'Remediating' : statusLabel}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Close button */}
          <button
            onClick={onClose}
            className="p-1 text-muted hover:text-foreground rounded transition"
            aria-label="Close monitor"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Terminal body */}
      <div
        ref={terminalRef}
        className="monitor-terminal bg-[#0d1117] border border-t-0 border-border p-4 font-mono text-sm leading-relaxed overflow-y-auto flex-1"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#3b3b4f transparent' }}
      >
        {messages.length === 0 && (activeState === 'idle' || activeState === 'running') && (
          <div className="flex gap-3">
            <span className="text-green-400 animate-pulse">$$ / &#x2588;</span>
          </div>
        )}
        {messages.map((msg, i) => {
          // kg_result and changed_files carry raw JSON — show a friendly summary line instead
          if (msg.type === 'kg_result') {
            return (
              <div key={i} className="flex gap-2">
                <span className="text-violet-300">[KG] Knowledge context captured — enriching remediation prompt</span>
              </div>
            );
          }
          if (msg.type === 'changed_files') {
            let count = 0;
            try { count = JSON.parse(msg.content).length; } catch { /* ignore */ }
            return (
              <div key={i} className="flex gap-2">
                <span className="text-indigo-300">[+] {count} file{count !== 1 ? 's' : ''} queued for remediation</span>
              </div>
            );
          }
          const style = MESSAGE_STYLES[msg.type] || MESSAGE_STYLES.info;
          return (
            <div key={i} className="flex gap-2">
              <span className={style.color}>
                {style.prefix ? `${style.prefix} ${msg.content}` : msg.content}
              </span>
            </div>
          );
        })}
        {activeState === 'running' && messages.length > 0 && (
          <div className="flex gap-3">
            <span className="text-green-400 animate-pulse">$$ / &#x2588;</span>
          </div>
        )}
      </div>

    </div>
  );
}

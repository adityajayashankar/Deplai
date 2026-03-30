import React from 'react';
import { Header, Btn, Tag } from './ui';

interface RuntimeMessage {
  type: string;
  content: string;
  timestamp?: string;
}

interface ChangedFile {
  path: string;
  reason?: string;
}

interface RemediationPageProps {
  state: 'idle' | 'running' | 'waiting_approval' | 'completed' | 'error';
  scanStatus?: string;
  messages: RuntimeMessage[];
  changedFiles: ChangedFile[];
  prUrl: string | null;
  noChangesDetected: boolean;
  onStart: () => void;
  onSendPr: () => void;
  onContinueWithoutPr: () => void;
  onNavigate: (v: string) => void;
}

export function RemediationPage({
  state,
  scanStatus,
  messages,
  changedFiles,
  prUrl,
  noChangesDetected,
  onStart,
  onSendPr,
  onContinueWithoutPr,
  onNavigate,
}: RemediationPageProps) {
  const skipBecauseNoFindings = scanStatus === 'not_found';
  const badge = state === 'running'
    ? { text: 'Remediation running', cls: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' }
    : skipBecauseNoFindings
      ? { text: 'No vulnerabilities found', cls: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' }
    : state === 'waiting_approval'
      ? { text: 'Awaiting send PR approval', cls: 'bg-amber-500/10 text-amber-400 border border-amber-500/20' }
      : state === 'completed'
        ? { text: 'Remediation completed', cls: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' }
        : state === 'error'
          ? { text: 'Remediation failed', cls: 'bg-red-500/10 text-red-400 border border-red-500/20' }
          : { text: 'Ready for remediation', cls: 'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20' };

  return (
    <div className="flex-1 overflow-y-auto fade-in custom-scrollbar">
      <Header
        title="AI Remediation"
        subtitle="User-triggered remediation with explicit send PR and merge-gate flow."
        badge={badge}
        actions={<Tag color="indigo">Stage 3-4</Tag>}
      />
      <div className="p-7 grid grid-cols-5 gap-5">
        <div className="col-span-2 space-y-4">
          <div className="bg-zinc-900 rounded-xl border border-white/5 p-4 space-y-3">
            <p className="text-sm font-semibold text-zinc-200">Actions</p>
            <div className="flex flex-wrap gap-2">
              <Btn onClick={onStart} variant="primary" size="sm" disabled={skipBecauseNoFindings || state === 'running' || state === 'waiting_approval'}>Start remediation</Btn>
              <Btn onClick={onSendPr} variant="indigo" size="sm" disabled={state !== 'waiting_approval'}>Send PR</Btn>
              {prUrl && <Btn onClick={() => window.open(prUrl, '_blank', 'noopener,noreferrer')} variant="default" size="sm">Open PR</Btn>}
              <Btn onClick={() => onNavigate('merge')} variant="ghost" size="sm" disabled={!prUrl}>Go to merge gate</Btn>
              <Btn
                onClick={onContinueWithoutPr}
                variant="default"
                size="sm"
                disabled={!(skipBecauseNoFindings || (state === 'completed' && noChangesDetected && !prUrl))}
              >
                Continue to Q/A
              </Btn>
            </div>
            {prUrl && <p className="text-[11px] text-cyan-400 font-mono break-all">{prUrl}</p>}
            {skipBecauseNoFindings && (
              <p className="text-[11px] text-emerald-400">
                No vulnerabilities found in scan results. Remediation loop is skipped; continue directly to Q/A.
              </p>
            )}
            {noChangesDetected && !prUrl && state === 'completed' && (
              <p className="text-[11px] text-amber-400">
                No safe code changes were produced. Continue without PR to proceed with delivery stages.
              </p>
            )}
          </div>

          <div className="bg-zinc-900 rounded-xl border border-white/5 p-4">
            <p className="text-sm font-semibold text-zinc-200 mb-3">Changed Files</p>
            {changedFiles.length === 0 ? (
              <p className="text-[12px] text-zinc-500">
                {state === 'completed'
                  ? 'Remediation completed with no safe file changes.'
                  : 'No file changes detected yet. Start remediation to generate patches.'}
              </p>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar">
                {changedFiles.map((item, idx) => (
                  <div key={`${item.path}-${idx}`} className="bg-zinc-950 rounded-lg border border-white/5 p-3">
                    <p className="text-[11px] font-mono text-cyan-400">{item.path}</p>
                    {item.reason && <p className="text-[11px] text-zinc-500 mt-1">{item.reason}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="col-span-3 bg-zinc-900 rounded-xl border border-white/5 overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5">
            <p className="text-sm font-semibold text-zinc-200">Remediation Stream</p>
          </div>
          <div className="p-4 bg-zinc-950/70 font-mono text-[11px] max-h-[560px] overflow-y-auto space-y-1.5 custom-scrollbar">
            {messages.length === 0 && <p className="text-zinc-600">No remediation events yet.</p>}
            {messages.slice(-200).map((msg, idx) => (
              <div key={`${msg.timestamp || idx}-${idx}`} className={msg.type === 'error' ? 'text-red-400' : msg.type === 'success' ? 'text-emerald-400' : msg.type === 'phase' ? 'text-cyan-400' : 'text-zinc-400'}>
                [{msg.type}] {msg.content}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

interface MergeGatePageProps {
  prUrl: string | null;
  merged: boolean;
  onConfirmMerged: () => void;
  onNavigate: (v: string) => void;
}

export function MergeGatePage({ prUrl, merged, onConfirmMerged, onNavigate }: MergeGatePageProps) {
  return (
    <div className="flex-1 overflow-y-auto fade-in custom-scrollbar">
      <Header title="Merge Gate" subtitle="Confirm GitHub PR merge before post-merge actions." badge={{ text: merged ? 'Merge confirmed' : 'Awaiting merge confirmation', cls: merged ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20' }} actions={<Tag color="amber">Stage 4.5 - GATE</Tag>} />
      <div className="p-7 max-w-3xl space-y-4">
        <div className="bg-zinc-900 rounded-xl border border-white/5 p-5">
          <p className="text-sm text-zinc-300">PR</p>
          {prUrl ? <p className="text-[12px] font-mono text-cyan-400 break-all mt-1">{prUrl}</p> : <p className="text-[12px] text-zinc-500 mt-1">No remediation PR found yet.</p>}
          <div className="flex gap-2 mt-4">
            <Btn onClick={() => prUrl && window.open(prUrl, '_blank', 'noopener,noreferrer')} size="sm" disabled={!prUrl}>Open PR</Btn>
            <Btn onClick={onConfirmMerged} variant="primary" size="sm" disabled={!prUrl || merged}>I merged on GitHub</Btn>
            <Btn onClick={() => onNavigate('postmerge')} variant="ghost" size="sm" disabled={!merged}>Continue</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

interface PostMergePageProps {
  onSkip: () => void;
  onRerunScan: () => void;
  rerunInProgress: boolean;
}

export function PostMergePage({ onSkip, onRerunScan, rerunInProgress }: PostMergePageProps) {
  return (
    <div className="flex-1 overflow-y-auto fade-in custom-scrollbar">
      <Header title="Post-Merge Actions" subtitle="Choose whether to skip or re-run security scan." badge={{ text: 'Operator choice required', cls: 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20' }} actions={<Tag color="zinc">Stage 4.6</Tag>} />
      <div className="p-7 max-w-3xl space-y-4">
        <div className="bg-zinc-900 rounded-xl border border-white/5 p-5">
          <p className="text-sm font-semibold text-zinc-200 mb-2">Next step</p>
          <p className="text-sm text-zinc-500 mb-4">Skip to Q/A if you trust merged remediation, or run scan again for verification.</p>
          <div className="flex gap-3">
            <Btn onClick={onSkip} variant="primary">Skip and continue to Q/A</Btn>
            <Btn onClick={onRerunScan} variant="default" disabled={rerunInProgress}>{rerunInProgress ? 'Re-running...' : 'Re-run scan now'}</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

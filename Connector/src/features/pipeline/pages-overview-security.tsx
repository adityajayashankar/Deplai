import React, { useState } from 'react';
import { SAST_FINDINGS, SCA_FINDINGS, STAGES } from './data';
import { Header, SeverityBadge, StageIcon, Stat, Tag } from './ui';
import type { RuntimeScanResults, Stage } from './types';

interface OverviewPageProps {
  setCurrent: (v: string) => void;
  stages?: Stage[];
  projectLabel?: string;
  monthlyCostUsd?: number | null;
  budgetCapUsd?: number | null;
  scanStatus?: string;
  scanResults?: RuntimeScanResults | null;
  healthOverall?: string;
  runtimeMessages?: Array<{ type: string; content: string; timestamp?: string }>;
  scanRuntimeState?: string;
  remediationRuntimeState?: string;
}

export function OverviewPage({
  setCurrent,
  stages = STAGES,
  projectLabel = 'myapp-backend',
  monthlyCostUsd = null,
  budgetCapUsd = null,
  scanStatus,
  scanResults,
  healthOverall,
  runtimeMessages = [],
  scanRuntimeState = 'idle',
  remediationRuntimeState = 'idle',
}: OverviewPageProps) {
  const done = stages.filter((s) => s.status === 'success').length;
  const codeFindings = scanResults?.code_security || [];
  const scaFindings = scanResults?.supply_chain || [];
  const totalFindings = codeFindings.reduce((sum, finding) => sum + (finding.count || 0), 0) + scaFindings.length;
  const hasLiveCost = Number.isFinite(monthlyCostUsd);
  const resolvedMonthlyCost = hasLiveCost ? Number(monthlyCostUsd) : 0;
  const resolvedBudgetCap = Number.isFinite(budgetCapUsd) && Number(budgetCapUsd) > 0 ? Number(budgetCapUsd) : 100;
  const costSubtext = hasLiveCost
    ? resolvedMonthlyCost <= resolvedBudgetCap
      ? `Within $${resolvedBudgetCap.toFixed(0)} cap`
      : `Over $${resolvedBudgetCap.toFixed(0)} cap`
    : 'No estimate yet';
  const badgeText = scanStatus === 'running'
    ? 'Pipeline active - scanning now'
    : scanStatus === 'found'
      ? 'Pipeline active - findings detected'
      : scanStatus === 'error'
        ? 'Pipeline degraded - scan backend unavailable'
      : healthOverall === 'down'
        ? 'Pipeline degraded - service unavailable'
        : 'Pipeline active';

  return (
    <div className="flex-1 overflow-y-auto fade-in custom-scrollbar">
      <Header
        title="Pipeline Overview"
        subtitle={`${projectLabel} - eu-north-1 - Live status from runtime APIs`}
        badge={{
          text: badgeText,
          cls: scanStatus === 'running'
            ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
            : scanStatus === 'found'
              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
              : scanStatus === 'error'
                ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
        }}
      />
      <div className="p-7 space-y-5">
        <div className="grid grid-cols-4 gap-4">
          <Stat label="Stages Complete" value={`${done}/${stages.length}`} color="text-cyan-400" sub="Pipeline progress" />
          <Stat label="Vulnerabilities Found" value={totalFindings} color="text-emerald-400" sub="Code + supply chain" />
          <Stat
            label="Monthly Cost"
            value={hasLiveCost ? `$${resolvedMonthlyCost.toFixed(2)}` : '--'}
            color="text-zinc-200"
            sub={costSubtext}
          />
          <Stat label="Cycle" value="1 / 2" color="text-indigo-400" sub="Remediation loops" />
        </div>
        <div className="grid grid-cols-3 gap-5">
          <div className="col-span-2 bg-zinc-900 rounded-2xl border border-white/5 overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
              <p className="text-sm font-semibold text-zinc-200">Stage progress</p>
              <div className="flex gap-2">{[{ l: 'Completed', c: 'bg-emerald-500' }, { l: 'Active', c: 'bg-amber-400' }, { l: 'Pending', c: 'bg-zinc-700' }].map((l, i) => <div key={i} className="flex items-center gap-1.5 text-[11px] text-zinc-500"><span className={`w-2 h-2 rounded-full ${l.c}`} />{l.l}</div>)}</div>
            </div>
            <div className="p-5 grid grid-cols-2 gap-2">
              {stages.map((s) => (
                <button key={s.key} onClick={() => setCurrent(s.key)} className={`flex items-center gap-2.5 p-3 rounded-xl border transition-all text-left hover:scale-[1.01] ${s.status === 'success' ? 'bg-emerald-500/5 border-emerald-500/15' : s.status === 'active' ? 'bg-amber-500/5 border-amber-500/20' : s.status === 'running' ? 'bg-cyan-500/5 border-cyan-500/20' : 'border-white/4 hover:border-white/10'}`}>
                  <StageIcon status={s.status} gate={s.gate} />
                  <div className="flex-1 min-w-0">
                    <p className={`text-[11.5px] font-medium truncate ${s.status === 'success' ? 'text-zinc-300' : s.status === 'active' ? 'text-amber-300' : s.status === 'running' ? 'text-cyan-300' : 'text-zinc-600'}`}>{s.label}</p>
                    {s.duration && <p className="text-[10px] text-zinc-600 font-mono">{s.duration}</p>}
                  </div>
                  <span className="text-[10px] text-zinc-700 font-mono">{s.id}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="bg-zinc-900 rounded-2xl border border-white/5 overflow-hidden flex flex-col">
            <div className="px-5 py-3.5 border-b border-white/5 flex items-center justify-between">
              <p className="text-sm font-semibold text-zinc-200">Runtime Stream</p>
              <div className="flex items-center gap-2"><span className={`w-2 h-2 rounded-full ${scanRuntimeState === 'running' || remediationRuntimeState === 'running' ? 'bg-cyan-500 pulse-dot' : 'bg-emerald-500'}`} /><span className="text-[10px] font-mono text-zinc-500 tracking-wider">ws://agentic-layer</span></div>
            </div>
            <div className="p-4 bg-[#0a0a0c] font-mono text-[11px] flex-1 overflow-y-auto space-y-1.5 shadow-inner min-h-[300px] custom-scrollbar">
              <div className="text-zinc-500">Connecting to pipeline services via WebSocket...</div>
              <div className={healthOverall === 'down' ? 'text-red-400' : 'text-emerald-400'}>Health: {healthOverall || 'unknown'}</div>
              <div className="text-cyan-400 mt-2">[scan] status={scanStatus || 'not_initiated'}</div>
              <div className="text-zinc-500">[scan-ws] state={scanRuntimeState}</div>
              <div className="text-zinc-500">[remediate-ws] state={remediationRuntimeState}</div>
              <div className="text-zinc-500">[scan] code findings={codeFindings.length}</div>
              <div className="text-zinc-500">[scan] supply chain findings={scaFindings.length}</div>
              <div className="text-zinc-500">[pipeline] completed stages={done}/{stages.length}</div>
              <div className="text-zinc-500 mt-2">[stream] messages={runtimeMessages.length}</div>
              <div className="mt-2 border-t border-white/5 pt-2 space-y-1">
                {runtimeMessages.length === 0 && <div className="text-zinc-600">No runtime events yet.</div>}
                {runtimeMessages.map((msg, idx) => (
                  <div key={`${msg.timestamp || idx}-${idx}`} className={msg.type === 'error' ? 'text-red-400' : msg.type === 'status' || msg.type === 'phase' ? 'text-cyan-400' : 'text-zinc-400'}>
                    <span className="text-zinc-600 mr-1">
                      [{msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '--:--:--'}]
                    </span>
                    {msg.content}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface PreflightCheckItem {
  name: string;
  state: 'healthy' | 'degraded' | 'down';
  detail: string;
}

export function PreflightPage({ checks = [] }: { checks?: PreflightCheckItem[] }) {
  const fallbackChecks: PreflightCheckItem[] = [
    { name: 'agentic_layer', state: 'degraded', detail: 'Waiting for runtime health data' },
  ];
  const items = checks.length > 0 ? checks : fallbackChecks;
  const healthyCount = items.filter((check) => check.state === 'healthy').length;
  const degradedCount = items.filter((check) => check.state === 'degraded').length;
  const downCount = items.filter((check) => check.state === 'down').length;
  const badge = downCount > 0
    ? { text: 'Some dependencies are offline', cls: 'bg-red-500/10 text-red-400 border border-red-500/20' }
    : degradedCount > 0
      ? { text: 'Partial connectivity', cls: 'bg-amber-500/10 text-amber-400 border border-amber-500/20' }
      : { text: 'All connected', cls: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' };

  return (
    <div className="flex-1 overflow-y-auto fade-in custom-scrollbar">
      <Header title="Preflight Checks" subtitle="Live connectivity for runtime dependencies. Pipeline remains runnable even if some checks fail." badge={badge} actions={<Tag color={downCount > 0 ? 'amber' : 'emerald'}>Stage 0 - NON BLOCKING</Tag>} />
      <div className="p-7">
        <div className="grid grid-cols-4 gap-4 mb-7">
          <Stat label="Connected" value={`${healthyCount}/${items.length}`} color="text-emerald-400" />
          <Stat label="Degraded" value={degradedCount} color="text-amber-400" />
          <Stat label="Offline" value={downCount} color="text-red-400" />
          <Stat label="Behavior" value="Run Anyway" color="text-cyan-400" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {items.map((c, i) => (
            <div key={i} className="bg-zinc-900 border border-white/5 rounded-xl p-4 flex items-start gap-3 hover:border-white/10 transition-colors">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${c.state === 'healthy' ? 'bg-emerald-500/10 border border-emerald-500/20' : c.state === 'degraded' ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
                {c.state === 'healthy' && <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>}
                {c.state === 'degraded' && <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>}
                {c.state === 'down' && <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-zinc-200">{c.name}</p>
                  <span className={`text-[10px] font-mono flex-shrink-0 ${c.state === 'healthy' ? 'text-emerald-400' : c.state === 'degraded' ? 'text-amber-400' : 'text-red-400'}`}>{c.state}</span>
                </div>
                <p className="text-[11px] text-zinc-500 mt-0.5">{c.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface ScanPageProps {
  scanResults?: RuntimeScanResults | null;
  scanStatus?: string;
}

export function ScanPage({ scanResults, scanStatus }: ScanPageProps) {
  const [tab, setTab] = useState<string>('sast');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const runtimeSast = (scanResults?.code_security || []).map((finding) => ({
    id: finding.cwe_id,
    title: finding.title,
    severity: finding.severity,
    count: finding.count,
    file: finding.occurrences?.[0]?.filename || 'n/a',
    line: finding.occurrences?.[0]?.line_number || 0,
    desc: `${finding.count} occurrence(s) detected by runtime scan.`,
  }));
  const runtimeSca = (scanResults?.supply_chain || []).map((finding) => ({
    cve: finding.cve_id,
    pkg: finding.name,
    ver: finding.version,
    fixed: finding.fix_version || 'unavailable',
    severity: finding.severity,
    epss: finding.epss_score?.toFixed(2) || '0.00',
    desc: 'Runtime dependency finding.',
  }));

  const hasRuntimePayload = Array.isArray(scanResults?.code_security) || Array.isArray(scanResults?.supply_chain);
  const shouldUseStaticFallback = !hasRuntimePayload && (!scanStatus || scanStatus === 'not_initiated');
  const sastFindings = shouldUseStaticFallback ? SAST_FINDINGS : runtimeSast;
  const scaFindings = shouldUseStaticFallback ? SCA_FINDINGS : runtimeSca;
  const critical = sastFindings.filter((f) => f.severity === 'critical').length;
  const high = sastFindings.filter((f) => f.severity === 'high').length;

  return (
    <div className="flex-1 overflow-y-auto fade-in custom-scrollbar">
      <Header title="Security Scan Results" subtitle="SAST (Bearer) and SCA (Grype) findings from the latest runtime payload." badge={{ text: scanStatus === 'running' ? 'Scan running' : scanStatus === 'found' ? 'Scan completed - vulnerabilities found' : scanStatus === 'error' ? 'Scan backend unreachable' : 'Scan ready', cls: scanStatus === 'running' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' : scanStatus === 'found' ? 'bg-red-500/10 text-red-400 border border-red-500/20' : scanStatus === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20' }} actions={<><Tag color="zinc">{scanStatus || 'not_initiated'}</Tag><Tag color="red">Stage 1 - SCAN</Tag></>} />
      <div className="p-7">
        <div className="grid grid-cols-5 gap-4 mb-6">
          <Stat label="Critical" value={critical} color="text-red-400" sub="Require immediate fix" />
          <Stat label="High" value={high} color="text-orange-400" sub="Fix before merge" />
          <Stat label="Medium" value={sastFindings.filter((f) => f.severity === 'medium').length} color="text-yellow-400" sub="Review recommended" />
          <Stat label="Supply Chain CVEs" value={scaFindings.length} color="text-purple-400" sub="Dependencies" />
          <Stat label="Auto-fixable" value="6" color="text-cyan-400" sub="With AI remediation" />
        </div>
        <div className="bg-zinc-900 rounded-xl border border-white/5 overflow-hidden">
          <div className="flex border-b border-white/5">
            {[{ k: 'sast', label: 'SAST - Code Security', count: sastFindings.length }, { k: 'sca', label: 'SCA - Supply Chain', count: scaFindings.length }].map((t) => (
              <button key={t.k} onClick={() => setTab(t.k)} className={`flex items-center gap-2 px-5 py-3.5 text-sm font-medium border-b-2 transition-colors ${tab === t.k ? 'border-cyan-500 text-cyan-300 bg-cyan-500/5' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
                {t.label}
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${tab === t.k ? 'bg-cyan-500/20 text-cyan-300' : 'bg-zinc-800 text-zinc-500'}`}>{t.count}</span>
              </button>
            ))}
          </div>

          {tab === 'sast' && (
            <div>
              {sastFindings.length === 0 && (
                <div className="px-5 py-8 text-sm text-zinc-500">No code security findings in the latest scan.</div>
              )}
              {sastFindings.map((f, i) => (
                <div key={i} className="border-b border-white/4 last:border-0">
                  <div onClick={() => setExpandedRow(expandedRow === i ? null : i)} className="flex items-center gap-4 px-5 py-3.5 cursor-pointer hover:bg-white/3 transition-colors group">
                    <svg className={`w-4 h-4 text-zinc-600 flex-shrink-0 transition-transform ${expandedRow === i ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    <SeverityBadge s={f.severity} />
                    <span className="text-[11px] font-mono text-zinc-500 w-24 flex-shrink-0">{f.id}</span>
                    <span className="text-sm font-medium text-zinc-200 flex-1">{f.title}</span>
                    <span className="text-[11px] font-mono text-zinc-500">{f.file}:{f.line}</span>
                    <span className="text-[11px] bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded font-mono">{f.count} hit{f.count > 1 ? 's' : ''}</span>
                  </div>
                  {expandedRow === i && (
                    <div className="px-5 pb-4 pt-2 bg-zinc-950/50">
                      <p className="text-sm text-zinc-300">{f.desc}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'sca' && (
            <div className="overflow-x-auto custom-scrollbar">
              {scaFindings.length === 0 && (
                <div className="px-5 py-8 text-sm text-zinc-500">No supply-chain vulnerabilities in the latest scan.</div>
              )}
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/5">{['CVE', 'Package', 'Version', 'Fixed In', 'Severity', 'EPSS'].map((h) => <th key={h} className="text-left px-5 py-3 text-[11px] uppercase tracking-wider text-zinc-500 font-semibold whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {scaFindings.map((f, i) => (
                    <tr key={i} className="border-b border-white/4 last:border-0 hover:bg-white/3 group">
                      <td className="px-5 py-3.5 font-mono text-[11px] text-amber-400">{f.cve}</td>
                      <td className="px-5 py-3.5 font-medium text-zinc-200">{f.pkg}</td>
                      <td className="px-5 py-3.5 font-mono text-[11px] text-zinc-500">{f.ver}</td>
                      <td className="px-5 py-3.5 font-mono text-[11px] text-emerald-400">{f.fixed}</td>
                      <td className="px-5 py-3.5"><SeverityBadge s={f.severity} /></td>
                      <td className="px-5 py-3.5"><div className="flex items-center gap-2"><div className="h-1.5 w-16 bg-zinc-800 rounded-full overflow-hidden"><div className="h-full bg-red-500 rounded-full" style={{ width: `${Math.min(parseFloat(f.epss || '0') * 100, 100)}%` }} /></div><span className="text-[11px] font-mono text-zinc-500">{f.epss}</span></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

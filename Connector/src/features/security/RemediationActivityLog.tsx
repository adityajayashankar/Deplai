'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { describeRemediationEvent, remediationLogSummary, type RemediationLogMessage } from './remediation-log';

export function RemediationActivityLog({ messages, active }: { messages: RemediationLogMessage[]; active: boolean }) {
  const [filter, setFilter] = useState('key');
  const [follow, setFollow] = useState(true);
  const [now, setNow] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { setNow(Date.now()); if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active, messages.length]);
  useEffect(() => { if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages.length, follow, filter]);
  const summary = useMemo(() => remediationLogSummary(messages), [messages]);
  const events = useMemo(() => messages.filter(m => m.type !== 'changed_files').map((message, index) => ({ ...describeRemediationEvent(message), timestamp: message.timestamp, index })), [messages]);
  const shown = events.filter(e => filter === 'all' || (filter === 'issues' ? ['warning', 'error'].includes(e.tone) : !e.detailOnly));
  const lastTime = Date.parse(messages.at(-1)?.timestamp || '');
  const age = now !== null && Number.isFinite(lastTime) ? Math.max(0, Math.floor((now - lastTime) / 1000)) : null;
  const ageText = age === null ? 'No events received yet' : age < 60 ? `${age}s since last event` : `${Math.floor(age / 60)}m ${age % 60}s since last event`;
  const copy = async () => { try { await navigator.clipboard.writeText(messages.filter(m => m.type !== 'changed_files').map(m => `${m.timestamp} [${m.type}] ${m.content}`).join('\n')); setCopyStatus('Copied'); } catch { setCopyStatus('Copy unavailable'); } };
  return <section className="min-w-0 border-[3px] border-black bg-white text-black" aria-label="Remediation activity">
    <div className="border-b-[3px] border-black p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Remediation activity</h3><span className="text-xs text-zinc-600">{active ? ageText : 'Saved activity'}</span></div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
        <div><span className="block text-zinc-500">Packet</span><strong>{summary.packet === null ? 'Not reported yet' : `${summary.packet} / ${summary.total}`}</strong></div>
        <div><span className="block text-zinc-500">Patches ready for review</span><strong>{summary.patches}</strong></div>
        <div><span className="block text-zinc-500">Packets without a safe patch</span><strong>{summary.rejectedPackets}</strong></div>
      </div>
      <p className="mt-3 text-xs text-zinc-600">Local checks do not confirm a vulnerability is fixed. Security verification is still required.</p>
      {active && age !== null && age >= 60 && <p className="mt-3 border-l-2 border-amber-600 pl-3 text-xs text-amber-900" role="status">No new event has arrived for {Math.floor(age / 60)} minute(s). The worker may be waiting for a model or the connection may be interrupted. This is not confirmation of progress or failure.</p>}
    </div>
    <div className="flex flex-wrap items-center gap-3 border-b border-black p-3 text-xs">
      <label>Show <select aria-label="Filter activity" value={filter} onChange={e => setFilter(e.target.value)} className="ml-1 border border-black bg-white p-1"><option value="key">Key events</option><option value="issues">Warnings and errors</option><option value="all">All details</option></select></label>
      <label className="flex items-center gap-1"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />Auto-scroll</label>
      <button type="button" onClick={copy} className="ml-auto border border-black px-2 py-1">Copy log</button><span role="status">{copyStatus}</span>
    </div>
    <div ref={scroll} onScroll={() => { const el = scroll.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 48) setFollow(false); }} className="custom-scrollbar max-h-[480px] overflow-y-auto p-4">
      {!shown.length && <p className="text-sm text-zinc-500">{events.length ? 'No events match this filter.' : 'Waiting for the first event.'}</p>}
      {shown.map(event => <article key={`${event.timestamp}-${event.index}`} className="mb-4 border-b border-zinc-200 pb-3 last:mb-0">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500"><time dateTime={event.timestamp}>{Number.isFinite(Date.parse(event.timestamp)) ? (now === null ? event.timestamp : new Date(event.timestamp).toLocaleTimeString()) : 'Time unavailable'}</time><span className="uppercase">{event.tone === 'success' ? 'Result' : event.tone}</span></div>
        <p className={`mt-1 whitespace-pre-wrap break-words text-sm leading-6 ${event.tone === 'error' ? 'text-rose-800' : event.tone === 'warning' ? 'text-amber-900' : event.tone === 'success' ? 'text-emerald-800' : 'text-zinc-800'}`}>{event.detailOnly ? 'Technical event' : event.title}</p>
        {(event.title !== event.raw || event.detailOnly) && <details className="mt-1 text-xs text-zinc-600"><summary className="cursor-pointer">Technical details</summary><pre className="mt-2 whitespace-pre-wrap break-words font-mono">{event.raw}</pre></details>}
      </article>)}
    </div>
  </section>;
}

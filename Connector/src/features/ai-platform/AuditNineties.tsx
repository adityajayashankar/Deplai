'use client';

import { useEffect, useMemo, useState } from 'react';
import { aiFetch } from './ui';
import {
  NinetiesBanner,
  NinetiesFrame,
  NinetiesHeader,
  NinetiesMetric,
  NinetiesPanel,
  NinetiesRow,
  NinetiesStat,
  formatWhen,
  ninetiesGhostBtn,
  ninetiesInkBtn,
} from './nineties';

type AuditEvent = {
  id: string;
  actor?: string;
  action: string;
  resource: string;
  result: string;
  metadata_json?: unknown;
  created_at: string | Date;
};

function formatAction(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return { note: value };
    }
  }
  return null;
}

export function AuditNineties({ onOpenCredentials }: { onOpenCredentials: () => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [resultFilter, setResultFilter] = useState<'all' | 'success' | 'failure'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = async () => {
    setError('');
    setLoading(true);
    try {
      const payload = await aiFetch<{ events: AuditEvent[] }>('audit');
      setEvents(payload.events || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load audit log');
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return events.filter((event) => {
      if (resultFilter !== 'all' && event.result !== resultFilter) return false;
      if (!term) return true;
      const haystack = `${event.action} ${event.resource} ${event.actor || ''} ${event.result}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [events, query, resultFilter]);

  useEffect(() => {
    if (selectedId && filtered.some((event) => event.id === selectedId)) return;
    setSelectedId(filtered[0]?.id || null);
  }, [filtered, selectedId]);

  const selected = filtered.find((event) => event.id === selectedId) || null;
  const failures = events.filter((event) => event.result === 'failure').length;
  const metadata = parseMetadata(selected?.metadata_json);
  const metadataEntries = metadata ? Object.entries(metadata).slice(0, 12) : [];

  return (
    <NinetiesFrame>
      <NinetiesHeader
        kicker="BYOK · Control plane"
        title="Audit"
        blurb="Credential, routing, and catalog changes for this workspace. Raw API keys are never written here — only the action, resource, actor, and redacted metadata."
        actions={
          <>
            <button type="button" className={ninetiesInkBtn} onClick={() => void load()} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button type="button" className={ninetiesGhostBtn} onClick={onOpenCredentials}>Open credentials</button>
          </>
        }
      />

      {error ? <NinetiesBanner>{error}</NinetiesBanner> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <NinetiesStat label="Events" value={loading ? '…' : String(events.length)} tone="white" />
        <NinetiesStat label="Success" value={loading ? '…' : String(events.length - failures)} tone="lime" />
        <NinetiesStat label="Failure" value={loading ? '…' : String(failures)} tone="magenta" />
        <NinetiesStat label="Showing" value={loading ? '…' : String(filtered.length)} tone="yellow" />
      </div>

      <div className="flex flex-col gap-3 border-8 border-black bg-white p-4 shadow-[12px_12px_0px_0px_#000] sm:flex-row sm:items-center">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter action, resource, actor…"
          className="w-full border-4 border-black bg-[#00ffff] px-3 py-2.5 text-sm font-black text-black placeholder:text-black/50 outline-none"
        />
        <div className="flex gap-2">
          {(['all', 'success', 'failure'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setResultFilter(value)}
              className={`border-4 border-black px-3 py-2 text-xs font-black uppercase shadow-[4px_4px_0px_0px_#000] ${
                resultFilter === value ? 'bg-[#ffff00]' : 'bg-white'
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <NinetiesPanel title="Event log" badge="newest first">
          {loading && events.length === 0 ? (
            <p className="border-4 border-black bg-[#00ffff] px-4 py-6 text-sm font-black">Loading events…</p>
          ) : filtered.length === 0 ? (
            <p className="border-4 border-black bg-[#ffff00] px-4 py-6 text-sm font-black">
              {events.length === 0
                ? 'No audit events yet. Creating, validating, or revoking a BYOK key will show up here. Secrets stay out of the log.'
                : 'No events match this filter.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {filtered.map((event) => (
                <li key={event.id}>
                  <NinetiesRow active={event.id === selected?.id} onClick={() => setSelectedId(event.id)}>
                    <div className="min-w-0 flex-1">
                      <p className="font-black">{formatAction(event.action)}</p>
                      <p className="mt-1 truncate text-[11px] font-black text-black/70">{event.resource}</p>
                    </div>
                    <span className={`shrink-0 border-2 border-black px-2 py-0.5 text-[11px] font-black uppercase ${
                      event.result === 'failure' ? 'bg-[#ff00ff] text-[#ffffff]' : 'bg-[#00ff00]'
                    }`}>
                      {event.result}
                    </span>
                  </NinetiesRow>
                </li>
              ))}
            </ul>
          )}
        </NinetiesPanel>

        <NinetiesPanel title="Event detail" badge={selected ? formatWhen(selected.created_at) : 'Pick a row'}>
          {selected ? (
            <div>
              <h3 className="font-[family-name:var(--font-space-grotesk)] text-3xl font-black leading-none">
                {formatAction(selected.action)}
              </h3>
              <p className="mt-3 border-4 border-black bg-[#00ffff] p-3 text-sm font-black break-all">
                {selected.resource}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <NinetiesMetric label="Result" value={selected.result} />
                <NinetiesMetric label="Actor" value={selected.actor || 'workspace'} />
              </div>
              <dl className="mt-4 space-y-2 border-t-4 border-black pt-4 text-sm font-black">
                <div className="flex justify-between gap-3">
                  <dt>When</dt>
                  <dd className="text-right">{formatWhen(selected.created_at)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>Event id</dt>
                  <dd className="truncate font-mono text-[11px]">{selected.id}</dd>
                </div>
              </dl>
              <div className="mt-4 border-t-4 border-black pt-4">
                <p className="mb-2 text-[10px] font-black tracking-wider uppercase">Redacted metadata</p>
                {metadataEntries.length === 0 ? (
                  <p className="text-sm font-black">No extra fields. Secret material is stripped before write.</p>
                ) : (
                  <ul className="space-y-2">
                    {metadataEntries.map(([key, value]) => (
                      <li key={key} className="flex justify-between gap-3 text-sm font-black">
                        <span>{key}</span>
                        <span className="max-w-[60%] truncate text-right">{typeof value === 'string' ? value : JSON.stringify(value)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm font-black">Select an event to inspect actor, result, and redacted metadata.</p>
          )}
        </NinetiesPanel>
      </div>
    </NinetiesFrame>
  );
}

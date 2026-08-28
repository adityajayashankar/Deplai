'use client';

import { Fragment, useMemo, useState } from 'react';
import { SeverityBadge } from './SeverityBadge';
import { FindingDetail, correlatedFor } from './FindingDetail';
import { findingRenderKey } from './normalize';
import { FINDING_CATEGORIES, SAVED_FINDING_VIEWS, type FindingCategory, type FindingCorrelation, type UnifiedFinding } from './types';

export function FindingTable({
  findings,
  category,
  onCategoryChange,
  query,
  onQueryChange,
  severity,
  onSeverityChange,
  correlations,
  hideFilters = false,
  expandedId,
  onExpandedIdChange,
}: {
  findings: UnifiedFinding[];
  category: FindingCategory | 'all';
  onCategoryChange: (category: FindingCategory | 'all') => void;
  query: string;
  onQueryChange: (value: string) => void;
  severity: 'all' | 'critical' | 'high' | 'medium' | 'low';
  onSeverityChange: (value: 'all' | 'critical' | 'high' | 'medium' | 'low') => void;
  correlations?: FindingCorrelation[];
  hideFilters?: boolean;
  expandedId?: string | null;
  onExpandedIdChange?: (id: string | null) => void;
}) {
  const [internalExpanded, setInternalExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);
  const openId = expandedId === undefined ? internalExpanded : expandedId;
  const setOpenId = onExpandedIdChange || setInternalExpanded;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return findings.filter((finding) => {
      if (category !== 'all' && finding.category !== category) return false;
      if (severity !== 'all' && String(finding.severity || '').toLowerCase() !== severity) return false;
      if (!needle) return true;
      const haystack = [finding.title, finding.asset, finding.location, finding.category, finding.id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [category, findings, query, severity]);

  const visible = filtered.slice(0, limit);

  return (
    <div className="app-paper overflow-hidden">
      {hideFilters ? null : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4 border-b-[3px] border-black px-6 py-4">
            <div>
              <h3 className="text-base font-semibold text-black">Findings</h3>
              <p className="mt-1 text-xs text-neutral-500">Unified results across code, dependencies, secrets, infrastructure, APIs, and dynamic testing.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {FINDING_CATEGORIES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onCategoryChange(item.id);
                    setLimit(100);
                  }}
                  className={`border-[3px] border-black px-3 py-2 text-xs font-bold transition-transform hover:translate-x-0.5 hover:translate-y-0.5 ${
                    category === item.id ? 'bg-black text-white shadow-none' : 'bg-white text-black shadow-[4px_4px_0_0_#000]'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 border-b-[3px] border-black px-6 py-3">
            {SAVED_FINDING_VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                onClick={() => {
                  onCategoryChange(view.category);
                  onSeverityChange(view.severity);
                  onQueryChange(view.query);
                  setLimit(100);
                }}
                className="border-[2px] border-black px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-black"
              >
                {view.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 border-b-[3px] border-black px-6 py-4 md:grid-cols-[minmax(0,1fr)_180px]">
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search finding, asset, location, CVE..."
              className="w-full rounded-none border-[3px] border-black bg-white px-4 py-2.5 text-sm text-black outline-none"
            />
            <select
              value={severity}
              onChange={(event) => onSeverityChange(event.target.value as typeof severity)}
              className="w-full rounded-none border-[3px] border-black bg-white px-4 py-2.5 text-sm text-black outline-none"
            >
              <option value="all">All severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
        </>
      )}

      <div className="custom-scrollbar max-h-[55vh] overflow-auto">
        <table className="w-full min-w-[840px] border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-white">
            <tr className="border-b-[3px] border-black">
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Severity</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Finding</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Category</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Asset</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Risk</th>
              <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((finding, index) => {
              const open = openId === finding.id;
              return (
                <Fragment key={findingRenderKey(finding, index)}>
                  <tr
                    className="cursor-pointer border-b border-black/20 transition-colors hover:bg-neutral-100"
                    onClick={() => setOpenId(open ? null : finding.id)}
                  >
                    <td className="px-4 py-3"><SeverityBadge severity={finding.severity} /></td>
                    <td className="px-4 py-3 text-black">{finding.title}</td>
                    <td className="px-4 py-3 font-mono text-xs uppercase text-zinc-400">{finding.category}</td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-400">{finding.asset || finding.location}</td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500">{typeof finding.risk === 'number' ? finding.risk : '—'}</td>
                    <td className="px-4 py-3 text-xs capitalize text-zinc-400">{finding.status || 'open'}</td>
                  </tr>
                  {open ? (
                    <tr className="border-b border-black/20 bg-neutral-50">
                      <td colSpan={6} className="px-4 py-4">
                        <FindingDetail
                          finding={finding}
                          correlated={correlatedFor(finding, findings, correlations)}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-500">
                  {category === 'all'
                    ? 'No findings match the current filters.'
                    : `No ${category} findings match the current filters.`}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#1A1A1A] px-6 py-4 text-xs text-zinc-500">
        <div>
          Showing {visible.length} of {filtered.length} findings
        </div>
        {visible.length < filtered.length ? (
          <button
            type="button"
            onClick={() => setLimit((value) => value + 100)}
            className="border-[3px] border-black bg-white px-3 py-2 text-xs font-bold text-black shadow-[4px_4px_0_0_#000] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-none"
          >
            Load 100 More
          </button>
        ) : null}
      </div>
    </div>
  );
}

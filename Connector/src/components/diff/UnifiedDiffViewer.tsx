'use client';

import { useMemo } from 'react';

type DiffLineKind = 'file-old' | 'file-new' | 'hunk' | 'add' | 'remove' | 'context' | 'other';

type ParsedDiffLine = {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
  sign: '+' | '-' | ' ' | '';
};

const HUNK_HEADER = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
  let oldLine = 0;
  let newLine = 0;

  return diff.split('\n').map((raw) => {
    const text = raw;

    if (text.startsWith('---')) {
      return { kind: 'file-old', text, oldLine: null, newLine: null, sign: '' };
    }
    if (text.startsWith('+++')) {
      return { kind: 'file-new', text, oldLine: null, newLine: null, sign: '' };
    }

    const hunk = text.match(HUNK_HEADER);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: 'hunk', text, oldLine: null, newLine: null, sign: '' };
    }

    if (text.startsWith('+')) {
      const line = newLine;
      newLine += 1;
      return { kind: 'add', text: text.slice(1), oldLine: null, newLine: line, sign: '+' };
    }
    if (text.startsWith('-')) {
      const line = oldLine;
      oldLine += 1;
      return { kind: 'remove', text: text.slice(1), oldLine: line, newLine: null, sign: '-' };
    }
    if (text.startsWith(' ')) {
      const o = oldLine;
      const n = newLine;
      oldLine += 1;
      newLine += 1;
      return { kind: 'context', text: text.slice(1), oldLine: o, newLine: n, sign: ' ' };
    }

    return { kind: 'other', text, oldLine: null, newLine: null, sign: '' };
  });
}

function diffStats(diff: string) {
  const lines = diff.split('\n');
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function lineNumber(value: number | null) {
  return value === null ? '' : String(value);
}

function rowClasses(kind: DiffLineKind): string {
  switch (kind) {
    case 'file-old':
    case 'file-new':
      return 'bg-neutral-100 text-neutral-600';
    case 'hunk':
      return 'bg-sky-100/90 text-sky-900 border-y border-sky-200';
    case 'add':
      return 'bg-emerald-50 text-emerald-950';
    case 'remove':
      return 'bg-rose-50 text-rose-950';
    case 'context':
      return 'bg-white text-neutral-800';
    default:
      return 'bg-white text-neutral-700';
  }
}

function signClasses(kind: DiffLineKind): string {
  switch (kind) {
    case 'add':
      return 'text-emerald-700';
    case 'remove':
      return 'text-rose-700';
    case 'context':
      return 'text-neutral-300';
    default:
      return 'text-transparent';
  }
}

export function UnifiedDiffStats({ diff }: { diff: string }) {
  const { additions, deletions } = useMemo(() => diffStats(diff), [diff]);
  if (!additions && !deletions) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 font-mono text-xs">
      {additions > 0 ? (
        <span className="rounded-sm bg-emerald-100 px-1.5 py-0.5 font-semibold text-emerald-800">
          +{additions}
        </span>
      ) : null}
      {deletions > 0 ? (
        <span className="rounded-sm bg-rose-100 px-1.5 py-0.5 font-semibold text-rose-800">
          −{deletions}
        </span>
      ) : null}
    </div>
  );
}

export function UnifiedDiffViewer({
  diff,
  maxHeight = '28rem',
  embedded = false,
  className = '',
}: {
  diff: string;
  maxHeight?: string;
  embedded?: boolean;
  className?: string;
}) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const frame = embedded
    ? 'border border-neutral-200'
    : 'border-[3px] border-black shadow-[4px_4px_0_0_#000]';

  return (
    <div className={`overflow-hidden bg-white font-mono text-[13px] leading-6 ${frame} ${className}`}>
      <div className="overflow-auto" style={{ maxHeight }}>
        <table className="w-full min-w-max border-collapse">
          <tbody>
            {lines.map((line, index) => {
              const isMeta = line.kind === 'file-old' || line.kind === 'file-new' || line.kind === 'hunk' || line.kind === 'other';

              if (isMeta) {
                return (
                  <tr key={`meta-${index}`} className={rowClasses(line.kind)}>
                    <td colSpan={4} className="whitespace-pre px-3 py-1.5">
                      {line.text || ' '}
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={`line-${index}`} className={`group ${rowClasses(line.kind)}`}>
                  <td className="w-10 select-none border-r border-black/10 bg-neutral-50/80 px-2 text-right text-[11px] tabular-nums text-neutral-400">
                    {lineNumber(line.oldLine)}
                  </td>
                  <td className="w-10 select-none border-r border-black/10 bg-neutral-50/80 px-2 text-right text-[11px] tabular-nums text-neutral-400">
                    {lineNumber(line.newLine)}
                  </td>
                  <td className={`w-7 select-none px-1 text-center text-xs font-bold ${signClasses(line.kind)}`}>
                    {line.sign || ' '}
                  </td>
                  <td className="whitespace-pre px-3 py-0">{line.text || ' '}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

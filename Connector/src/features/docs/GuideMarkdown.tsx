'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { headingId, resolveGuideHref } from './guide-links';
import { MermaidBlock } from './MermaidBlock';

type Block =
  | { type: 'h1'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'code'; lang: string; code: string }
  | { type: 'mermaid'; code: string };

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSep(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}/.test(line);
}

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim().toLowerCase();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const code = body.join('\n');
      blocks.push(lang === 'mermaid' ? { type: 'mermaid', code } : { type: 'code', lang, code });
      continue;
    }
    if (trimmed.startsWith('### ')) {
      blocks.push({ type: 'h3', text: trimmed.slice(4) });
      i += 1;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      blocks.push({ type: 'h2', text: trimmed.slice(3) });
      i += 1;
      continue;
    }
    if (trimmed.startsWith('# ')) {
      blocks.push({ type: 'h1', text: trimmed.slice(2) });
      i += 1;
      continue;
    }
    if (trimmed.startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i += 1;
      }
      const filtered = tableLines.filter((row) => !isTableSep(row));
      const headers = filtered[0] ? splitTableRow(filtered[0]) : [];
      const rows = filtered.slice(1).map(splitTableRow);
      if (headers.length) blocks.push({ type: 'table', headers, rows });
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      const nextTrim = next.trim();
      if (!nextTrim) break;
      if (nextTrim.startsWith('#') || nextTrim.startsWith('|') || nextTrim.startsWith('```') || /^[-*]\s+/.test(nextTrim) || /^\d+\.\s+/.test(nextTrim)) break;
      para.push(next);
      i += 1;
    }
    blocks.push({ type: 'p', text: para.join(' ').replace(/\s+/g, ' ').trim() });
  }
  return blocks;
}

function Inline({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<strong key={`b-${key}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={`c-${key}`} className="border-2 border-black bg-neutral-100 px-1 py-0.5 font-mono text-[12px]">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        const href = resolveGuideHref(link[2]);
        const external = /^(https?:|mailto:)/i.test(href);
        nodes.push(
          external ? (
            <a key={`a-${key}`} href={href} target="_blank" rel="noreferrer" className="underline">
              {link[1]}
            </a>
          ) : (
            <Link key={`a-${key}`} href={href} className="underline">
              {link[1]}
            </Link>
          ),
        );
      }
    }
    key += 1;
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

export function GuideMarkdown({ markdown }: { markdown: string }) {
  const blocks = parseBlocks(markdown);
  let skippedTitle = false;
  return (
    <div className="space-y-6 text-[15px] leading-7 text-black">
      {blocks.map((block, index) => {
        if (block.type === 'h1' && !skippedTitle) {
          skippedTitle = true;
          return null;
        }
        if (block.type === 'h1' || block.type === 'h2') {
          return (
            <h2 key={`${block.type}-${index}`} id={headingId(block.text)} className="scroll-mt-8 pt-2 font-display text-2xl font-semibold tracking-tight">
              <Inline text={block.text} />
            </h2>
          );
        }
        if (block.type === 'h3') {
          return (
            <h3 key={`h3-${index}`} id={headingId(block.text)} className="scroll-mt-8 pt-1 text-lg font-semibold">
              <Inline text={block.text} />
            </h3>
          );
        }
        if (block.type === 'p') {
          return (
            <p key={`p-${index}`}>
              <Inline text={block.text} />
            </p>
          );
        }
        if (block.type === 'ul') {
          return (
            <ul key={`ul-${index}`} className="space-y-2 pl-1">
              {block.items.map((item) => (
                <li key={item} className="flex gap-3">
                  <span className="mt-2.5 h-1.5 w-1.5 shrink-0 bg-black" />
                  <span><Inline text={item} /></span>
                </li>
              ))}
            </ul>
          );
        }
        if (block.type === 'ol') {
          return (
            <ol key={`ol-${index}`} className="space-y-3">
              {block.items.map((item, itemIndex) => (
                <li key={`${itemIndex}-${item}`} className="grid grid-cols-[auto_1fr] gap-3">
                  <span className="mt-0.5 flex h-6 w-6 items-center justify-center border-[3px] border-black bg-black font-mono text-[11px] font-bold text-white">
                    {itemIndex + 1}
                  </span>
                  <span><Inline text={item} /></span>
                </li>
              ))}
            </ol>
          );
        }
        if (block.type === 'table') {
          return (
            <div key={`table-${index}`} className="overflow-x-auto border-[3px] border-black">
              <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                <thead>
                  <tr className="bg-black text-white">
                    {block.headers.map((header) => (
                      <th key={header} className="border-b-[3px] border-black px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em]">
                        <Inline text={header} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`${row[0]}-${rowIndex}`} className="odd:bg-white even:bg-neutral-50">
                      {row.map((cell, cellIndex) => (
                        <td key={`${cellIndex}-${cell}`} className={`border-t-2 border-black px-3 py-2.5 align-top ${cellIndex === 0 ? 'font-medium' : 'text-neutral-700'}`}>
                          <Inline text={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === 'mermaid') {
          return <MermaidBlock key={`m-${index}`} chart={block.code} />;
        }
        return (
          <pre key={`code-${index}`} className="overflow-x-auto border-[3px] border-black bg-white p-4 font-mono text-[12px] leading-5">
            {block.code}
          </pre>
        );
      })}
    </div>
  );
}

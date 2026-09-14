import type { uiuxDiff } from './uiux-diff';

export function UiuxDiffView({ diff }: { diff: NonNullable<ReturnType<typeof uiuxDiff>> }) {
  return <div className="font-mono text-xs leading-6">
    <p className="border-b border-black px-5 py-2">+{diff.added} added / −{diff.removed} removed</p>
    {diff.hunks.map((hunk, index) => <section key={index} aria-label={`Changes at old line ${hunk.oldStart}, new line ${hunk.newStart}`}>
      <p className="border-y border-neutral-200 bg-neutral-100 px-5 py-2">@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</p>
      <pre className="min-w-max"><code>{hunk.lines.map((line, i) => <span key={i} className={`block ${line.text.startsWith('+') ? 'bg-emerald-50 text-emerald-950' : line.text.startsWith('-') ? 'bg-rose-50 text-rose-950' : 'text-neutral-600'}`}><span className="inline-block w-12 select-none border-r border-neutral-200 pr-2 text-right text-neutral-500">{line.oldLine}</span><span className="mr-4 inline-block w-12 select-none border-r border-neutral-200 pr-2 text-right text-neutral-500">{line.newLine}</span>{line.text}</span>)}</code></pre>
    </section>)}
  </div>;
}

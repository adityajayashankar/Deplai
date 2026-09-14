'use client';

import React from 'react';
import type { UiuxRun } from './uiux-workspace-types';

export function UiuxPublishActions({ run, github, branch, reviewed, busy, onReview, onApply, onPr }: {
  run: UiuxRun; github: boolean; branch: string; reviewed: boolean; busy: string | null;
  onReview: (value: boolean) => void; onApply: () => void; onPr: () => void;
}) {
  const valid = run.status === 'completed' && !run.conflicts?.length && Boolean(run.changes?.length);
  const published = Boolean(run.applied_commit || run.pr_url);
  const enabled = valid && reviewed && !busy && !published;
  const reason = !valid ? run.conflicts?.[0] || run.error || 'Validation must complete before these changes can be published.'
    : !github ? 'Download the patch to apply changes to this ZIP project.'
    : !published && !reviewed ? 'Review the diffs, then confirm below to enable publishing.' : '';
  const button = 'min-h-10 border-2 border-black px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';
  return <section aria-label="Review and publish changes" className="shrink-0 space-y-3 border-b-2 border-black bg-[#f4efe5] px-4 py-4 sm:px-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-base font-semibold">{published ? 'Changes published' : valid ? 'Your changes are ready to review' : 'Changes need attention'}</h2>
        <p className="mt-1 text-xs text-neutral-600">{run.changes?.length || 0} edited files{github ? ` · Target branch: ${branch}` : ''}</p></div>
      {github && <div className="flex flex-wrap gap-2">
        <button type="button" className={`${button} bg-black text-white`} disabled={!enabled} onClick={onApply}>{busy === 'apply' ? 'Applying…' : run.applied_commit ? 'Applied' : 'Apply changes'}</button>
        {run.pr_url ? <a className={`${button} bg-white`} href={run.pr_url} target="_blank" rel="noreferrer">View PR</a>
          : <button type="button" className={`${button} bg-white`} disabled={!enabled} onClick={onPr}>{busy === 'pr' ? 'Creating PR…' : 'Create PR'}</button>}
      </div>}
    </div>
    {valid && github && !published && <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1 accent-black" checked={reviewed} disabled={Boolean(busy)} onChange={event => onReview(event.target.checked)} />I reviewed these changes. Apply commits directly to the selected branch; Create PR opens a separate review branch.</label>}
    {reason && <p role="status" className="text-xs leading-5">{reason}</p>}
    {run.applied_commit && <p className="text-xs">Committed to {branch} at {run.applied_commit.slice(0, 7)}.</p>}
  </section>;
}

import { validatePresentationChanges } from './presentation-policy';
import type { Snapshot } from './snapshots';
import type { UiuxRun } from '@/features/customization/uiux-workspace-types';

export function verifyProposal(snapshot: Snapshot, run: UiuxRun): UiuxRun {
  if (run.status !== 'completed') return run;
  const originals = new Map(snapshot.files.map(file => [file.path, file.content]));
  const conflicts: string[] = [];
  if (run.source_sha !== snapshot.source_sha) conflicts.push('The worker returned a different source commit.');
  if (!Array.isArray(run.changes) || !run.changes.length) conflicts.push('No presentation changes were produced.');
  for (const change of run.changes || []) {
    if (!change || typeof change.path !== 'string' || typeof change.before !== 'string' || typeof change.after !== 'string' || originals.get(change.path) !== change.before) conflicts.push('A proposed file does not match its trusted source snapshot.');
  }
  if (!conflicts.length) {
    const validation = validatePresentationChanges(run.changes);
    conflicts.push(...validation.conflicts);
    run = { ...run, warnings: [...new Set([...(run.warnings || []), ...validation.warnings])] };
  }
  return conflicts.length ? { ...run, status: 'blocked', conflicts, error: 'The proposed changes require manual review and cannot be published.' } : run;
}

/** Full-file unified hunks preserve exact content, including missing final newlines. */
export function proposalPatch(run: UiuxRun): string {
  return run.changes.map(({ path, before, after }) => {
    const lines = (value: string) => value ? value.replace(/\n$/, '').split('\n') : [];
    const oldLines = lines(before), newLines = lines(after);
    const body = (value: string, prefix: string) => lines(value).map(line => prefix + line).join('\n') + (value ? '\n' + (value.endsWith('\n') ? '' : '\\ No newline at end of file\n') : '');
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n${body(before, '-')}${body(after, '+')}`;
  }).join('');
}

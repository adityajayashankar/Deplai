import { structuredPatch } from 'diff';

export function uiuxDiff(path: string, before: string, after: string) {
  const patch = structuredPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3, timeout: 100 });
  if (!patch) return null;
  let added = 0, removed = 0;
  const hunks = patch.hunks.map(hunk => {
    let oldLine = hunk.oldStart, newLine = hunk.newStart;
    const lines = hunk.lines.map(text => {
      const kind = text[0];
      if (kind === '+') added++;
      if (kind === '-') removed++;
      return { text, oldLine: kind === '+' || kind === '\\' ? null : oldLine++, newLine: kind === '-' || kind === '\\' ? null : newLine++ };
    });
    return { ...hunk, lines };
  });
  return { hunks, added, removed };
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uiuxDiff } from './uiux-diff';

test('separated edits retain unchanged lines and correct line numbers', () => {
  const lines = Array.from({length: 30}, (_, i) => `line ${i + 1}`);
  const changed = [...lines]; changed[1] = 'updated two'; changed[25] = 'updated twenty-six';
  const diff = uiuxDiff('page.tsx', lines.join('\n'), changed.join('\n'))!;
  assert.equal(diff.hunks.length, 2);
  assert.equal(diff.added, 2); assert.equal(diff.removed, 2);
  assert.equal(diff.hunks[1].lines.find(line => line.text === '+updated twenty-six')?.newLine, 26);
});

test('insertion and missing final newline are represented', () => {
  const diff = uiuxDiff('style.css', 'a\nb\n', 'a\nx\nb')!;
  assert.ok(diff.hunks.flatMap(h => h.lines).some(line => line.text === '\\ No newline at end of file'));
  assert.equal(diff.hunks[0].lines.find(line => line.text === '+x')?.oldLine, null);
});

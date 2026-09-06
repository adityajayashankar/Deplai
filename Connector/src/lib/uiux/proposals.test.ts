import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyProposal, proposalPatch } from './proposals';
import type { Snapshot } from './snapshots';
import type { UiuxRun } from '@/features/customization/uiux-workspace-types';
import { validatePresentationChanges } from './presentation-policy';

const snapshot: Snapshot = { project: { id: 'project', name: 'Demo', type: 'local' }, source_sha: 'a'.repeat(40), warnings: [], files: [{ path: 'src/App.tsx', content: 'export default function App(){return <button onClick={save}>Save</button>}' }] };
function proposal(): UiuxRun {
  return { run_id: 'b'.repeat(32), status: 'completed', source_sha: snapshot.source_sha, events: [], changes: [{ path: snapshot.files[0].path, before: snapshot.files[0].content, after: snapshot.files[0].content.replace('<button ', '<button className="rounded-lg" ') }] };
}
test('accepts a styling proposal against the trusted source; rejects forged baseline and commit', () => {
  assert.equal(verifyProposal(snapshot, proposal()).status, 'completed');
  const forged = proposal(); forged.changes[0].before = 'invented';
  assert.equal(verifyProposal(snapshot, forged).status, 'blocked');
  assert.equal(verifyProposal(snapshot, { ...proposal(), source_sha: 'c'.repeat(40) }).status, 'blocked');
  assert.equal(verifyProposal(snapshot, { ...proposal(), changes: [] }).status, 'blocked');
});
test('patch preserves missing final newlines', () => {
  const patch = proposalPatch(proposal());
  assert.equal(patch.match(/\\ No newline at end of file/g)?.length, 2);
  assert.match(patch, /@@ -1,1 \+1,1 @@/);
});
test('preserves existing CSS framework imports while rejecting changed imports', () => {
  const before = '@import "tailwindcss";\n.card { color: red; }';
  assert.equal(validatePresentationChanges([{ path: 'src/global.css', before, after: before.replace('red', 'blue') }]).ok, true);
  assert.equal(validatePresentationChanges([{ path: 'src/global.css', before, after: before.replace('tailwindcss', 'https://evil.example/style.css') }]).ok, false);
});

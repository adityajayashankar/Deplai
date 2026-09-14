import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { UiuxPublishActions } from './UiuxPublishActions';
import type { UiuxRun } from './uiux-workspace-types';

function render(status: UiuxRun['status'], reviewed: boolean, extra: Partial<UiuxRun> = {}) {
  const run = { run_id: 'test', status, changes: [{ path: 'a.css', before: '', after: '' }], ...extra } as UiuxRun;
  return renderToStaticMarkup(<UiuxPublishActions run={run} github branch="main" reviewed={reviewed} busy={null} onReview={() => {}} onApply={() => {}} onPr={() => {}} />);
}
test('completed proposals expose both actions but require review', () => {
  const waiting = render('completed', false);
  assert.match(waiting, /Apply changes/);
  assert.match(waiting, /Create PR/);
  assert.equal((waiting.match(/<button[^>]* disabled=""/g) || []).length, 2);
  assert.equal((render('completed', true).match(/<button[^>]* disabled=""/g) || []).length, 0);
});
test('blocked proposals explain failure without enabling publication', () => {
  const blocked = render('blocked', true, { conflicts: ['Protected logic changed'] });
  assert.match(blocked, /Protected logic changed/);
  assert.equal((blocked.match(/<button[^>]* disabled=""/g) || []).length, 2);
});
test('published proposals cannot be submitted again', () => {
  const applied = render('completed', true, { applied_commit: '123456789' });
  assert.equal((applied.match(/<button[^>]* disabled=""/g) || []).length, 2);
  assert.match(render('completed', true, { pr_url: 'https://github.com/example/repo/pull/1' }), /View PR/);
});

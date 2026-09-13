import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRemediationEvent, remediationLogSummary } from './remediation-log';
const entry = (content: string, type = 'info') => ({ content, type, timestamp: '2026-09-11T00:00:00Z' });
test('patch acceptance does not claim a vulnerability is verified fixed', () => {
  const event = describeRemediationEvent(entry('Local reviewer: ACCEPT (100/100) - Deterministic local review passed.', 'success'));
  assert.match(event.title, /verification is still pending/);
});
test('rejections retain actionable reasons and complete original evidence', () => {
  const message = entry('Local reviewer: REJECT (0/100) - Deterministic local review failed: SEARCH block must match exactly once (matched 0)', 'warning');
  const event = describeRemediationEvent(message);
  assert.match(event.title, /matched 0/);
  assert.equal(event.raw, message.content);
  assert.equal(event.tone, 'warning');
});
test('replayed batch results do not inflate accepted patch counts', () => {
  const messages = [entry('Packet 3/35: Master'), entry('Supervisor batch 1: no safe patches produced'), entry('Supervisor batch 2: 1 patch(es) ready'), entry('Supervisor batch 2: 1 patch(es) ready')];
  assert.deepEqual(remediationLogSummary(messages), {packet:3,total:35,reviewed:2,patches:1,rejectedPackets:1});
});
test('missing history is not presented as completed progress', () => {
  assert.deepEqual(remediationLogSummary([]), {packet:null,total:null,reviewed:0,patches:0,rejectedPackets:0});
});
test('technical output is available without becoming the default activity text', () => {
  assert.equal(describeRemediationEvent(entry('{"usage":{}}', 'model_result')).detailOnly, true);
  assert.match(describeRemediationEvent(entry('workflow_implementor: model request 2/12 started')).title, /Writing patch: model request 2 started/);
});

test('round completion explains the review step rather than claiming fixes', () => {
  const result = describeRemediationEvent(entry('Round 1 complete: 30 auto, 0 needs review.', 'success'));
  assert.match(result.title, /Open Review/);
  assert.match(result.title, /not verified fixes/);
  assert.equal(result.tone, 'info');
});
